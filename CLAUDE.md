# Working on Tailfin

Shared instructions for coding agents, including Claude Code and Codex.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers how the code is written — the four invariants,
the package graph, the commands. This file covers how the project is **operated**, which is
the part that is not visible from the code and where the expensive mistakes have actually
been made.

Everything here was learned by getting it wrong at least once.

---

## The rules that are not negotiable

**Never run the database-backed tests against dev or production.** They are destructive by
design: they create and delete players, and one of them arranges for there to be exactly
one admin in order to prove the last one cannot be revoked. This was run once against the
dev box — by sourcing that box's `.env` for a real `DATABASE_URL` — and it revoked a real
person's admin access. `packages/server/src/test-setup.ts` now refuses any database whose
name does not end in `_test` or `_ci`, but do not rely on the guard to remember the rule
for you. Run them in CI.

**A player airline in a database test is founded, never inserted.** Use
`createFoundedAirlineFixtureHarness` from `packages/server/src/test-fixtures/founded-airline.ts`.
It creates an open world, owner, founder hub, unique per-world codes and the configured opening
AIR-06 cash movement through `foundAirline`; existing worlds, players and hubs can be supplied
for multi-airline scenarios. Call the harness's `cleanup()` before suite-specific cleanup. It
deletes only the identities it created, so do not replace it with a truncate or a direct
`insert(airline)` that recreates the impossible zero-cash state AIR-11 removed.

**Restore rehearsals have one destructive target: a database ending in `_test`.** Use
`/usr/local/sbin/tailfin-restore-rehearsal`; it refuses every other name, refuses an existing
target, downloads only from DreamObjects, and repeats the suffix check at `dropdb`. Do not
turn its source object prefix into a live database connection. Record the measured output as
the evidence; `/healthz` alone proves only that Postgres answered, not that the restore works.

**The economy is a database row, not a constant.** Since M3-11 every balance number —
App. A's β coefficients, the gravity model, cost tables, fuel price, boost ceilings —
lives in one `EconomyConfig` payload, versioned in `economy_config`, pinned per world by
`world.economy_config_version`. `packages/sim` holds **no balance literal**; its
`DEFAULT_*` exports are slices of the shipped seed. Retuning is an `INSERT` of a new
version plus an audited re-pin — rows are immutable and the triggers enforce it, so
rollback is re-pinning and nothing can edit the numbers an old `flight_result` was billed
under. The web node seeds the shipped payload at startup and **never updates it**: a
deploy must not be able to revert a live retune. If a `v1` in the database stops matching
the one the build ships, startup says so and leaves the database's version in force.

**Every new migration declares expand or contract.** After `0019_large_hellfire_club`, the
first lines need `-- tailfin:migration-strategy expand` or
`-- tailfin:migration-strategy contract-safe-after #<issue>`. The previous release must keep
working against the result; the deploy deliberately leaves it serving when migration fails.
Do not add down-migrations or bypass the policy for `CREATE INDEX CONCURRENTLY`—ADR-0016 owns
the transaction, lock and recovery trade.

**An aircraft that has not flown does not appear.** M4-02 gates the catalogue on the
world's own clock, and §7.2b's rule is stronger than hiding: a type before its first flight
is absent from `/api/fleet/catalogue` entirely, so a 1950s world lists nothing rather than
eighteen locked rows. A type in its prototype window _is_ listed, with the date it enters
service. Restrictions are a **charge**, never a removal — a restricted type keeps flying and
costs more, and only `out_of_service` makes it illegal. The dates are the catalogue's; the
rates are the economy's, so a world can make old aircraft dearer without re-issuing its
catalogue.

**Aircraft acquisition has two clocks and one owner.** `POST /api/fleet/acquisitions`
atomically writes the pinned commercial/build snapshot and its AIR-06 movement. Lease and
used paths deliver in that request; used configuration comes only from a locked
`used_aircraft_listing`, never the client. New orders store a wall-clock `delivery_at` — §7.2
explicitly says real weeks — and only the Worker materialises them. Do not turn those dates
into `world_event.fire_at`, which is game time and changes meaning with world speed. The
complete boundary and its current exclusions are in
[`docs/aircraft-acquisition.md`](docs/aircraft-acquisition.md).

