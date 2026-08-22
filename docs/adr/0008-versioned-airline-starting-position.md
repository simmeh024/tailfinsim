# ADR-0008: Pin the airline starting position by economy version

- **Status:** Accepted
- **Date:** 2026-08-20
- **Amended:** 2026-08-22 — M3-11 implemented the database-backed version store, loader,
  admin create/diff/pin flow and rollback-by-repin described below.
- **Deciders:** @simmeh024
- **Constrains:** AIR-03, AIR-01, M3-11, M8-02, M11-03

## Context

The design gives a new airline 500,000 units of opening cash and one free hub at any tier.
Opening cash is a balance value and therefore cannot be a literal in the founding handler
or a database column default. The free-hub allowance must travel with the same starting
terms. A world already stores `economy_config_version`, but a version string only protects
comparability if the referenced payload is valid, immutable and known when the world is
created.

Reputation looks similar but is not the same kind of number. Section 15 defines 0.35 as the
starting point of the 0.00–1.00 reputation scale. Treating it as a tunable economy value
would imply that the meaning of the scale may change between worlds.

The design also writes the opening balance with a dollar sign while §24 deliberately leaves
currency unresolved for M8-02. AIR-03 must store money without settling that question.

## Decision

The shared `EconomyConfig` schema begins with an `airlineStartingPosition` object:

- `openingCashMinor` is a non-negative safe integer;
- `freeHubAllowance` is a non-negative integer; and
- `version` identifies the immutable payload.

The shipped `v1` payload grants 50,000,000 minor units and one free hub. “Minor units” is
deliberate: this is the design's 500,000 major units without claiming they are dollars,
euros or any other currency before M8-02.

Registered payloads are parsed at runtime and frozen. A change creates a new version; it
never mutates a version a world may already pin. AIR-08 added the first
`airlineIdentity.rebrandCostMinor` field to `v1` before any player rebrand operation existed;
ADR-0017 records that narrow compatibility extension and prohibits using it as precedent to
retune an already-defined field. World creation rejects an unknown economy
version at both the admin-validation boundary and the lifecycle service boundary. Founding
locks the world row, resolves its pinned version, and applies that version's opening cash
and hub grant in the same transaction as the airline. AIR-06 posts the opening cash through
the `airline_founding` movement rather than assigning `cash_minor` directly, so the first
balance a new airline sees is already explainable (ADR-0011).

The current founding flow selects and grants exactly one hub. A config whose allowance is
not exactly one fails explicitly instead of silently granting fewer hubs than it promises.
Supporting another allowance requires a founding flow that can consume and persist it.

Initial reputation remains the shared `INITIAL_AIRLINE_REPUTATION` constant and the
database default, with comments recording §15's reason. It is deliberately absent from
`EconomyConfig`.

Since M3-11, every payload is an immutable row in `economy_config`. Web startup inserts the
shipped seed only when absent and never overwrites a database version. The loader caches the
immutable payload by version while reading a world's pin fresh on every resolution, so Web
and Worker need no cross-process invalidation when an admin re-pins a world. The admin API can
create a version from a parent, review its diff, pin it transactionally with an audit row, and
roll back by pinning the previous immutable version again. M11-03 still owns the complete
economy editor and preview surface; AIR-03 established the founding semantics this storage
preserves.

## Consequences

### What this makes easier

- Every airline founded in one world receives the same starting terms even after a newer
  economy version exists.
- A misspelled or unavailable version is rejected before players enter the world.
- Founding has no duplicated opening-cash literal to drift from configuration.
- Opening cash, ownership and the founder hub either commit with one movement or all roll
  back together.
- The database loader validates every stored payload through the shared runtime schema and
  caches only immutable version rows.
- Paid rebrands resolve their visible and charged price from the same version the world
  already pins.

### What this makes harder

- Creating and pinning a new economy version needs no deploy; changing the payload schema or
  shipped seed remains a code change with backward-compatible defaults.
- Changing the number of founder hubs also requires extending the founding interaction;
  config alone cannot invent the missing player choices.
- The stored integer cannot yet be rendered with a currency symbol without resolving M8-02.
- A new economy field that changes an already-available result cannot be added to `v1`;
  it needs a new version even when every other value remains equal.

## Alternatives considered

| Option                                   | Why not                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Put 500,000 in the founding handler      | Violates the balance-in-config invariant and cannot be retuned or pinned.                                |
| Make `cash_minor` default to 50,000,000  | Gives every insert the founder grant, including imports, repairs and future non-founding creation paths. |
| Resolve an unknown version to the latest | Silently changes the terms of an already configured world and destroys reproducibility.                  |
| Put initial reputation in economy config | Section 15 defines 0.35 as part of the scale, not a balance lever.                                       |
| Call the opening balance USD             | Prejudges the currency decision assigned to M8-02.                                                       |

## Revisit when

- a world type intentionally grants zero or more than one founder hub; or
- M8-02 defines the accounting and display currency model.
