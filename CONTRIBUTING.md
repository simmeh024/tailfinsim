# Contributing to Tailfin

The full design document lives at [`docs/tailfin-design-doc.md`](docs/tailfin-design-doc.md).
**If anything here conflicts with the design doc, the design doc wins** — say so in a
comment or an issue rather than guessing.

Coding agents must also read [`CLAUDE.md`](CLAUDE.md). Despite the filename, it is the shared
operational guide for Claude Code, Codex and any other agent working in this repository.

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

## End-to-end coverage

Every player-facing feature adds **at least one** end-to-end test for its critical happy
path. “Critical” means the shortest, unconfigured route by which a player receives the
value the feature exists to deliver. This is a floor, not a ceiling: add another journey
when a distinct player value or boundary makes it worthwhile.

Put a new journey in the nightly browser suite by default. The PR suite has a fixed,
small budget: add a journey there only when it breaks silently and often enough to justify
gating every merge. State the chosen coverage, or `none` for a non-player-facing change,
in the issue acceptance criteria and the pull request prompt.

Keep business logic out of the browser. Calculation assertions, aircraft/airport or other
permutation matrices, and refactor-sensitive implementation details belong in focused unit
or integration tests—especially `packages/sim`, where they stay deterministic, fast and
precise.

---

## The authorization matrix

### Definition of done (SEC-13)

Three rules. A reviewer can point at them, and the third is the one that gets skipped.

1. **Every protected endpoint declares its expected authorization and has a test asserting it.**
   The declaration is its row in the matrix; the test is what fails when the row stops being
   true.
2. **Every player-owned resource has both an own-resource test and a cross-owner denial test.**
   One of those alone proves the feature works, not that it is closed.
3. **Every admin endpoint has a guest test and a signed-in non-admin test** — and, where a
   capability narrower than "an administrator" guards it, a test that a role lacking that
   capability is refused.

Why the rule exists at all: authorization coverage decays differently from everything else. A
missing unit test surfaces as a bug in a feature somebody uses. A missing authorization test
surfaces as nothing — the endpoint works perfectly, including for the people who should not
have it — until it surfaces as an incident. Removing an `onRequest` hook makes the tests
_pass_; only an assertion on the negative case notices, and only if it ran.

The rest of this section is how to satisfy those three cheaply: the matrix, the ownership and
resource-id fixtures, and the capability gate. None of it is optional for a new route.

[`docs/authorization-matrix.md`](docs/authorization-matrix.md) is the intended boundary for
every web/API and worker HTTP route: public, session-protected, owner-scoped, admin-only or
loopback-only. Update its method/path row in the same pull request as a route. Derive the row
from the design, not from whichever hook the implementation currently happens to carry; a
disagreement is a bug or an explicit open question.

The matrix is deliberately separate from the route table so the authorization tests can
compare intent with implementation. SEC-04 owns the Fastify enumeration gate; do not replace
that comparison with documentation generated from the router, because generated expectations
cannot catch a missing guard.

[ADR-0020](docs/adr/0020-http-authorization-and-concealment.md) owns the error vocabulary:
401 means no valid session, 403 means a resolved identity lacks a disclosed permission, and
404 means a resource does not resolve inside that identity's permitted namespace. For a
private resource, malformed, missing and cross-owner path ids must use the endpoint's exact
same 404 status, code and message. Resolve ownership in the query; do not fetch globally and
compare afterwards. A public projection is an explicit matrix row with a limited field
contract, not an exception invented inside a handler.

Prove it with a second owner. An owned endpoint is not done until it is tested against another
player's resource, and `createOwnershipTestSuite` (`packages/server/src/test-fixtures/ownership.ts`,
SEC-05) exists so that costs a few lines rather than a fresh set of fixtures — it founds two
players with airlines in one world and a third airline for the first player in a second world.
Copy `airline/cross-owner-routes.test.ts`: own resource 200, another player's 404 identical to a
missing id, the same player's other-world resource 404, and a refused write shown to have left the
row **unchanged**. The last one is the assertion that separates a real guard from one that answers
404 after acting.

SEC-07 extends that rule to every position. Add the endpoint to `RESOURCE_ID_SURFACES` in
`packages/server/src/test-fixtures/resource-id.ts`, and build its tests from `resourceIdCases`:
own, another player, a well-formed absent UUID and a UUID for the wrong entity kind. Exercise body,
query, parent and `x-tailfin-world-id` inputs as well as paths. Malformed body/query identifiers are
400; malformed private path identifiers use the same 404 as a missing row. For writes, snapshot the
target and any balance or ledger the operation could touch, then compare after every refusal. If an
identifier is a client token or a selector from an already disclosed set rather than a resource
reference, classify that semantic explicitly in the inventory and test its actual boundary.