**Aircraft runtime assets are generated identities, never hand-written paths.** An M6-11 source
GLB is immutable and enters only through `pnpm assets:intake`; the M6-12 pipeline binds its source,
manifest, optimisation decision and pinned tool versions into one content identity, then revalidates
the derived GLB before updating `assets/aircraft/registry.json`. `pnpm assets:validate` rejects an
orphan GLB or a changed hash. Rollback changes `activeAssetVersions` and retains every exact version,
because published liveries never resolve through `latest`. The full boundary, including budget
exceptions and the separation from VIS object storage/CDN work, is in
[`docs/aircraft-asset-pipeline.md`](docs/aircraft-asset-pipeline.md).

**A world pins two versions, and they are not the same version.** `economy_config_version`
is §22.3's balance payload; `aircraft_catalogue_version` is §22.5's eighteen aircraft, stored
as immutable `aircraft_type` rows keyed by `(catalogue_version, designation)`. Both are seeded
at web startup, insert-if-absent and never updated, and both refuse a version that is not
there rather than falling back. They are separate on purpose: a fare change and an
aerodynamics change must not share a number, or a `flight_result` can no longer say which of
the two explained it. Retuning either is a new version, never an edit.

**A new `EconomyConfig` section must arrive with a default.** Rows in
`economy_config` are immutable and are parsed **on the way out**, against today's schema —
so a required new section makes every payload written before it unparseable, and the
failure is total: a world pinned to that version cannot price a flight, found an airline
or draw a fare floor. M3-12 added `npc` without one and broke dev's economy on the first
read after the deploy. Treat it exactly as the database's expand rule: a section arrives
defaulted, or it is a new _version_ created through the admin API and pinned deliberately.

**A world is not populated until `npc:seed` has run.** Since M3-12 the competition is
real: NPC carriers are rows in `airline` with `kind = 'npc'`, no player, an archetype, and
routes and fares decided by a weekly review the **worker** runs. They obey the same fare
floor, the same economy config and the same demand model as players — there is no NPC cost
table, and `carrier.test.ts` proves it rather than asserting it. The order is
`demand:generate` then `npc:seed <worldId>`; a world with no demand pools gets no carriers.
The admin console's Carriers page is where a decision is explained, and it is the answer to
_"why did a competitor appear in my market?"_.

**Never `git add -A`.** Stage files explicitly, by path. A `.pem` was committed this way
once. `.claude/` and other untracked directories sit in this working tree routinely.

**Never `git checkout --` a file that has uncommitted work in it.** It restores from the
index, so it does not undo an experiment — it destroys everything not yet committed.
Reached for once to revert a deliberate mutation-test edit, on a file holding an
afternoon's unstaged changes; it silently did nothing that time, which was luck rather
than safety. Reverse the edit you made, or commit before you break something on purpose.

**Never print a secret into the transcript.** Not from `.env`, not from a credential
helper, not "just to check it is set". Generate secrets on the box, write them to
root-only files, and tell the user the command to read them.

**`main` is protected.** Pull request required, `typecheck · lint · test`, dependency review
and CodeQL at ADR-0013's thresholds must pass, force pushes and deletions are blocked, and
it applies to admins. So: branch, push the branch, open a PR. A direct push to `main` will
be rejected, and that is working as intended. Required approvals are set to **zero** — the
PR is the gate, not a second person — so you can merge your own once the checks are green.

---

## A merge stages a release; a human promotes production

This is the single most misleading thing about the setup, and the easiest thing to tell the
user wrongly. A green merge establishes the next release candidate on `main`; it is not a
production release.

```
merge to main  →  main updates on GitHub  →  CI runs on main  →  release is staged
```

Production moves **only** when a human runs `./deploy/deploy.sh` on the server. There is no
webhook, no scheduler, no runner. ADR-0003 chose this deliberately: _"running the command
is the approval step"_, and no credential anywhere lets GitHub reach production.

