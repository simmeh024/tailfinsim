# ADR-0001: TypeScript monorepo — pnpm, Fastify, Postgres, React

- **Status:** Accepted
- **Date:** 2026-08-17
- **Amended:** 2026-08-22 — ADR-0019 split the server package into Web and Worker
  processes without changing the selected stack or dependency graph.
- **Deciders:** @simmeh024

## Context

Tailfin is a single shared persistent world running a server-authoritative simulation at
2× real time, continuously, that never pauses (design doc §3.1, §21). The client is a
viewer and a command issuer.

That shape constrains the stack more than it might first appear:

- The server holds a **continuous tick loop** and long-lived WebSocket connections. It is
  a stateful, always-on process. Serverless request/response platforms are structurally
  wrong for it.
- The **sim must be deterministic and replayable** (M13-01/02/03), so the simulation core
  has to be isolatable from I/O and testable in-process.
- The livery and cabin builders are **SVG vector editors** in the browser (§21), and the
  world renderer needs WebGL with both a flat map and a globe projection (App. H.2).
- Livery documents are JSON, and the demand model config is versioned, live-editable data
  (§22.3) — so the datastore needs strong JSON support alongside relational integrity.
- One person is building this against a 125-issue backlog. Boring, well-documented
  technology with a large hiring and LLM-assistance surface is worth real points.

## Decision

A **TypeScript monorepo** managed by **pnpm workspaces** with TypeScript project
references, split into four packages:

| Package  | Role                                             | May depend on   |
| -------- | ------------------------------------------------ | --------------- |
| `shared` | types and zod schemas                            | —               |
| `sim`    | pure deterministic simulation                    | `shared`        |
| `server` | Fastify Web/API and Worker entry points, storage | `shared`, `sim` |
| `web`    | React + Vite client                              | `shared`        |

- **Fastify** for the server — fast, schema-first with JSON Schema validation that pairs
  naturally with zod, first-class TypeScript support, and a plugin model that keeps the
  admin console (§22) separable from the game API.
- **Postgres 16 + Drizzle ORM** for persistence — relational integrity for the economy
  ledger, `jsonb` for livery documents and versioned economy config, and Drizzle's
  SQL-first migrations committed as files rather than generated at runtime.
- **React + Vite** for the client, with **deck.gl** for the world renderer (M7-01) since
  it supports `MapView` and `GlobeView` over the same layer definitions — App. H.2 warns
  that retrofitting a globe onto a flat-map codebase is a rewrite.
- **Vitest** for tests, sharing Vite's transform pipeline.

One language across sim, server and client means the Appendix A demand model is written
once and the shared types genuinely are shared.

## Consequences

### What this makes easier

- The sim can be imported directly into tests and into the future replay harness with no
  process boundary or serialisation step.
- Shared zod schemas give one definition of every wire type, validated at the edge and
  inferred as TypeScript types everywhere (M0-07).
- Project references keep the sim's purity mechanically checkable — the dependency graph
  is declared, not assumed.

### What this makes harder

- Splitting Web and Worker processes does not make the stateful simulation or its Postgres
  queue scale horizontally for free. Sharding is listed as open design debt in §24 and is
  not solved here or by ADR-0019.
- Node is not the fastest option for a tick loop under load. The mitigation is
  architectural rather than linguistic: flight state is computed on read from departure
  time and route, not stored per tick (§21), and economic resolution happens at flight
  events only.

### What we accept

That we may have to extract the hottest part of the sim later. The purity invariant in
CONTRIBUTING.md exists partly so that remains possible.

## Alternatives considered

| Option                       | Why not                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Go or Rust server, TS client | Faster tick loop, but the demand model would be written and maintained twice, and the type contract between sim and client would be hand-synchronised. Too much friction for a solo build. |
| Serverless (Vercel/Lambda)   | Structurally incompatible with a continuous tick loop and long-lived WebSockets.                                                                                                           |
| MySQL                        | Weaker `jsonb` support; livery documents and versioned economy config both want it.                                                                                                        |
| Prisma instead of Drizzle    | Heavier runtime, and migration control matters here — M0-05 requires committed SQL.                                                                                                        |
| Nx or Turborepo              | Real value at larger team sizes; pnpm workspaces plus project references is enough today and has fewer moving parts.                                                                       |

## Revisit when

- The tick loop cannot hold its cadence at the target concurrent-world size under the
  load tests in M13-04.
- The current Web/Worker/Postgres topology blocks a milestone — at which point §24's sharding debt
  needs closing properly rather than incrementally.