### Parse request bodies; never read them in handlers

Every write handler must pass the whole body through `parseRequestBody()` and consume only the
parser result. Direct field access on `request.body` is forbidden by lint. Request schemas should
be strict unless an established compatibility contract deliberately strips unknown keys; either
way, tests send authority, ownership, identity, session and server-computed fields and read the
stored row back to prove they changed nothing. The canonical sensitive-field registry lives beside
the Drizzle schema as `SENSITIVE_REQUEST_FIELDS`, so column renames break typecheck instead of
silently leaving a stale checklist. Extend that registry and the hostile-body tests whenever a new
sensitive column or write endpoint lands.

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
yourself wanting a timer in a route, persist the commitment and let the Worker claim it. A
game-time due date is normally a `world_event` written with `scheduleEvent()`; a `fire_at`
that is already due means "now". An explicitly wall-clock commitment must not be squeezed
into that queue: M4-04's aircraft orders store `delivery_at` as real time and the Worker
claims due rows with `FOR UPDATE SKIP LOCKED`. Both shapes keep timers out of HTTP handlers
and make the data change and job completion one transaction.

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

### Say loading, empty, refused and broken through `StateBlock`

`packages/web/src/ui/` is the shared component layer, and `StateBlock` owns the four
things a panel can say instead of its content: `loading`, `empty`, `refused`, `broken`.
Before it existed the client had two note classes doing the same job — `admin__note` and
`page__note` — picked more or less at random, so the competition tab announced its loading
state with one and the failure beside it with the other. Worse, they were not equivalent to
a screen reader: a failure was an `alert`, but _"Loading the market…"_ was a plain
paragraph, so a slow request read as an empty panel.

- **`empty` and `broken` are not the same state.** A catalogue with no aircraft in a 1950s
  world is a correct answer; a catalogue that could not be read is a fault. Painting both as
  grey text hid the difference from the player, and the pair is the one worth keeping apart
  most carefully.