That was revisited in August 2026 and **kept** — see
[OPS-06](https://github.com/simmeh024/tailfinsim/issues/174), which had previously proposed
the opposite. The workflow it settles on is:

```
merged to main  →  CI green  →  dev deploys automatically   (OPS-17, not built)
                                        ↓  reviewed on dev
                            promoted to production, by a human   (OPS-18, not built)
```

So **merge means _staged_, not released**, and `dev build − prod build` is the count of
changes tested but not shipped. Three things argued against automating the last step at that
decision point: deploys run migrations, OPS-05 had no migration-failure strategy yet, and a
failed health check does not roll back. OPS-05 is now resolved by ADR-0016; production
promotion remains manual until a separate decision changes ADR-0003.

The normal release-line invariant is **`dev ≥ prod`**: dev is on the same `main` commit as
production or a later one. A positive gap is staged work awaiting promotion; zero means the
environments are aligned; a negative gap is an operational incident. An explicitly pinned
unmerged branch preview is the one exception—its build is not ordered against `main`, and
`pnpm ops:status` marks it with `*` instead of pretending the numbers are comparable.

The consequence is drift, and it used to be drift nobody could see — in August 2026
production sat 27 commits behind `main` for a day, unnoticed. **`pnpm ops:status` answers
that now** (OPS-02, shipped), from anywhere and without an SSH session. Run it before
telling the user where anything is.

**Do not say "deployed" when you mean "merged".**

**Application deploys do not update Caddy.** `deploy.sh` and `deploy-dev.sh` restart Fastify;
they do not copy `/srv/tailfin/deploy/Caddyfile` into `/etc/caddy` or reload the edge. For a
security-header change, follow the report-only/enforced sequence in `deploy/README.md` and run
`pnpm security:headers` against both live hosts before saying the policy is active. A green
in-repository Caddy integration test proves the committed config, not the installed one.
The SEC-HARD-05 rollout completed its browser sign-in/avatar check and both public hosts passed
the enforced-policy verifier on 2026-08-22; the report-only procedure remains the rebuild path.

**Session authority rotates when privilege changes.** A real admin grant or revocation deletes
all of the target player's sessions in the same transaction as the grant and audit row. Do not
change that to preserve a convenient cookie: the pre-change token must receive 401. Normal
player sessions default to 30 days, admin sessions to 12 hours, and production refuses a
non-HTTPS `PUBLIC_ORIGIN`; see ADR-0015.

**Logo preview rollback must preserve saved artwork.** `wireAirline` validates persisted
logo JSON against the running build's schema. Unsupported artwork projects as `null` (the
default emblem), never as a broken airline response; the database source remains untouched.
Rebranding with an explicit logo on such a build returns `409 logo_version_unsupported`
before changing identity, cash or audit. Omitting the logo preserves it, including in an
identity-only rebrand's audit. A compatible logo-studio release restores its display and
editing. Do not repair this by clearing saved JSON or weakening the shared write schema.

**Private resources are concealed by resolution, not by a post-query owner check.** ADR-0020
sets the HTTP vocabulary: 401 means no valid session, 403 means a valid identity lacks a safe-
to-disclose permission, and malformed, missing or cross-owner private path ids receive the
endpoint's identical 404 body. Scope the database query by the session-resolved owner. Public
projections are explicit authorization-matrix entries with limited fields; they are not a
reason to weaken the private endpoint behind them.

**Every resource identifier uses the SEC-07 matrix.** Register path, body, query, parent and
active-world-header surfaces in `test-fixtures/resource-id.ts`; use its own, another-player,
absent, wrong-entity and malformed cases in HTTP tests. A refused write must prove the target
and related money/ledger state are unchanged. Classify client-generated tokens and selectors
explicitly rather than pretending they are owned resources, and never treat UUID randomness as
an authorization control.

---

## The two environments, on three nodes

Production and dev **web** share one DreamCompute box, `208.113.129.131`. They use the same
repository and build pipeline but deliberately have different checkouts, deployed revisions,
ports, databases and audiences. Since OPS-09 there is also a second box,
`tailfin-dev-worker-01` (`208.113.129.83`), running the dev **worker** — so "the box" is no
longer an unambiguous phrase, and production still has no worker at all.

**This section is the canonical current operational topology.** `README.md` and
`docs/deploy.md` link here instead of copying the node table; update this section whenever a
node, service, database owner or deploy path changes.

