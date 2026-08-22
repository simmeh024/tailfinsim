# Tailfin

A real-time online airline management sim. One shared persistent world, running at 2×
wall-clock time, that never pauses.

> You start with one leased aircraft and one airport. You paint it, you fit the cabin,
> you pick a route, and you watch it fly — in real time, on a live world map, alongside
> every other player's fleet.

- **Design document:** [`docs/tailfin-design-doc.md`](docs/tailfin-design-doc.md) — the
  authority on every mechanic. If code and doc disagree, the doc wins.
- **Contributing & the four invariants:** [`CONTRIBUTING.md`](CONTRIBUTING.md) — read
  before writing anything.
- **Operating the project:** [`CLAUDE.md`](CLAUDE.md) — deployment, environments, and the
  shared instructions for coding agents, including the rules that are not negotiable.
- **Architecture decisions:** [`docs/adr/`](docs/adr/)
- **Authorization boundary:** [`docs/authorization-matrix.md`](docs/authorization-matrix.md)
- **Feature contracts:** [`docs/aircraft-acquisition.md`](docs/aircraft-acquisition.md) ·
  [`docs/world-renderer.md`](docs/world-renderer.md)
- **Deployment & DNS:** [`docs/deploy.md`](docs/deploy.md) ·
  [`deploy/README.md`](deploy/README.md)