- **A block carries the _answer_ to a request.** A stale-data caveat is not an answer — it
  is a qualification on an answer already on screen (_"the figures below are older than they
  look"_), and so is the outcome of an action (_"Revoked 3 sessions."_). Those stay as plain
  notes; a banner component for them is not built yet.
- **Absence is quiet, failure is not.** `loading` and `empty` keep the muted sentence the
  app already had; only `refused` and `broken` get chrome. Giving every _"No routes
  recorded."_ a bordered card makes a healthy console look alarming.
- **The announcement belongs to the kind, not the caller.** `loading` is a polite `status`,
  `refused` and `broken` are `alert`s, `empty` announces nothing. `STATE_KINDS` is a runtime
  tuple that derives the type, so a fifth kind cannot arrive without a test forcing that
  decision.
- A resolving link or control goes in the `action` prop, not beside the block — several of
  these notes used to have their _"Back to players"_ sitting outside as a loose sibling.

`ui.css` may use **tokens only**; the colour-literal guard walks it like every other file. A
test in `StateBlock.test.tsx` scans the client for a hand-written note whose sentence opens
with _"Loading"_ or _"Could not load"_, because a third note class is otherwise always the
path of least resistance.

---

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
[`docs/authorization-matrix.md`](docs/authorization-matrix.md) in the same change. Every new
identifier-bearing route also needs a malformed path case that proves it returns 404 rather
than a database 500. Private identifiers additionally need missing and cross-owner cases whose
status and body are identical.

### One-off jobs

Everything below runs from anywhere in the repo and needs the package **built** first
(`pnpm build`), because each is a bundled entry point rather than a source file —
`tsc` is the typechecker here, not the compiler (ADR-0001).

| Command                                                            | What it does                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm data:airports`                                               | Import the OurAirports dataset (M1-01)                                              |
| `pnpm data:classify`                                               | Assign tiers over the imported set (M1-02)                                          |
| `pnpm data:catchment`                                              | Derive catchment population and the three indices (M1-03)                           |
| `pnpm data:timezones`                                              | Give every airport a timezone and an offset (M3-04a)                                |
| `pnpm data:distances`                                              | Pack the great-circle distance matrix (M1-04)                                       |
| `pnpm world:seed`                                                  | Create the flagship world from config (M1-09)                                       |
| `pnpm demand:generate`                                             | Size every viable city pair's demand pool (M3-01)                                   |
| `pnpm npc:seed`                                                    | Populate a world with NPC incumbents (M3-12)                                        |
| `pnpm admin`                                                       | Grant and revoke admin from a shell (M1A-01)                                        |
| `pnpm admin cash --airline <uuid> --amount <major> --reason "why"` | Adjust a balance through AIR-06, audited. No HTTP route exists for this on purpose. |

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
- **`server`** — Fastify web/API and Worker entry points, persistence, clock and event queue.
  May use `sim` and `shared`; only the Worker may start the engine loop.
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

[`.github/pull_request_template.md`](.github/pull_request_template.md) prompts for the part of
a change that a diff cannot show: the migration's expand/contract strategy, which node needs
deploying, what was actually verified and against which database, and anything that exists only
on the server. It is short on purpose and the description above it is free-form on purpose — a
prompt, not a form. **"None" is a real answer**; a tick that is not true is worse than a blank.
Every incident will suggest a new section, and adding one is a decision rather than a reflex.

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
- **Check who owns the domain before filing or building.**
  [`docs/roadmap-dependencies.md`](docs/roadmap-dependencies.md) records what each milestone
  owns, what it explicitly does not, and which dependencies are implemented, planned or
  missing. It exists because the same gap was found three times independently, and because
  two open issues once described the same replay harness.
- **Documentation changes with behavior.** Keep `README.md`'s current-state list,
  `CLAUDE.md`'s operational facts, the relevant subsystem contract and the authorization
  matrix accurate in the same pull request. Preserve ADR history, but amend any wording that
  would otherwise present an obsolete implementation state as current.

---

## Units and currency

§24 listed the design doc's mixed `$`/`€` and nm/ft/m/t/kg as open debt; M8-02 settles it.

**Money is always integer minor units of one accounting currency, USD.** Never a float:
binary floating-point currency arithmetic loses fractions of a cent in ways that are silent
and cumulative. The convention is the column/field-name suffix `_minor` (`cash_minor`,
`monthly_salary_minor`), stored as `bigint` and carried on the wire as an integer `number`.
`packages/server/src/db/money-float-guard.test.ts` fails if a `_minor` column is ever declared
`doublePrecision`/`real`/`numeric` — so add money as `bigint`, and if you need a fractional
_ratio_ (an FX rate, a load factor), it is not money and does not use the `_minor` suffix.

**Currency is display-only.** A player may choose a display currency (`SUPPORTED_CURRENCIES`
in `@tailfin/shared`; the default is USD), and the client converts USD minor units to it at
the render boundary using a rate from `currency_rate`. No stored or computed value is ever in
anything but USD, so `flight_result` immutability and the ledger are untouched. Do not convert
money anywhere but the display edge, and keep the admin console in USD — it audits the economy.

**Units:** nautical miles for distance, feet for altitude, kilograms for weight — consistent
across sim, API and UI. Non-money continuous quantities (latitude, `great_circle_nm`, block
hours) are `doublePrecision`; that is fine because they are not money.

---

## Licence, and what a contribution grants

**Code is [AGPL-3.0-only](LICENSE). Documentation is reserved ([`docs/LICENSE`](docs/LICENSE)).**

Inbound matches outbound, and there is no CLA. Opening a pull request against
this repository offers your contribution under the licence that already covers
the file you are changing: the AGPL for anything under `packages/` or `deploy/`,
and `docs/LICENSE`'s reserved terms for anything under `docs/`. Nothing more is
asked and nothing is signed. If that is not what you intend, say so in the pull
request rather than assuming — it is far easier to sort out before a merge than
after one.

Two consequences worth knowing before you build on this.

**The AGPL reaches network use.** §13 is the clause that distinguishes it from
the GPL: run a modified Tailfin as a service and its users are entitled to the
modified source. That is deliberate. Tailfin is a hosted persistent world that
nobody downloads, so ordinary GPL copyleft would almost never trigger and a
closed hosted fork would be entirely permitted. If you fork this to run it, you
are welcome to — and you have to publish what you changed.

**A new dependency is a licence decision.** Every current dependency is
permissive or MPL-2.0, and none conflicts with the AGPL —
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) has the table. Adding a
package under anything else needs deciding before it lands, not after. Note that
Dependency Review blocks a _vulnerable_ package and checks no licences at all,
so nothing automated will catch this for you.

Anything the design document says about trademarks still holds: type
designations and manufacturer names are factual and are used descriptively;
manufacturer logos, trade dress and house liveries are not shipped, and adding
one would be a licensing problem rather than an art decision.