|                   | production                 | dev                            |
| ----------------- | -------------------------- | ------------------------------ |
| URL               | `tailfinsim.com`           | `dev.tailfinsim.com`           |
| the user calls it | **front door**             | **back door**                  |
| checkout          | `/srv/tailfin`             | `/srv/tailfin-dev`             |
| service           | `tailfin`                  | `tailfin-dev`                  |
| port              | 3000                       | 3001                           |
| database          | `tailfin`                  | `tailfin_dev`                  |
| deploy with       | `./deploy/deploy.sh`       | `./deploy/deploy-dev.sh <ref>` |
| accepts           | **only commits on `main`** | **any ref, deliberately**      |
| `WEB_SURFACE`     | unset → **holding page**   | `app` → the real client        |
| access            | public                     | Google sign-in, `noindex`      |

The third node, alongside dev web:

|               | dev worker                                              |
| ------------- | ------------------------------------------------------- |
| host          | `208.113.129.83` — its own VM                           |
| checkout      | `/srv/tailfin-dev-worker`                               |
| service       | `tailfin-dev-worker` (+ `tailfin-db-tunnel`)            |
| entry point   | `dist/worker.js`                                        |
| port          | 3100, **loopback only** — no Caddy vhost, ever          |
| database      | `tailfin_dev` via SSH tunnel on `127.0.0.1:5433`        |
| you log in as | `ubuntu`; the checkout is `tailfin`'s — see below       |
| deploy with   | `./deploy/deploy-dev-worker.sh <ref>`, **as `tailfin`** |
| migrations    | **no** — the web node owns them                         |

**The dev worker is the one box where the login user is not the deploy user.** You reach
it as `ubuntu`, but `/srv/tailfin-dev-worker` and the service belong to `tailfin`, and there
is no `tailfin` login on that box at all. So the deploy has to hop:

```bash
ssh -i ~/.ssh/tailfin2.pem ubuntu@208.113.129.83 \
  'sudo -n -u tailfin -H bash -lc "cd /srv/tailfin-dev-worker && ./deploy/deploy-dev-worker.sh <ref>"'
```

Run it as `ubuntu` and it dies at `==> Fetching` with git's `detected dubious ownership`,
which reads like a broken checkout rather than a wrong user. **Do not take git's suggested
`safe.directory` fix** — it silences the guard by letting `ubuntu` write into a
`tailfin`-owned tree. The web node is not like this: `tailfin` has its own login there, so
`deploy-dev.sh` needs no `sudo`. `deploy/README.md` has the detail.

**Dev is the preview environment and is meant to run unmerged branches.** That is a
standing decision, not an oversight — it is where the user reviews work before merging.

**`WEB_SURFACE` lives in the box's `.env`, not in the code.** Production still serves the
holding page, and promoting the app is that one variable plus a deploy — not a different
build. Never couple deployment to it.

A deploy runs: fetch → `checkout --detach` → install → build → migration preflight → verified
local backup when files are pending → **atomic migrate** → restart → health poll. A migration
failure reports whether the batch rolled back, fully committed or is unknown; every allowed
schema is compatible with the old service left serving. A failed health check does **not** roll
back; the new code is already serving.

---

## What is actually running

Two facts that are not visible from the code and cost time to rediscover.

**The engine's home is the worker, never the web process.** OPS-08 settled that boundary:
`src/worker.ts` is a second entry point from the same
build, driving `createTickLoop` and `drainDueEvents` over every non-archived world. The
boundary is [ADR-0019](docs/adr/0019-web-worker-boundary.md), and it is enforced by lint and
by `engine/boundary.test.ts` rather than by memory — the web process cannot reach the loop.
Do not wire it into `main.ts`; that is now a failing test as well as a bad idea.

