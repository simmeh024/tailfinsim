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
- **Architecture decisions:** [`docs/adr/`](docs/adr/)
- **Deployment & DNS:** [`docs/deploy.md`](docs/deploy.md)
- **Backlog:** 125 issues across milestones M0 → M13.

## Quick start

Requires Node (version pinned in [`.nvmrc`](.nvmrc)) and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
```

`pnpm typecheck` emits the declaration files that packages resolve each other through, so
run it once after cloning or your editor will report unresolved `@tailfin/*` imports.

## Layout

```
packages/
  shared/   types and zod schemas          — depends on nothing
  sim/      pure deterministic simulation  — depends on shared only
  server/   Fastify API, clock, tick loop  — depends on shared, sim
  web/      React client                   — depends on shared only
docs/
  adr/      architecture decision records
```

The dependency directions above are enforced by lint, not convention. `packages/sim` may
not import `server`, `web` or any `node:*` builtin; `packages/web` may not import `sim`.
Both rules exist so the simulation stays deterministic and the server stays authoritative
— see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

Pre-MVP. M0 · Foundations is in progress; no game logic exists yet.
