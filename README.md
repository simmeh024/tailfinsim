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
- **Backlog:** 162 issues across 18 milestones — `M0`–`M15` for the game, `M1A` for the
  admin console core, and `OPS` for delivery and operations.

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

## Status

Pre-MVP, and pre-launch. **M0 · Foundations** and **M1 · World, Time & Airport Data** are
complete, as is **M1A · Admin Console Core**. The public site still serves a holding page:
promoting the client is one environment variable (`WEB_SURFACE`) plus a deploy, not a
different build.

### What exists

- **The world clock.** `epoch + speed × (now − launch_date)`, derived and never stored, so
  a reset is two columns and offline progression is free (ADR-0005).
- **Airport data.** ~86,000 aerodromes imported from OurAirports, tiered, with catchment
  and a packed great-circle distance matrix.
- **Flight mechanics, as pure functions.** State machine with its failure branches, phase
  timeline, and position interpolation along a great circle.
- **Accounts.** Google OAuth, database-backed sessions, admin grants, and an append-only
  audit log the database itself refuses to let anyone edit.
- **The admin console**, at `/admin` for accounts holding a grant: an overview with
  server-decided alerts, world creation, speed changes, the full open/lock/archive/reset
  lifecycle, world health, a read-only player browser, and the audit log.

### What does not exist yet

- **Nothing runs the simulation.** The tick loop and the event queue are built and tested,
  and no process calls them — see [#187](https://github.com/simmeh024/tailfinsim/issues/187),
  which decides where the engine lives before it has a home. The console reports this
  honestly rather than showing a healthy-looking zero.
- **No flights, aircraft, demand or economy.** Those are M2 onward.

### Where it runs

One DreamCompute instance hosts both environments: `tailfinsim.com` (production, holding
page) and `dev.tailfinsim.com` (the preview environment, which deliberately runs unmerged
branches). Splitting those onto dedicated web and worker nodes is planned in
[OPS-08 – OPS-16](https://github.com/simmeh024/tailfinsim/issues/195).

**Merging does not deploy anything.** Production moves only when somebody runs
`./deploy/deploy.sh` on the server, which is ADR-0003's deliberate choice.
