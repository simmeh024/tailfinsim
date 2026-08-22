# Contributing to Tailfin

The full design document lives at [`docs/tailfin-design-doc.md`](docs/tailfin-design-doc.md).
**If anything here conflicts with the design doc, the design doc wins** — say so in a
comment or an issue rather than guessing.

---

## The four invariants

These are load-bearing. They are referenced by mechanics all over the design doc, and
each one is cheap to honour now and enormously expensive to retrofit. Two of them are
enforced by lint; all four are enforced by review.

1. **The server is authoritative; the client never computes economic outcomes.**
2. **`packages/sim` must stay pure and deterministic** — no `Date.now()`, no
   `Math.random()` outside a seeded RNG, no I/O.
3. **All balance numbers live in config, never hardcoded.**
4. **Every displayed figure must be traceable to its cause (no dead-end numbers).**

### Why each one matters

**1. Server authority.** This is a single shared persistent world where players compete
in the same market (design doc §21). A client that computes its own load factor or
revenue is a client that can lie. The web package may not import `@tailfin/sim` — this
is enforced by `@typescript-eslint/no-restricted-imports` in `eslint.config.js`.

**2. Sim purity.** The deterministic replay harness (M13-01), the economy regression
harness (M13-02) and the five App. A.12 validation tests (M13-03) all require that the
same inputs produce the same outputs, forever. A stray `Date.now()` makes a failing
economy test unreproducible, which in a live world means you cannot diagnose a bug
players are actively losing money to. `packages/sim` may import `@tailfin/shared` and
nothing else — no sibling packages, no `node:*` builtins. Enforced by lint.

Pass time in as a parameter. Pass randomness in as a seeded generator. Return data;
never write it.

**3. Balance in config.** §22.3 requires a live economy console where an admin can
retune an Appendix A β coefficient, preview the impact against a snapshot, and roll it
back — **without a deploy**. Every hardcoded constant is a number that cannot be fixed
while the world is running. If you are typing a number that a designer might one day
want to change, it belongs in versioned config.

Since M3-11 that is a real table rather than an intention. The whole economy is one
zod-validated payload, `EconomyConfig` in `@tailfin/shared`; a row in `economy_config`
holds each version; a world pins one through `world.economy_config_version`; and
`economy/loader.ts` resolves the pin on every read. **`packages/sim` contains no balance
literal at all** — every `DEFAULT_*` there is a slice of the shipped payload, which is
the seed for a fresh database and nothing more. Three things hold that line:

- **Lint.** `packages/server` may not import `DEFAULT_GRAVITY`, `DEFAULT_LOGIT`,
  `FARE_FLOOR_RATIO` and the rest from `@tailfin/sim`, nor `ECONOMY_CONFIG_V1` from
  `@tailfin/shared`. Only `economy/**` may, because seeding is its job.
- **`sim/balance-source.test.ts`.** Asserts each `DEFAULT_*` is the shipped payload's own
  object — `toBe`, not `toEqual`, since a hand-copied table with the same numbers in it is
  exactly the duplication being prevented — and reads the declarations off disk, because
  identity says nothing about a re-introduced scalar.
- **The database.** `economy_config` rows are immutable; triggers refuse UPDATE, DELETE
  and TRUNCATE. Retuning is an INSERT of a new version. That is what keeps an old
  `flight_result` explicable (invariant 4) and what makes the loader's cache correct
  across processes without any invalidation channel.

