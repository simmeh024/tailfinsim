# ADR-0002: Pin TypeScript to 6.0.x, not 7.x

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** @simmeh024

## Context

At the time of this decision, TypeScript 7 (the native Go port) was npm's `latest` at 7.0.2
and was substantially faster than the JavaScript compiler — attractive for a monorepo with
project references and a CI budget of under four minutes (M0-03).

However, M0-02 requires an ESLint flat config with `@typescript-eslint` and, specifically,
`no-floating-promises` — a **type-aware** rule, which means typescript-eslint must be able
to drive the TypeScript compiler API.

At the time of writing, typescript-eslint's latest release (8.67.0) declares:

```
peerDependency typescript: ">=4.8.4 <6.1.0"
```

Installing TypeScript 7.0.2 alongside it produces an unmet peer dependency. There is no
stable typescript-eslint release supporting the 7.x native compiler yet.

## Decision

Pin TypeScript to `~6.0.3` — the newest stable release inside typescript-eslint's
supported range. The tilde range keeps us on 6.0.x so a future 6.1.0 cannot silently
break the peer constraint.

**Implementation drift recorded 2026-08-22:** `package.json` currently declares `^6.0.3`,
while `pnpm-lock.yaml` resolves 6.0.3 and typescript-eslint's peer range remains `<6.1.0`.
The installed toolchain therefore matches the decision, but the manifest does not encode its
tilde guard. Correct that in a deliberate dependency change; do not describe the caret as a
pin or let a routine documentation edit silently change the toolchain contract.

## Consequences

### What this makes easier

- Type-aware linting works, so `no-floating-promises` and `no-misused-promises` actually
  run. In a real-time server a dropped promise is a silently lost flight resolution, so
  these are the highest-value lint rules in the project.
- The architectural guard rules in `eslint.config.js` — sim purity and client
  non-authority — depend on the same type-aware machinery.

### What this makes harder

- We forgo the native compiler's build-speed improvement. This is not currently binding:
  `tsc -b` on the scaffold is fast, and the CI budget has ample headroom.

### What we accept

At adoption, being one major version behind npm's `latest` on the single most central tool
in the stack, in exchange for a working lint story. Type-aware linting is worth more than
compile speed at this repository size.

## Alternatives considered

| Option                                            | Why not                                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript 7 + drop type-aware lint               | Fails M0-02's explicit `no-floating-promises` requirement, and loses the architectural guards.                                    |
| TypeScript 7 + typescript-eslint canary           | `8.67.1-alpha.x` is prerelease; not a foundation to build 125 issues on.                                                          |
| TypeScript 5.9.3                                  | Works, but 6.0.3 is also within range and closer to 7's semantics, so the eventual migration is smaller.                          |
| Two TypeScript versions (7 for build, 6 for lint) | Aliasing two copies of the compiler in one workspace is a maintenance trap that would confuse every future contributor and agent. |

## Revisit when

typescript-eslint ships a stable release whose `typescript` peer range admits 7.x. At
that point the move should be a one-line version bump plus a CI run.
