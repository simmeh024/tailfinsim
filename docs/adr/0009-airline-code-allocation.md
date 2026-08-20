# ADR-0009: Allocate airline codes per world at founding

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** @simmeh024
- **Constrains:** AIR-04, AIR-01, M11-08, AIR-09, M10-01

## Context

An airline needs a two-character IATA designator and a three-letter ICAO designator.
Section 24 calls the roughly 1,300-code IATA namespace a design problem rather than a
support problem. The database already makes both codes unique per world, but a player who
discovers a collision during the first minutes of onboarding needs alternatives rather
than a bare refusal.

Availability and allocation are different facts. A code can be free when the founding form
checks it and taken by another transaction before submission. Reserving it while somebody
types would require expiring abandoned reservations and could exhaust the namespace with
no airline rows behind it.

M11-08 also left one policy question open: whether Tailfin reserves designators belonging
to real airlines. AIR-04 cannot generate safe alternatives without recording an answer.

## Decision

### Allocation authority

Codes are unique **per Tailfin world**. The existing
`airline_world_id_iata_code_key` and `airline_world_id_icao_code_key` constraints are the
authority. Founding inserts the airline and therefore allocates both codes inside the same
transaction as ownership, opening cash and the first hub. There is no separate reservation
row and no check-then-insert claim of safety.

When a constraint wins a race, the transaction rolls back and the server performs a fresh
lookup against the committed world. The refusal names the submitted code and includes three
alternatives that were free after the collision. They remain advisory: another founder may
still take one before the retry succeeds.

### Advisory checking

The authenticated founding form may call `POST /api/airlines/code-availability` with the
world, airline name and proposed codes. Every response carries these machine-readable facts:

- scope is `world`;
- reservation is `none`; and
- real-world codes are `allowed-if-free`.

It also says in plain language that only successful founding reserves a code. This wording
is part of the shared response contract so a future client cannot accidentally present the
check as a hold.

### Alternatives

Suggestions are deterministic and derived from the submitted airline name. Initials and
readable Latin letter combinations lead the ranking. Diacritics are folded for suggestions
only; the airline's Unicode display name is unchanged. A stable hash of the complete Unicode
name then walks the entire valid namespace in a coprime sequence. That fallback gives names
without a Latin transliteration deterministic suggestions and still finds the last free code
in a nearly full world.

Assigned, submitted and policy-reserved candidates are filtered out. The generator is pure;
the database lookup supplying the unavailable set remains server-side.

### Real-world designators

Real-world IATA and ICAO designators are **not globally reserved in MVP**. They may be used
if free in that Tailfin world. A correct reservation list would require authoritative,
versioned external data with acceptable licensing; a hand-maintained partial list would
silently become stale while further shrinking the scarce namespace. Tailfin records the rule
explicitly in the allocation policy and API rather than pretending no decision was made.

Airline-name and callsign moderation remain separate under ADR-0007. If product or legal
policy later requires a real-world registry, the allocator accepts an injected reservation
policy and filters it from both checks and suggestions without changing the transaction.

### Release

An airline row keeps its codes for its lifetime. AIR-09 decides what cessation means and
whether a code can be released without making historical references ambiguous. AIR-04 adds
no deletion or release path.

## Consequences

### What this makes easier

- A normal collision gives the player alternatives that resemble the name they chose.
- A concurrent collision has the same useful response instead of becoming a 500.
- No abandoned form can leak a scarce code.
- Every client can distinguish an advisory check from an atomic allocation.
- A later registry policy changes filtering, not storage or founding atomicity.

### What this makes harder

- An advisory suggestion may be taken before the player retries.
- A player may use a real-world designator until a different product/legal policy is adopted.
- Non-Latin names without a conventional Latin transliteration reach a deterministic hash
  fallback rather than a linguistically correct transliteration.
- Loading all assigned designators for a world is acceptable at the namespace's current
  bound but may need a more targeted query if the code model expands.

## Alternatives considered

| Option                                     | Why not                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Check availability and trust the result    | Races; only the unique insert can allocate safely.                                                      |
| Reserve while the player fills in the form | Leaks codes from abandoned forms and requires an expiry/reaper system.                                  |
| Return only “taken”                        | Turns namespace scarcity into an onboarding dead end.                                                   |
| Maintain a small list of famous airlines   | Partial protection is misleading and the list becomes stale.                                            |
| Reserve every alphabetic IATA combination  | Removes over half the already scarce namespace and still does not solve ICAO or alphanumeric operators. |
| Use random alternatives                    | Suggestions no longer feel related to the airline and retries are not reproducible.                     |

## Revisit when

- AIR-09 defines airline cessation and code release;
- product or legal policy supplies an authoritative real-world registry;
- a transliteration service is selected for player-facing search; or
- world scale makes loading the assigned namespace measurably expensive.