Adding a balance number means adding a field to `EconomyConfig`, giving it a value in
`ECONOMY_CONFIG_V1`, and reading it through the loader. What is deliberately _not_ in
there: aircraft performance (§22.5's catalogue, versioned separately), disruption
probability (§15 and the world seed), and scheduling limits. A fare change and an
aerodynamics change must not share a version number.

**4. No dead-end numbers.** §14.1 is explicit: every figure drills down to its cause.
Load factor → by route → by flight → by segment → the Appendix A waterfall showing
which competitor took the passengers and why. A number a player cannot interrogate is a
number they will not trust, and the entire demand model rests on that trust (§A.1). In
practice: when you compute a figure for display, carry its decomposition with it rather
than recomputing or discarding it.

---

## The authorization matrix

[`docs/authorization-matrix.md`](docs/authorization-matrix.md) is the intended boundary for
every web/API and worker HTTP route: public, session-protected, owner-scoped, admin-only or
loopback-only. Update its method/path row in the same pull request as a route. Derive the row
from the design, not from whichever hook the implementation currently happens to carry; a
disagreement is a bug or an explicit open question.

The matrix is deliberately separate from the route table so the authorization tests can
compare intent with implementation. SEC-04 owns the Fastify enumeration gate; do not replace
that comparison with documentation generated from the router, because generated expectations
cannot catch a missing guard.

---

## The web/worker boundary

Two processes come out of `packages/server`, from one build and one commit. What separates
them is not what they are made of but **who is allowed to start work**.

|                  | **Web** — `src/main.ts`                                                                                                  | **Worker** — `src/worker.ts`                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owns             | HTTP, the client bundle, the API, auth and sessions, the admin console, anything short enough to finish inside a request | The tick loop, draining `world_event`, economy processing, demand and route calculation, every scheduled job, anything CPU-heavy or long-running |
| Serves           | everything public, via Caddy                                                                                             | one loopback endpoint, `/healthz` and `/queues`                                                                                                  |
| May start a loop | **no**                                                                                                                   | yes                                                                                                                                              |

**Neither owns both, and a scheduled job has exactly one owner — the worker.** If you find
yourself wanting a timer in a route, you want an event: write a `world_event` row with
`scheduleEvent()` and let the worker drain it. A `fire_at` that is already due means "now".

That is also the only channel between them. Web writes a row; the worker picks it up. There
is no RPC and no HTTP call from one to the other — see
[ADR-0019](docs/adr/0019-web-worker-boundary.md), which also records why Postgres remains the
queue and what would change that.

Three things hold the line, so it does not depend on anyone remembering it:

- **Lint.** `sim/tick` may not be imported anywhere in `packages/server` except `worker.ts`,
  `engine/**` and the loop itself.
- **`engine/boundary.test.ts`.** Walks the module graph from `app.ts` and `main.ts` and
  asserts the loop and all of `engine/` are unreachable; walks from `worker.ts` and asserts
  they are, and that `app.ts` is not.
- **`engine/health.test.ts`.** Asserts the worker's whole route table, so "the worker serves
  nothing" fails a test rather than a code review.

Note what is _not_ restricted: `sim/event-queue.ts` stays open to the web process, because
scheduling an event is web work. The restriction is on the loop, not on the queue.

**Dev runs the worker as a systemd service; production does not yet have one.** The current
node, service and database ownership is maintained in
[`CLAUDE.md`](CLAUDE.md#the-two-environments-on-three-nodes), not duplicated here. To run the
same entry point locally as a development convenience:

```bash
pnpm build
node packages/server/dist/worker.js
```

### The browser world renderer

M7-01's renderer is one deck.gl instance with `MapView` and `_GlobeView` over the same layer
factory. Read [`docs/world-renderer.md`](docs/world-renderer.md) before changing it. In
particular:

- add shared visual layers to `packages/web/src/world/layers.ts`; do not create projection-
  specific copies or a second canvas;
- preserve the controlled camera and layer-toggle state when changing views;
- use great-circle arcs for routes and keep an antimeridian case in the layer tests;
- pass live routes, aircraft, and world time from typed server responses as those APIs land;
  never invent client-side operational state or import simulation code;
- treat deck.gl's low-FPS metrics as an active-render signal, not a simulation clock, and
  verify frame-rate claims in a WebGL browser rather than jsdom.

Natural Earth land is bundled through `world-atlas`; adding a network basemap is an
availability and privacy decision, not a cosmetic dependency change.

---

## Getting set up

```bash
pnpm install
pnpm verify
```

Node version is pinned in `.nvmrc`; pnpm version in `package.json`'s `packageManager`.

> **First run:** `pnpm typecheck` also emits the `.d.ts` files that packages resolve each
> other through. Until it has run once, your editor will report unresolved
> `@tailfin/*` imports. This is expected — run it once after cloning.

### Commands

| Command                                         | What it does                                       |
| ----------------------------------------------- | -------------------------------------------------- |
| `pnpm build`                                    | Builds the deployable server and web bundles       |
| `pnpm typecheck`                                | `tsc -b` across all project references             |
| `pnpm lint`                                     | ESLint, including the architectural guards above   |
| `pnpm lint:fix`                                 | The same, applying what it can fix                 |
| `pnpm format`                                   | Prettier write                                     |
| `pnpm format:check`                             | Prettier check — this is the one CI runs           |
| `pnpm test`                                     | Vitest across all packages                         |
| `pnpm test:coverage`                            | Adds coverage; thresholds enforced for `sim`       |
| `pnpm test:perf`                                | Only the budgeted benchmarks, uninstrumented       |
| `pnpm verify`                                   | Local pre-PR checks with an explicit skip summary  |
| `pnpm ops:status`                               | What is deployed where, over public HTTP (OPS-02)  |
| `pnpm security:headers --mode enforced <urls…>` | Exact edge policy on running hosts (SEC-HARD-05)   |
| `pnpm clean`                                    | Removes all generated bundle and declaration files |

CI runs typecheck, lint, format check and coverage on every PR. It also starts the committed
Caddyfile with a checksum-pinned Caddy 2.11.4 and checks report-only/enforced headers on real
HTTP responses. Dependency and code scanning are described under
[Dependencies](#dependencies) below.

Run `pnpm verify` before opening a PR. It composes those existing package scripts in
cheap-fails-first order, adds the canonical production build and an indicative local
performance pass, and prints a final PASS/FAIL/SKIPPED line for every stage. A missing,
refused or unreachable test database is called out explicitly. The command does not replace
CI: PostgreSQL verification, the running Caddy policy and deploy-artefact assertions remain
authoritative there.

**`pnpm test:perf` is a separate, uninstrumented run on purpose.** V8 coverage costs about
5× on the code paths that carry a budget, so measuring them under it would be measuring
the instrumentation. The budgets themselves are asserted twice — a loose bound that is
always on, catching an accidental O(n²) in any mode, and the real one only when coverage
is off.

> **Performance budgets are stated for the server, not for your laptop.** The production
> box is a 2-core Xeon E5-2620 v4, roughly five times slower than a development machine.
> A benchmark that passes here with less than 5× headroom has not been shown to pass
> there — measure it on the box before believing it.

### The server suite runs one file at a time

`vitest.config.ts` sets `fileParallelism: false` for the `server` project only. It is a
correctness setting, not a tuning one: those tests share a single database, and several
of them do table-wide work — the OurAirports importer's `--prune` deletes every airport
whose source id is absent from the incoming dataset, which is right for the importer and
lethal for whatever else is mid-test. The other projects keep their parallelism; they
share nothing.

A route whose contract says **no database access** should fail at that boundary, not wait
for a connection attempt to a deliberately dead port. `GET /api/version` in
`packages/server/src/app.test.ts` uses a synchronous, non-network database alarm for this
reason. Its cases also share one fully readied Fastify app per environment label: putting a
complete plugin-tree ready/close cycle inside every small assertion makes scheduler delay look
like handler delay under cross-project load. Keep teardown awaited without an empty `catch` so
cleanup failures remain test failures.

Tests needing a player airline use `createFoundedAirlineFixtureHarness` from
`packages/server/src/test-fixtures/founded-airline.ts`. The harness calls the real founding
transaction, including code allocation, founder hub and opening cash movement, and its cleanup
is scoped to the exact ids it created. Reuse an existing world, player or hub through its
options when a test needs shared context; do not hand-insert an airline or use a table-wide
cleanup. A direct insert creates a state the game cannot reach and silently omits the ledger
entry every real airline has.

HTTP authorization tests use `createAuthorizationTestSuite` from
`packages/server/src/test-fixtures/authorization.ts`. Give each suite a stable, unique name;
the harness deterministically creates `guest`, `playerA`, `playerB` and `admin`, issues real
session cookies through production code, and removes only those exact identities. Express all
four expected statuses in one `expectAuthorization` case. For a protected mutation, submit an
invalid payload and expect the admin to reach validation (usually 400); that proves the guard
order without changing game state. Add the corresponding intent row to
[`docs/authorization-matrix.md`](docs/authorization-matrix.md) in the same change.

### One-off jobs

Everything below runs from anywhere in the repo and needs the package **built** first
(`pnpm build`), because each is a bundled entry point rather than a source file —
`tsc` is the typechecker here, not the compiler (ADR-0001).

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `pnpm data:airports`   | Import the OurAirports dataset (M1-01)                    |
| `pnpm data:classify`   | Assign tiers over the imported set (M1-02)                |
| `pnpm data:catchment`  | Derive catchment population and the three indices (M1-03) |
| `pnpm data:timezones`  | Give every airport a timezone and an offset (M3-04a)      |
| `pnpm data:distances`  | Pack the great-circle distance matrix (M1-04)             |
| `pnpm world:seed`      | Create the flagship world from config (M1-09)             |
| `pnpm demand:generate` | Size every viable city pair's demand pool (M3-01)         |
| `pnpm npc:seed`        | Populate a world with NPC incumbents (M3-12)              |
| `pnpm admin`           | Grant and revoke admin from a shell (M1A-01)              |

They run in that order for a new world: the demand model reads the catchment the importer
derived, and the catchment needs the airports. `demand:generate` is the only one that is
safe and sometimes necessary to re-run — the gravity coefficients are balance numbers, and
retuning them means `--regenerate`.

`npc:seed` is last and takes a world id, because NPC carriers choose their networks from
`demand_pool`: a world without pools gets no carriers and a message saying so. It is
idempotent by presence — a world that already has NPCs is left alone — which matters
because nothing here can be deleted back, and a second run would otherwise double a
world's competition.

`data:timezones` is the exception to the ordering: it needs only the airports, so it can
run any time after `data:airports`. It sits here because it shares the GeoNames download
with `data:catchment` — point both at the same `--cache` and `cities15000.zip` is fetched
once. It is also safe to re-run; it updates in place.

Each of these is a one-line proxy in the **root** `package.json` to the real script in
`packages/server`, so the commands above work from anywhere in the repo. That is not
cosmetic: they are documented here as `pnpm <name>`, and for a long time only `ops:status`
had a proxy — so every other row in this table failed with
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` when anyone actually typed it. The direct form,
`pnpm --filter @tailfin/server <name>`, works too.

### Local database

Copy `.env.example` to `.env` (gitignored), then:

```bash
docker compose up -d
pnpm db:migrate
```

The compose file has a healthcheck, so `db:migrate` immediately after `up` works —
without it Postgres reports running several seconds before it accepts connections.

| Command            | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `pnpm db:generate` | Generate a new SQL migration from schema changes |
| `pnpm db:migrate`  | Apply pending migrations                         |
| `pnpm db:check`    | Verify migration consistency                     |
| `pnpm db:studio`   | Browse the database in Drizzle Studio            |

Generated migrations are **committed as SQL** under `packages/server/drizzle/`. Never
edit an applied migration — add a new one. Name them meaningfully with
`drizzle-kit generate --name=what_it_does`, since the default is a random word pair.

Every migration after `0019_large_hellfire_club` also declares its OPS-05 phase at the top:

```sql
-- tailfin:migration-strategy expand
-- tailfin:migration-strategy contract-safe-after #123
```

Use `expand` when the previously deployed application can still read and write the resulting
schema: new columns are nullable or have a database default, and old names and shapes remain.
Use `contract-safe-after` only after an earlier released version stopped using the thing being
removed; the issue named by the marker records that sequencing. The migration command and CI
reject a missing marker, obvious contractions labelled expand, and SQL that cannot run in the
atomic batch (`CREATE INDEX CONCURRENTLY`, `VACUUM`, and similar). The check catches syntax,
not meaning—review still has to consider constraints, triggers and data transforms.

Do not add down-migrations. A reverse migration can destroy data written by the forward one,
and checking out old code never reverses schema. See
[`ADR-0016`](docs/adr/0016-migration-failure-strategy.md).

The database is created with `--locale=C`. Postgres sorts differently under different
host locales, and ordering must not depend on a developer's OS language settings.

### The test database is a different database

The database-backed tests are **destructive**: they create and delete players, and one of
them arranges for there to be exactly one admin in order to prove the last one cannot be
revoked. They must never see a database anyone cares about.

`packages/server/src/test-setup.ts` calls the shared guard in
`packages/server/src/test-support/database-safety.ts`. If `DATABASE_URL` is set and names a
database whose name does not end in `_test` or `_ci`, the server suite **throws** rather than
running — it does not skip, because a silent skip in CI would report success for work it never
did. Keep the boundary in the Vitest setup file; individual suites must not reimplement it.

With `DATABASE_URL` unset, the database suites skip themselves and everything else runs.
That is the ordinary local case and needs no setup. To run them locally:

```bash
docker compose exec postgres createdb -U tailfin tailfin_test
DATABASE_URL=postgres://tailfin:tailfin_dev@127.0.0.1:5432/tailfin_test pnpm test
```

This exists because the suite was once run against the dev server by sourcing that box's
`.env`, and it revoked a real person's admin access. Nothing was looking; now something is.

> Any container runtime works — Docker Engine, Rancher Desktop, Podman. Note that
> Docker **Desktop** requires a paid licence for business use above 250 employees or
> $10M revenue.

---

## How the packages relate

```
shared  ──────────────┬──────────────┬─────────────┐
   types & schemas    │              │             │
                      ▼              ▼             ▼
                     sim ─────────► server      web
              pure, deterministic   authority   viewer
```

- **`shared`** — types and zod schemas. Depends on nothing.
- **`sim`** — the pure core: demand, flights, economy, crew. Depends on `shared` only.
- **`server`** — world clock, tick loop, persistence, API. May use `sim` and `shared`.
- **`web`** — the browser client. May use `shared` only.

Arrows are the _only_ permitted directions. The lint config enforces the two that
matter most.

---

## Dependencies

Every pull request is checked for **newly introduced** advisories by
[`.github/workflows/dependency-review.yml`](.github/workflows/dependency-review.yml)
(SEC-HARD-03). It compares the dependency graph of `main` against the graph of your
branch and reports what your diff _added_ — runtime and development alike, direct and
transitive alike.

| Severity     | Direct dependency               | Transitive       |
| ------------ | ------------------------------- | ---------------- |
| **Critical** | **Blocks merge**                | **Blocks merge** |
| **High**     | **Blocks merge**                | **Blocks merge** |
| Moderate     | Warns — say something in the PR | Warns            |
| Low          | Recorded in the run summary     | Ignored          |

Moderate and low do not fail the check, on purpose. A gate that fires on every
low-severity advisory is a gate people learn to click through, and then the high one
goes through with it.

**What it does not do.** It says nothing about packages that were already in the tree —
only about what your PR adds. A dependency that has been vulnerable since March is not
this check's problem; the whole-tree sweep is SEC-HARD-34's scheduled job. It also
cannot see a vulnerability nobody has published yet, and it is not a code scanner —
that is CodeQL, which answers an unrelated question about Tailfin's own source.

### Overriding a block

Sometimes the advisory genuinely does not reach us: a devDependency that never runs
against untrusted input, or a vulnerable code path Tailfin never calls. The override is
deliberately a **code change, not a click**:

1. Add the GHSA id to `allow-ghsas` in the workflow, **in the PR that needs it**.
2. In the same diff, write down why the advisory does not apply.
3. Remove it again when the dependency is upgraded.

That makes every override a reviewable line in a diff with a justification attached to
it, rather than a decision someone took quietly in a settings page. An override with no
stated reason should be sent back.

## Code scanning

Every pull request is analysed by
[`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) for
JavaScript/TypeScript and GitHub Actions (SEC-HARD-02). The `CodeQL merge protection`
ruleset applies these measured thresholds to new results:

| Finding                                | Merge policy |
| -------------------------------------- | ------------ |
| Standard severity `error`              | **Blocks**   |
| Standard severity `warning` or `note`  | Reported     |
| Security severity `critical` or `high` | **Blocks**   |
| Security severity `medium` or `low`    | Reported     |

Do not read a clean scan as proof that inputs are safe. The deliberate canary in PR #286
proved CodeQL catches a `node:http` value flowing to `eval()`, and also proved it did not
model Fastify's `request.query` as a remote-flow source. Boundary schemas and security
regression tests remain required.

False positives are dismissed only with evidence in the Security tab. A real finding
deferred to another issue names that issue and says explicitly that dismissal does not make
the behavior safe. Do not lower the ruleset threshold to get a PR through. See
[ADR-0013](docs/adr/0013-codeql-merge-policy.md) for the tuning measurements, baseline
triage and rationale.

---

## Release flow

**Merging to `main` stages a release; it does not release production.** OPS-06 keeps the
human approval boundary from ADR-0003: dev will track green `main` automatically under
[OPS-17](https://github.com/simmeh024/tailfinsim/issues/320), and a human will promote that
reviewed commit under [OPS-18](https://github.com/simmeh024/tailfinsim/issues/321).

The normal release-line invariant is **`dev ≥ prod`**. When both environments run commits
from `main`, `dev build − prod build` is the number of staged changes tested on dev but not
yet released. Zero means they are aligned; a negative value is an operational incident.
Dev may be pinned to an unmerged branch for an explicit preview, in which case the builds
are not ordered and `pnpm ops:status` marks the dev row with `*`.

Do not describe a merge as a deploy. Check `pnpm ops:status` before reporting what is live;
[ADR-0003](docs/adr/0003-deployment-approach.md) owns the boundary and its revisit criteria.

---

## Working style

- **TypeScript is the typechecker, not the compiler.** `moduleResolution: bundler` means
  runtime artefacts come from Vite (web) and esbuild (server). `tsc -b` emits
  declarations only.
- **Migrations are committed as SQL**, never generated at runtime (M0-05).
- **Migrations use atomic expand/contract**, with a verified pre-migration recovery point
  during deploy (OPS-05 / ADR-0016).
- **Connection config comes from the environment**, never hardcoded. See
  [`docs/deploy.md`](docs/deploy.md).
- **One issue per PR** where practical; reference the issue key (`M0-03`) in the branch
  name and the commit subject.
- **Architectural decisions get an ADR.** See [`docs/adr/`](docs/adr/). If you find
  yourself explaining a choice twice, write it down once instead.

---

## Units and currency

The design doc mixes `$` and `€`, and nm/ft/m/t/kg (§24 lists this as open design debt,
resolved by M8-02). Until M8-02 lands, **do not invent a convention** — flag it on the
issue and use whatever the surrounding code already does.
