# Working on Tailfin

Instructions for coding agents. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers how the code
is written — the four invariants, the package graph, the commands. This file covers how
the project is **operated**, which is the part that is not visible from the code and where
the expensive mistakes have actually been made.

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

**Session authority rotates when privilege changes.** A real admin grant or revocation deletes
all of the target player's sessions in the same transaction as the grant and audit row. Do not
change that to preserve a convenient cookie: the pre-change token must receive 401. Normal
player sessions default to 30 days, admin sessions to 12 hours, and production refuses a
non-HTTPS `PUBLIC_ORIGIN`; see ADR-0015.

---

## The two environments, on three nodes

Production and dev **web** share one DreamCompute box, `208.113.129.131`. Same repo, same
build, different checkout, port, database and audience. Since OPS-09 there is also a second
box, `tailfin-dev-worker-01` (`208.113.129.83`), running the dev **worker** — so "the box" is
no longer an unambiguous phrase, and production still has no worker at all.

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

|             | dev worker                                       |
| ----------- | ------------------------------------------------ |
| host        | `208.113.129.83` — its own VM                    |
| checkout    | `/srv/tailfin-dev-worker`                        |
| service     | `tailfin-dev-worker` (+ `tailfin-db-tunnel`)     |
| entry point | `dist/worker.js`                                 |
| port        | 3100, **loopback only** — no Caddy vhost, ever   |
| database    | `tailfin_dev` via SSH tunnel on `127.0.0.1:5433` |
| deploy with | `./deploy/deploy-dev-worker.sh <ref>`            |
| migrations  | **no** — the web node owns them                  |

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

**Nothing runs the simulation — the engine now exists, and no service starts it.** Read
that as two separate facts, because only one of them changed.

OPS-08 settled where the engine lives: `src/worker.ts`, a second entry point from the same
build, driving `createTickLoop` and `drainDueEvents` over every non-archived world. The
boundary is [ADR-0019](docs/adr/0019-web-worker-boundary.md), and it is enforced by lint and
by `engine/boundary.test.ts` rather than by memory — the web process cannot reach the loop.
Do not wire it into `main.ts`; that is now a failing test as well as a bad idea.

**The simulation now runs on dev, and nowhere else.** OPS-09 put
`tailfin-dev-worker.service` on its own node, `tailfin-dev-worker-01` — so a dev world's clock
advances and its queue drains, while **production still has no worker at all**. Do not
generalise a reading from one to the other; that is [OPS-11](https://github.com/simmeh024/tailfinsim/issues/191).

A "ticks: 0, errors: 0" reading still means _nothing has run_ rather than _everything is fine_.
The admin console's health page infers liveness from the queue for exactly that reason, and the
worker's own `/healthz` answers **503 while its process is alive** if the engine is not
ticking — the failure `systemctl is-active` cannot see.

**Before starting a worker anywhere, check `engine.unhandledEventTypes`.** Only
`FLIGHT_ARRIVE` has a handler. `FLIGHT_DEPART` is scheduled by `schedule/store.ts` and has
none, and `drainDueEvents` marks an event of an unhandled type **failed** — so a worker
started against a queue holding materialised departures marks every one of them failed on the
first tick. Recoverable, since the rows remain, but not something to discover afterwards.
Starting it on dev was safe only because `tailfin_dev` had **zero** `world_event` rows, which
was checked first rather than assumed.

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
open/lock/archive/reset lifecycle, world health, a read-only player browser, and the audit
log. Anything it can answer is faster than SSH, and every mutation it performs is audited
in the same transaction as the change.

The four-node dev/production web/worker split is planned in
[OPS-08 – OPS-16](https://github.com/simmeh024/tailfinsim/issues/195). Read that sequence
before designing anything infrastructural; it already records the two things that bite —
the database has no home in the four-node diagram, and builds happen on the box.

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

**Branches:** `feat/<issue-key>-<slug>`, `fix/<slug>`, `chore/<slug>`. There is no
`develop`. Everything targets `main`.

**Issues and PRs:** one issue per PR where practical. Issue titles are `[M1-07] Sentence
case`. Reference the key in the branch name and the commit subject.

**GitHub honours one issue per closing keyword.** `Closes #17 and #18` closes **#17 only**,
and a closing keyword in a _comment_ never fires at all. Write `Closes #17` and
`Closes #18` on separate lines, then check both actually closed.

**One-off jobs run from `dist`, not from source.** `data:airports`, `data:classify`,
`data:catchment`, `data:timezones`, `data:distances`, `world:seed`, `demand:generate`,
`admin` and `ops:status` are all bundled entry points, so `pnpm build:apps` has to have
run first. The order matters for a new world — airports, then tiers, then catchment, then
distances, then the world, then its demand pools — because each reads what the last one
wrote. `data:timezones` is the exception and needs only the airports. CONTRIBUTING.md has
the table.

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

**Milestones:** 273 issues across 23 of them. `M0`–`M15` are the game backlog and `M1A`
is the admin console core. The rest are cross-cutting tracks that deliberately sit outside
the feature sequence, because none of them are game behaviour:

| Track      | What it covers                                                        |
| ---------- | --------------------------------------------------------------------- |
| `OPS`      | Deployment, backups, infrastructure                                   |
| `SEC`      | Authorization and ownership                                           |
| `SEC-HARD` | Security hardening                                                    |
| `AUTH`     | Multi-method authentication                                           |
| `E2E`      | Browser and end-to-end testing                                        |
| `POD`      | The poster shop — post-launch, and the first thing needing real money |

Complete so far: **M0**, **M1**, **M1A** and **M2**. `M3 · Demand & Commercial` has
started.

---

## Verification

**Prove mechanisms; do not assert them.** The habit that has caught the most: check that
tests actually _ran_ rather than silently skipped, read the CI log rather than the badge,
and query the live system rather than the config that was supposed to produce it.

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