- **Roadmap:** [GitHub milestones](https://github.com/simmeh024/tailfinsim/milestones) are
  the live source for feature and cross-cutting work. Counts and track lists are not copied
  here because they change whenever the roadmap does.

## Quick start

Requires Node (version pinned in [`.nvmrc`](.nvmrc)) and pnpm.

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs typecheck, lint, formatting, the production build, coverage tests and an
indicative performance pass in CI's cheap-fails-first order. It prints what passed and what
was skipped; CI remains authoritative for the protected merge checks. Its typecheck stage
also emits the declaration files that packages resolve each other through.

**The database-backed tests skip without `DATABASE_URL`**, and `pnpm verify` says so in its
summary rather than folding that gap into a pass. They are destructive by design and refuse
to run against any database whose name does not end in `_test` or `_ci`; the verifier also
distinguishes a refused URL from a disposable database it cannot reach.

## Layout

```
packages/
  shared/   types and zod schemas          — depends on nothing
  sim/      pure deterministic simulation  — depends on shared only
  server/   Fastify web + Worker, database  — depends on shared, sim
  web/      React client and admin console  — depends on shared only
docs/
  adr/      architecture decision records
deploy/     server runbook, systemd units, Caddy, backups
```

The dependency directions above are enforced by lint, not convention. `packages/sim` may
not import `server`, `web` or any `node:*` builtin; `packages/web` may not import `sim`.
Both rules exist so the simulation stays deterministic and the server stays authoritative
— see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## What runs on a pull request

| Check                     | Asks                                                 | Blocks?                         |
| ------------------------- | ---------------------------------------------------- | ------------------------------- |
| `typecheck · lint · test` | Do builds, tests and the running Caddy policy pass?  | **Yes**                         |
| `dependency review`       | Did this PR add a known-vulnerable dependency?       | **High/critical advisories**    |
| CodeQL `analyze (…)`      | Does Tailfin's own code contain a dangerous pattern? | **Error or high/critical only** |

`main` is protected and required approvals are zero — the pull request is the gate, not a
second person. CodeQL's measured thresholds and baseline decisions are recorded in
[ADR-0013](docs/adr/0013-codeql-merge-policy.md).

## Status

Pre-MVP, and pre-launch. The list below describes what is in the current repository; the
[live milestone list](https://github.com/simmeh024/tailfinsim/milestones) owns sequencing and
completion status. The public site still serves a holding page: promoting the client is one
environment variable (`WEB_SURFACE`) plus a deploy, not a different build.

### What exists

- **The world clock.** `epoch + speed × (now − launch_date)`, derived and never stored, so
  a reset is two columns and offline progression is free (ADR-0005).
- **Airport data.** ~86,000 aerodromes imported from OurAirports, tiered, with catchment
  and a packed great-circle distance matrix.
- **Flight mechanics, as pure functions.** State machine with its failure branches, phase
  timeline, position interpolation along a great circle, and reachability and
  payload/range checks that name the limit that bound them.
- **A flight's economics.** Block time, phase-integrated fuel burn, a world fuel price
  curve, turnaround, and settlement into an itemised `flight_result` when the aircraft
  lands — reconciled to the design doc's own published P&L to within a percent.
- **Rotations and schedules** that survive a restart and an edit, and refuse the ones that
  assume an aeroplane can be in two places at once.
- **Disruption and weather.** Seeded per world and per flight so a replay reproduces them
  exactly, with climatological weather feeding delays, cancellations, diversions and
  de-icing.
- **Demand pools.** Appendix A.2's gravity model, sized for every viable city pair and
  split into business, leisure and VFR.
- **Accounts.** Google OAuth, database-backed sessions, atomic login rotation, immediate
  per-player revocation, shorter admin lifetimes, admin grants, and an append-only audit log
  the database itself refuses to let anyone edit ([ADR-0015](docs/adr/0015-session-lifecycle.md)).
- **One authorization error contract.** A missing session is 401, a signed-in actor without
  a disclosed grant is 403, and a malformed, missing or cross-owner private resource is the
  same 404. Ownership is resolved inside the query so player endpoints cannot become
  object-existence oracles
  ([ADR-0020](docs/adr/0020-http-authorization-and-concealment.md)).
- **A repository-specific threat model.** Security work prioritises the persistent world's
  integrity, then the identities and control paths that can change it. The model records the
  deployed web, worker, database, SSH and provider boundaries, attackers, ordinary operator
  mistakes and explicit non-goals
  in [ADR-0012](docs/adr/0012-tailfin-threat-model.md).
- **A browser security boundary at Caddy.** CSP restricts code, connections and framing;
  powerful unused browser features are denied; Google avatars have one narrow image-source
  exception. The edge rollout was observed in report-only mode before enforcement, both live
  hosts now pass the enforced-policy verifier, and HSTS preload is deliberately deferred
  ([ADR-0014](docs/adr/0014-browser-security-policy.md)).
- **Recoverable off-box backups.** Nightly DreamObjects dumps and their checksums are restored
  repeatably into a guarded `_test` database, migrated, booted and checked against real domain
  data and the world clock, with observed recovery time and up-to-24-hour data loss stated in
  the [server runbook](deploy/README.md#restoring).
- **Known migration failure states.** PostgreSQL applies the complete pending migration batch
  atomically; future SQL is checked for expand/contract compatibility with the previous
  release, and a verified local dump gates every non-empty deploy batch. A failure reports
  rolled back, all applied, or unknown instead of implying that failed code means unchanged
  schema ([ADR-0016](docs/adr/0016-migration-failure-strategy.md)).
- **Airline founding.** An authenticated player can found one airline in an open world,
  choosing its identity, base country and first hub. Ownership, config-backed opening
  cash, initial reputation and the free hub commit together or not at all; database
  constraints arbitrate code collisions and return the submitted code in the refusal. The
  no-menu `/found` desk reads those starting terms from the server, searches real tiered
  airports, warns without blocking an ambitious flagship choice, offers taken-code
  alternatives inline, and lands a successful founder on the network page.
- **A versioned airline starting position.** Worlds pin an immutable, runtime-validated
  economy version that supplies opening cash and the free-hub allowance to founding.
  Unknown versions are refused when a world is created rather than when its first player
  arrives ([ADR-0008](docs/adr/0008-versioned-airline-starting-position.md)).
- **Explainable airline cash.** Every game-balance change records its amount, cause,
  reference, game time and resulting balance in the transaction that caused it. Database
  constraints make cause replay idempotent and refuse any balance that does not equal the
  movement fold ([ADR-0011](docs/adr/0011-explainable-airline-cash.md)).
- **Race-safe airline code allocation.** Founding allocates IATA and ICAO designators
  through the per-world unique constraints. An advisory checker and constraint refusals
  offer deterministic, name-derived alternatives without leaking unowned reservations
  ([ADR-0009](docs/adr/0009-airline-code-allocation.md)).
- **One player-airline context boundary.** Player operations resolve ownership from the
  authenticated session and active world before a handler runs, then query only inside that
  airline. A world is selected explicitly when several are possible; no-airline and
  ambiguous-world states have stable responses shared by every guarded endpoint
  ([ADR-0010](docs/adr/0010-player-airline-context.md)).
- **Airline identity guardrails.** One shared schema gives Unicode display names and
  operational callsigns/codes explicit rules, with field-level failures. A permissive
  moderation interface sits on both founding and an audited admin force-rename remedy;
  the stable airline id keeps its network and history attached through a rename
  ([ADR-0007](docs/adr/0007-airline-identity-and-history.md)).
- **A private airline record and paid rebrands.** The owner can read current identity,
  stable codes, cash and reputation from one typed endpoint; having no airline is a normal
  discovery result. Players may change the validated name, callsign and base country for a
  versioned price, while codes, cash and reputation remain immutable inputs. The event,
  identity and reconciling cash movement commit atomically
  ([ADR-0017](docs/adr/0017-player-airline-rebrands.md)).
- **A retained airline lifecycle.** Active airlines can make new commitments; restricted
  airlines remain recoverable and may operate what already exists; ceased airlines become
  read-only history. Cessation deactivates instructions but preserves flights, results and
  audit readability, releases designators from the live per-world namespace, and excludes
  the record from live caps and rankings. Player anonymisation removes sign-in authority
  while keeping that world history intact
  ([ADR-0018](docs/adr/0018-airline-lifecycle-and-code-release.md)).
- **Three atomic aircraft acquisition paths.** Active airlines can lease an immediately
  available aircraft for a two-month deposit, buy a persisted used listing with its prior
  configuration intact, or pay for a factory build whose pinned options extend a wall-clock
  delivery date. The order, used-listing claim, explaining cash movement and any immediate
  airframe commit together; the Worker materialises due new orders exactly once. The typed
  API and the M4-05/M4-07 ownership boundary are documented in
  [`docs/aircraft-acquisition.md`](docs/aircraft-acquisition.md).
- **One founded-airline database fixture.** Server tests that need a player airline go
  through the real founding transaction, so they receive an open world, owner, founder hub,
  allocated per-world codes and configured opening cash with its AIR-06 movement. The
  harness cleans only the row identities it created; no fixture truncates shared tables.
- **One authorization test harness.** Server route tests receive deterministic guest,
  playerA, playerB and admin identities with real session cookies, declare all expected HTTP
  statuses in one case, and clean only their own players. The Vitest setup also refuses every
  configured database whose name does not end in `_test` or `_ci`.
- **The admin console**, at `/admin` for accounts holding a grant: an overview with
  server-decided alerts, world creation, speed changes, the full open/lock/archive/reset
  lifecycle, world health, a read-only player browser, linkable airline support records
  with current and historical routes and the complete paginated AIR-06 cash-movement
  ledger, and the audit log. The airline record has no balance-edit control.
- **One world renderer in two projections.** The player shell uses one deck.gl layer stack
  for a repeating flat map and a 3D globe, with a persisted device-aware default, shared
  camera and layer controls, bundled Natural Earth land, soft day/night shading,
  antimeridian-safe great-circle routes, and sustained-FPS degradation. Its contract and
  performance policy are documented in [`docs/world-renderer.md`](docs/world-renderer.md).

### What does not exist yet

- **No production worker or complete flight-event lifecycle.** The dev simulation runs in
  `dist/worker.js`, separated from the web process by ADR-0019, but production has no worker.
  The Worker currently handles `FLIGHT_ARRIVE` plus M4-04's real-time factory-delivery sweep;
  event types without a handler are parked as `unsupported` rather than destroyed. The exact live topology is maintained in
  [`CLAUDE.md`](CLAUDE.md#the-two-environments-on-three-nodes).
- **No fleet-management UI, crew or cabin management.** Orders and physical airframes now
  exist behind the typed fleet API, but the Fleet page still exposes only the world's
  era-gated catalogue; M4-07 owns listing those airframes, hours and cycles. M4-05 still owns
  rolling used-market generation and depreciation, M4-06 owns maintenance, and crew, ground
  handling, livery and cabin builders remain future work.
- **Most of the player client.** The standalone founding desk, private airline/rebrand desk,
  network/fare pages, aircraft catalogue, and dual-projection world surface are real. The
  world does not yet receive live aircraft/route data; finance, crew, design and board remain
  labelled placeholders, and the guided ninety-minute onboarding is still M10-01. The
  production front door still serves a holding page.

### Where it runs

The canonical live node, service, database and deploy-command table is
[`CLAUDE.md`'s operational topology](CLAUDE.md#the-two-environments-on-three-nodes). It is
kept in one place so README does not become a second, stale topology after the next OPS
change. The deployment reasoning is in [`docs/deploy.md`](docs/deploy.md), and the exact
operator procedures are in [`deploy/README.md`](deploy/README.md).

**Merging does not deploy anything.** Production moves only when somebody runs
`./deploy/deploy.sh` on the server, which is ADR-0003's deliberate choice and was
re-affirmed by [OPS-06](https://github.com/simmeh024/tailfinsim/issues/174): merge means
_staged_, and a human promotes.

To see where things actually are, from anywhere and without an SSH session:

```bash
pnpm ops:status
```

## Licence

**Code: [AGPL-3.0-only](LICENSE). Documentation: reserved ([`docs/LICENSE`](docs/LICENSE)).**

Copyright (C) 2026 Tailfinsim.

Tailfin is source-available and copyleft. You may read, run, fork and modify the
code, and if you run a modified Tailfin as a service you have to offer your
users its source — that is the AGPL's §13, and it is the reason this licence
rather than the GPL. Tailfin is a hosted persistent world that nobody downloads,
so plain GPL copyleft would essentially never trigger and a closed hosted fork
would be permitted. The AGPL is what closes that.

`docs/` is not covered. The design document and the ADRs are reserved, and that
is deliberate: a fork inherits the simulation, not the appendices that explain
why it behaves as it does.

Third-party terms — dependencies, the public-domain OurAirports dataset, and the
position on manufacturer names — are recorded in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). No dependency is copyleft
and none is licence-incompatible.
