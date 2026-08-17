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

**4. No dead-end numbers.** §14.1 is explicit: every figure drills down to its cause.
Load factor → by route → by flight → by segment → the Appendix A waterfall showing
which competitor took the passengers and why. A number a player cannot interrogate is a
number they will not trust, and the entire demand model rests on that trust (§A.1). In
practice: when you compute a figure for display, carry its decomposition with it rather
than recomputing or discarding it.

---

## Getting set up

```bash
pnpm install
pnpm typecheck
pnpm test
```

Node version is pinned in `.nvmrc`; pnpm version in `package.json`'s `packageManager`.

> **First run:** `pnpm typecheck` also emits the `.d.ts` files that packages resolve each
> other through. Until it has run once, your editor will report unresolved
> `@tailfin/*` imports. This is expected — run it once after cloning.

### Commands

| Command              | What it does                                     |
| -------------------- | ------------------------------------------------ |
| `pnpm typecheck`     | `tsc -b` across all project references           |
| `pnpm lint`          | ESLint, including the architectural guards above |
| `pnpm format`        | Prettier write                                   |
| `pnpm test`          | Vitest across all packages                       |
| `pnpm test:coverage` | Adds coverage; thresholds enforced for `sim`     |
| `pnpm clean`         | Removes build info and emitted declarations      |

CI runs typecheck, lint, format check and coverage on every PR.

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

The database is created with `--locale=C`. Postgres sorts differently under different
host locales, and ordering must not depend on a developer's OS language settings.

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

## Working style

- **TypeScript is the typechecker, not the compiler.** `moduleResolution: bundler` means
  runtime artefacts come from Vite (web) and esbuild (server). `tsc -b` emits
  declarations only.
- **Migrations are committed as SQL**, never generated at runtime (M0-05).
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