**The simulation now runs on dev, and nowhere else.** OPS-09 put
`tailfin-dev-worker.service` on its own node, `tailfin-dev-worker-01` — so a dev world's clock
advances and its queue drains, while **production still has no worker at all**. Do not
generalise a reading from one to the other; the production worker is
[OPS-12](https://github.com/simmeh024/tailfinsim/issues/191).

The same tick now claims due factory aircraft orders by **real** `delivery_at`, per tickable
world, before it drains that world's game-time events. `aircraftDeliveries` and
`aircraftDeliveryErrors` are heartbeat counters; a delivery-only tick is logged rather than
mistaken for an idle one.

**The used aircraft market only exists where a worker does.** M4-05 makes the second-hand
inventory a worker job on the world's **game** clock — a berth is refilled and an expired
listing withdrawn once per game week, so a world at 4× renews twice as often in real time as
one at 2×. Production has no worker, so a production world would generate no listings, refresh
nothing and expire nothing, and `GET /api/fleet/used-market` would answer `200` with an empty
array. **That reads like an empty market rather than like a missing process**, which is the
same trap as "ticks: 0, errors: 0" and worth remembering before telling anyone the market is
broken. `usedListingsCreated`, `usedListingsWithdrawn` and `usedMarketErrors` are the
counters that distinguish the two. `docs/used-aircraft-market.md` has the mechanism.

**Maintenance is the same story, with a sharper edge.** M4-06 makes checks complete and
airframes ground on the worker's tick, so on a production world a booked check would never
finish and nothing would ever be grounded — an aeroplane put into a C-check there stays in it
for ever. `checksCompleted`, `airframesGrounded` and `maintenanceErrors` are the counters.

**Crew type conversions are the same story again (M5-01).** A conversion completes on the
worker's tick, against the world's game clock, so on a production world crew sent to convert
onto a new family would sit in `unavailable` for ever — visible on the Crew page, counted
against the airline, and never coming back. `crewConversionsCompleted` and `crewErrors` are the
counters. The reason it is game time rather than real weeks is that training happens _inside_
the world; §7.2's factory lead time is the one deliberate exception in the fleet.

**And M5-02 makes that failure mode total, not partial.** Crew duty periods open at departure
and close on the worker's tick — `standDownIdleCrew` ends the day for a set nothing dispatched,
`returnRestedCrew` puts the heads back once the rest is served. Without a worker every aeroplane
flies **exactly one duty period and then stops for ever**, with its crew permanently `on_duty`
and the pool unable to staff anything else. Not a degradation: a fleet that flies once.
`crewStoodDown`, `crewRested` and `crewErrors` are the counters. Both sweeps are scoped to one
world, because game time is a per-world quantity and a sweep that is not would measure one
world's rest against another world's clock.

**Crew morale is a third worker story (M5-03).** Morale is a stored state that
eases toward a target, so something has to move it — `reviewCrewMorale`, weekly on
the world's game clock. Without a worker a base sits at `startingMorale` for ever:
no drift, no sickness, no attrition, and §9.2's _delayed bill_ never arrives, so
paying crew badly looks free. `moraleReviews`, `crewResignations` and
`crewSickened` are the counters. `crew_base.morale` is **nullable and means never
reviewed** — not zero, which would mean the crew hate a base on opening day, and
a schema default would have been a balance literal in a migration.

**A ground contract's term is a fourth worker story (M5-06).** §9.3's handler contracts run
for a fixed term, and something has to lapse them: `expireGroundContracts`, on the world's
game clock, flips an `active` contract to `expired` at its `term_end` — which frees the
vendor slot (capacity counts only `active` rows) and drops the airline back to walk-up
handling. Without a worker a term never ends: a contract signed on opening day runs for
ever, its scarce vendor slot never comes free for a competitor, and the _"before it lapses"_
alert never has anything to fire against — which reads as a frozen market rather than a
missing process. `groundContractsExpired` and `groundErrors` are the counters. `term_end` is
**game time** like a `world_event`'s fire time, and **nullable means a legacy contract signed
before terms existed** — it never expires, rather than expiring at the epoch.

**`FLIGHT_DEPART` has a handler as of M5-02, and that was a decision.** `handlers.ts` had said
for two milestones that inventing a departure would be _"the accidental decision ADR-0019's
boundary exists to prevent"_, and that remains true of an accidental one. M5-02's _"legality is
a hard rule at departure"_ needed a departure to be hard at, so `flight/depart.ts` is a
**dispatch gate** and says at length what it deliberately is not. The consequence to know: the
first Worker carrying this build returns every parked `FLIGHT_DEPART` to `pending` and starts
flying them. Dev's queue was empty when it shipped; check `pnpm ops:status` and the queue depth
before assuming that is still true somewhere else.

**And since M4-07 there is a page where all of that is visible at once.** The fleet table
reads its location, utilisation and next check from flights that only the worker produces, so
on a production world every aeroplane sits at its delivery airport at `0.0 h/day` with a check
that never comes due. That is a **whole page** that reads as broken rather than as a missing
process — the same trap as "ticks: 0, errors: 0", and the first thing to rule out before
believing the fleet API is wrong. `docs/fleet-management.md` has the boundary, including the
two things M4-07 deliberately did not build.

**And one thing not to "fix".** `airframe.maintenance_state` is nullable, and a null means
_every tier was last completed at the hours this airframe has now_ — not _at hour zero_. It
looks like a missing default and it is load-bearing: the other reading would make every
airframe delivered before 0030 tens of thousands of hours overdue, and the first tick after the
deploy would ground a live fleet for maintenance nobody had deferred. There is a database test
holding that line; do not "tidy" it into a zero.

The used market's generation is idempotent by unique constraint rather than by a remembered timestamp:
`(world_id, slot_index, generation_index)` is unique and every insert is
`ON CONFLICT DO NOTHING`, so the tick can call it every second and two workers can race
through a handover. Do not add a "last generated" column to make that cheaper — a column
would have to be reset on a world reset (ADR-0005), and forgetting would leave a fresh world
believing its market was already full.

A "ticks: 0, errors: 0" reading still means _nothing has run_ rather than _everything is fine_.
The admin console's health page infers liveness from the queue for exactly that reason, and the
worker's own `/healthz` answers **503 while its process is alive** if the engine is not
ticking — the failure `systemctl is-active` cannot see.

**An event type nobody handles is now paused, not destroyed.** Only `FLIGHT_ARRIVE` has a
handler; `FLIGHT_DEPART` is scheduled by `schedule/store.ts` and `TURNAROUND_COMPLETE` by
nothing yet. Since SCALE-05 `drainDueEvents` marks an event of an unhandled type
`unsupported` rather than `failed` — excluded from the claim so it cannot starve the queue,
nothing attempted, nothing lost — and the first worker booting with the handler returns it to
`pending`. A worker may safely start against a non-empty queue. `engine.unhandledEventTypes`
still says what a build cannot do, and the System Health page says how much is waiting, per
world and per type.

**And since SCALE-06 the deploy refuses to create that situation in the first place.** A
worker deploy runs `node dist/worker.js --handler-preflight` after the migration preflight and
**before the pre-migration backup**; a build with no handler for a type holding `pending` work
is refused, naming the types and counts, with nothing touched and the previous build still
serving. `--handled-event-types` prints the registry's keys from the bundle without starting
the engine or binding a port — which is the whole point, because `/healthz` answers the same
question one tick after the queue has already been drained against the build. History,
already-parked rows and `pending` rows in archived worlds are excluded and reported as
excluded; blocking on those would refuse every deploy forever. Override with
`ALLOW_HANDLER_GAP=1` typed on the command — never defaulted in a wrapper — which is logged to
the journal. A preflight that could not read the queue is **not** overridable.

**The dev worker is a second machine, and it reaches the database through an SSH tunnel.**
There is no private network between the two DreamCompute VMs — they share a public segment with
other tenants — so `tailfin-db-tunnel.service` forwards `127.0.0.1:5433` to the web host's
Postgres rather than opening a listener. Postgres still binds localhost only. The worker's role
`tailfin_worker_dev` is **refused** the production database by `pg_hba.conf`, not merely
pointed away from it. `deploy/README.md` has the runbook and the failure modes.

**Only the web node migrates.** `deploy.sh` takes `RUNS_MIGRATIONS`, and the worker's wrapper
sets it to 0: two nodes reaching the migrator at once would take the second one's pre-migration
backup after the first had started changing the schema. A worker deploy with a pending schema
change is refused and tells you to deploy the web node first.

**The admin console is real and is the place to look first.** `/admin`, for accounts
holding a grant: overview with server-decided alerts, world creation, speed changes, the
open/lock/archive/reset lifecycle, world health, a read-only player browser, linkable
read-only airline support records (identity, standing, current/historical routes and the
paginated AIR-06 cash ledger), and the audit log. Anything it can answer is faster than SSH,
and every mutation it performs is audited in the same transaction as the change. The airline
record deliberately has no cash adjustment path: money still moves only through AIR-06.

OPS-08 and OPS-09 established the process boundary and the dev Worker; OPS-15 made node/build
drift visible. The remaining production split is tracked by
[OPS-10](https://github.com/simmeh024/tailfinsim/issues/189) through
[OPS-16](https://github.com/simmeh024/tailfinsim/issues/195). Read that sequence
before designing anything infrastructural; it already records the two things that bite — the
database has no long-term home in the four-node diagram, and builds happen on the box.

---

## What runs on a pull request

Three workflows, all merge gates for the failures they own. CodeQL is enforced through a
code-scanning ruleset rather than by treating every finding as equal; ADR-0013 records the
measured tuning period, baseline decisions and thresholds.

| Workflow                | Job / check name          | Asks                                                 | Blocks?                         |
| ----------------------- | ------------------------- | ---------------------------------------------------- | ------------------------------- |
| `ci.yml`                | `typecheck · lint · test` | Do builds, tests and the running Caddy policy pass?  | **Yes**                         |
| `dependency-review.yml` | `dependency review`       | Did this PR add a known-vulnerable dependency?       | **High/critical advisories**    |
| `codeql.yml`            | `analyze (…)`             | Does Tailfin's own code contain a dangerous pattern? | **Error or high/critical only** |

They are separate workflows on purpose. CI needs a Postgres service and takes about two
minutes; CodeQL's two analyses finish in 1.05–1.77 minutes; Dependency Review needs no
services, checkout or install and finishes in seconds. Running them in parallel keeps each
failure independent and the merge path equal to the slowest gate rather than their sum.

### Dependency Review (SEC-HARD-03)

Compares the dependency graph of `main` against the graph of the branch and fails on what
the **diff added**. Runtime _and_ development scopes, direct _and_ transitive.

- **Blocks:** high, critical.
- **Does not block:** moderate, low — reported in the run summary only.
- **Comments on the PR only when it fails.** A clean PR gets no comment and no annotation.
- **Overrides are a code change, not a click** — `allow-ghsas` in the workflow, with the
  reason written in the same diff. See CONTRIBUTING.md.

Two things it is _not_. It is not an audit of the existing tree — a package that was
already vulnerable before your branch is invisible to it, by design, because a gate that
fails on pre-existing findings fails every PR equally. And it is not a code scanner: it
reads the GitHub Advisory Database, CodeQL reads the source, and neither finds what the
other finds.

### CodeQL (SEC-HARD-02)

Analyses JavaScript/TypeScript and Actions with `security-extended` on every PR, on pushes
to `main`, and weekly. The active `CodeQL merge protection` ruleset requires its result:

- **Blocks:** standard-severity errors and security findings rated high or critical.
- **Does not block:** warning/note and medium/low findings — they remain visible and need
  triage, but do not turn the scanner into noise.
- **Baseline:** zero open findings after each initial result received an individual reason.
- **Known gap:** CodeQL's canary did not treat Fastify `request.query` as a remote-flow
  source. Boundary validation and the security regression suite cover what scanning cannot.

PR #286 proved the analyser with a critical code-injection canary and was deleted without
merging. Across the tuning window, 47 PR analyses took 1.05–1.77 minutes (median 1.25), in
parallel with CI. The full decision and deferred baseline items are in ADR-0013.

**It works here because the dependency graph parses `pnpm-lock.yaml`.** That was checked
rather than assumed — the SBOM endpoint returns 458 packages at exact versions, so
transitives are covered, not just the manifests. Worth re-checking if the package manager
ever changes.

---

## Conventions

**Branches:** coding-agent branches identify their owner: `codex/<issue-key>-<slug>` for
Codex and `claude/<issue-key>-<slug>` for Claude Code. Human-maintained branches may use
`feat/<issue-key>-<slug>`, `fix/<slug>` or `chore/<slug>`. There is no `develop`; everything
targets `main`.

**Issues and PRs:** one issue per PR where practical. Issue titles are `[M1-07] Sentence
case`. Reference the key in the branch name and the commit subject.

**GitHub honours one issue per closing keyword.** `Closes #17 and #18` closes **#17 only**,
and a closing keyword in a _comment_ never fires at all. Write `Closes #17` and
`Closes #18` on separate lines, then check both actually closed.

**One-off jobs run from `dist`, not from source.** `data:airports`, `data:classify`,
`data:catchment`, `data:timezones`, `data:distances`, `world:seed`, `demand:generate`,
`npc:seed`, `admin` and `ops:status` are all bundled entry points, so `pnpm build` has to
have run first. The order matters for a new world — airports, then tiers and catchment,
then distances, then the world, its demand pools and finally `npc:seed <worldId>` — because
each reads what the preceding data stage wrote. `data:timezones` is the exception and needs
only the airports. CONTRIBUTING.md has the table.

CI builds the bundles on every pull request and asserts that each of those entry points
actually lands in `dist`, so an entry point dropped from `build.mjs` fails the run rather
than being discovered the next time somebody needs the command.

**Architectural decisions get an ADR** in [`docs/adr/`](docs/adr/). If you find yourself
explaining a choice twice, write it down once instead. ADR-0003 (deployment) and ADR-0005
(world epoch and reset) are the two that constrain operations.

**Security work starts from [ADR-0012](docs/adr/0012-tailfin-threat-model.md).** Name the
asset and attacker or failure mode a control addresses. A new public port, provider,
privileged role, secret or personal-data class, or deployment node changes the threat model;
update ADR-0012 and `docs/deploy.md` in the same change.

**Roadmap:** use the live
[GitHub milestone list](https://github.com/simmeh024/tailfinsim/milestones). Do not copy an
issue count, milestone count, completion summary or supposedly complete track list into this
file: all four become false as soon as roadmap work lands.

**Documentation ships with the behavior it describes.** A change to current mechanics,
routes, configuration, commands or deployment topology updates the matching maintained docs
in the same pull request. Keep `README.md`'s status accurate; update this file for operational
facts; update the authorization matrix with every HTTP route; update a subsystem contract
when its boundary changes; and write or amend an ADR when a decision changes. Historical
design plans and ADR context may remain, but label them historical instead of letting them
read as current state. Do not copy the volatile node table out of this file.

---

## Verification

**Prove mechanisms; do not assert them.** The habit that has caught the most: check that
tests actually _ran_ rather than silently skipped, read the CI log rather than the badge,
and query the live system rather than the config that was supposed to produce it.

Run `pnpm verify` for the standard local pre-PR pass and report its final summary, not merely
that Vitest was green. It composes the same package scripts as CI while naming an absent,
refused or unreachable test database explicitly. Its performance result is indicative only;
CI remains authoritative for protected checks and full PostgreSQL verification.

Specific traps met so far:

- **Database tests skip without `DATABASE_URL`.** A green local run means very little for
  server work. CI is where they run.
- **Drizzle wraps driver errors.** Asserting on the outer `Failed query: …` message passes
  for _any_ failure. Walk `error.cause` for what Postgres actually said.
- **`sql<Date>` is an assertion, not a conversion.** Column type parsers do not apply to
  raw aggregates like `min()` or `max()`; the driver returns a string. This typechecked
  happily and threw on real Postgres. Drizzle's own `max(column)` helper has the same
  problem with a friendlier face: it types the result as the column's type, which is a
  lie for the same reason. Normalise at the boundary.
- **A correlated subquery in a drizzle `select` list came back empty** against real
  Postgres — zeros and nulls for rows that demonstrably had data — while the _same_
  correlated shape in a `where` clause worked. Not diagnosed. If a count looks
  impossibly low, prefer a grouped query and a lookup, which is the pattern
  `countWorldContents` and `listPlayers` use.
- **Performance measured on a laptop is not the criterion.** M1-08's budget says "on the
  server", and the server is a 2-core Xeon E5-2620 v4 — five times slower than the
  development machine. Measure there, and take the fastest of several runs, because a
  single sample on a shared box measures the neighbours.
- **Effects that arrive in a later React effect race a test that waits for the first
  render.** The build badge's clock has caused this twice.
- **A documented command is a claim, and it has been wrong twice.** `admin grant <email>`
  was documented for a CLI that takes `--email`; and every `pnpm data:*`, `world:seed`,
  `demand:generate` and `admin` row in CONTRIBUTING's table failed from the repo root for
  months, because only `ops:status` had a proxy script and nobody had typed the others.
  Run the command before writing it down — including when you are only adding a row to a
  table that already exists.

---

## Before ending a turn

- Did anything change that only exists on the server (a grant, a world, a config)? Say so
  explicitly — it is invisible in the diff and lost to the next session otherwise.
- Did a test or command touch a real database? Say which, and what it changed.
- If a claim was measured, say where it was measured.
