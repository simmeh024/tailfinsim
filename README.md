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
  rules that are not negotiable.
- **Architecture decisions:** [`docs/adr/`](docs/adr/)
- **Deployment & DNS:** [`docs/deploy.md`](docs/deploy.md) · [`deploy/README.md`](deploy/README.md)
- **Backlog:** 273 issues across 23 milestones. `M0`–`M15` are the game, `M1A` the admin
  console core, and the rest are cross-cutting tracks that deliberately sit outside the
  feature sequence: `OPS` (delivery and operations), `SEC` and `SEC-HARD` (authorization
  and hardening), `AUTH`, `E2E` and `POD`.

## Quick start

Requires Node (version pinned in [`.nvmrc`](.nvmrc)) and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
```

`pnpm typecheck` emits the declaration files that packages resolve each other through, so
run it once after cloning or your editor will report unresolved `@tailfin/*` imports.

**The database-backed tests skip without `DATABASE_URL`**, and they are a large share of
the server suite. A green local run says much less than it looks like for server work —
CI is where those run. They are also destructive by design and refuse to run against any
database whose name does not end in `_test` or `_ci`.

## Layout

```
packages/
  shared/   types and zod schemas          — depends on nothing
  sim/      pure deterministic simulation  — depends on shared only
  server/   Fastify API, clock, event queue — depends on shared, sim
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

| Check                     | Asks                                                 | Blocks? |
| ------------------------- | ---------------------------------------------------- | ------- |
| `typecheck · lint · test` | Does it build, lint, format and pass its tests?      | **Yes** |
| `dependency review`       | Did this PR add a known-vulnerable dependency?       | **Yes** |
| `analyze (…)`             | Does Tailfin's own code contain a dangerous pattern? | No      |

`main` is protected and required approvals are zero — the pull request is the gate, not a
second person.

## Status

Pre-MVP, and pre-launch. **M0 · Foundations**, **M1 · World, Time & Airport Data**,
**M1A · Admin Console Core** and **M2 · Flight Operations** are complete, and
**M3 · Demand & Commercial** has begun. The public site still serves a holding page:
promoting the client is one environment variable (`WEB_SURFACE`) plus a deploy, not a
different build.

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
- **Accounts.** Google OAuth, database-backed sessions, admin grants, and an append-only
  audit log the database itself refuses to let anyone edit.
- **Airline founding.** An authenticated player can found one airline in an open world,
  choosing its identity, base country and first hub. Ownership, config-backed opening
  cash, initial reputation and the free hub commit together or not at all; database
  constraints arbitrate code collisions and return the submitted code in the refusal.
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
- **The admin console**, at `/admin` for accounts holding a grant: an overview with
  server-decided alerts, world creation, speed changes, the full open/lock/archive/reset
  lifecycle, world health, a read-only player browser, and the audit log.

### What does not exist yet

- **Nothing runs the simulation.** The tick loop and the event queue are built and tested,
  and no process calls them — see [#187](https://github.com/simmeh024/tailfinsim/issues/187),
  which decides where the engine lives before it has a home. The console reports this
  honestly rather than showing a healthy-looking zero. Everything above is therefore
  machinery that works and is not yet being driven.
- **No fleet, crew or cabin.** Aircraft are a `uuid` with no catalogue behind it (M4),
  crew and ground handling are inputs the models take rather than systems (M5), and the
  livery and cabin builders are M6.
- **No player-facing client.** The founding API exists, but its guided screen and the
  rest of the game client are not built; the front door still serves a holding page.

### Where it runs

One DreamCompute instance hosts both environments: `tailfinsim.com` (production, holding
page) and `dev.tailfinsim.com` (the preview environment, which deliberately runs unmerged
branches). Splitting those onto dedicated web and worker nodes is planned in
[OPS-08 – OPS-16](https://github.com/simmeh024/tailfinsim/issues/195).

**Merging does not deploy anything.** Production moves only when somebody runs
`./deploy/deploy.sh` on the server, which is ADR-0003's deliberate choice and was
re-affirmed by [OPS-06](https://github.com/simmeh024/tailfinsim/issues/174): merge means
_staged_, and a human promotes.

To see where things actually are, from anywhere and without an SSH session:

```bash
pnpm ops:status
```
