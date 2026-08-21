# ADR-0017: Read the private airline and rebrand mutable identity fields atomically

- **Status:** Accepted
- **Date:** 2026-08-21
- **Deciders:** @simmeh024
- **Constrains:** AIR-08, AIR-09, M8-01, M11-06

## Context

The signed-in player needs one private view of their airline, including cash and
reputation, without exposing those values through the future public profile. A player who
has not founded an airline must be able to discover that state without treating it as a
failed operation.

Section 15 also makes rebranding a paid event, while ADR-0007 deliberately left the exact
player mutation boundary and price to AIR-08. Airline codes are scarce per-world resources
whose release lifecycle is now defined by ADR-0018. Cash and reputation are game
state, not identity form inputs.

## Decision

### One private discovery response

`GET /api/airlines/me` resolves the authenticated player and active world using ADR-0010's
rules, then returns the complete private airline projection. Cash and reputation are
included because the subject is the owner. If the player has no airline in the selected
world, the successful response contains `airline: null` and `rebrand: null`; that expected
onboarding state is not a 404 or an `airline_required` refusal. An omitted active world is
still refused when several owned airlines make the choice ambiguous.

This nullable discovery endpoint is the narrow exception to guarded operational endpoints.
Mutations use ADR-0018's active-airline guard and its stable context errors.

### Rebrands have a deliberately small input

`PATCH /api/airlines/me` is a strict full replacement of the three ordinary mutable
identity fields:

- `name`;
- `callsign`; and
- `baseCountry`.

The shared AIR-02 validation and moderation boundary applies to the submitted identity.
Unknown properties are rejected, so a client cannot submit `cashMinor`, `reputation`,
`iataCode` or `icaoCode` and rely on the server to ignore them. IATA and ICAO codes remain
stable while an airline is live. ADR-0018 releases them only when the airline becomes
terminally ceased; the historical row retains the values.

The response names which fields are mutable and immutable so the client does not infer
permission from the fields it can read.

### The price belongs to the pinned world economy

Economy `v1` defines `airlineIdentity.rebrandCostMinor` as 2,500,000 minor units: 25,000
major world-currency units, or five percent of the opening balance. The private read returns
that price before confirmation. A future price change creates a new economy version.

This is a one-time compatibility extension to `v1`: before AIR-08 no released operation
could consume a rebrand price, so the new field changes no result that an existing world
could previously produce. It does make the newly introduced AIR-08 operation reproducible
from the version every existing world already pins. Further changes to any defined `v1`
field are prohibited by ADR-0008's immutability rule.

### Event, identity and cash commit together

A changed identity is one transaction that:

1. locks the current airline;
2. validates and moderates the requested identity;
3. records an immutable `airline_identity_change` event with the before and after values;
4. updates the current airline row; and
5. posts the negative price through `moveAirlineCash` as `airline_rebrand`, referencing the
   identity-change event.

If any step fails, neither the identity, event nor balance changes. The existing cash
ledger serialises concurrent balance mutations and preserves reconciliation. Resubmitting
the exact current identity is a no-op: it records no event and charges nothing.

Historical operations continue to resolve to the current identity as decided by ADR-0007.
The change event preserves the identity timeline for a later public history surface without
copying display metadata into every flight.

## Consequences

### What this makes easier

- The client has one typed private source for current identity, codes, balance and
  reputation.
- Absence is a normal onboarding state while operational routes retain one strict guard.
- Cash, reputation and scarce codes cannot be changed through over-posting.
- Every paid rename is explainable as both a durable identity event and a reconciling cash
  movement.
- A world's pinned economy version determines the price shown and charged.

### What this makes harder

- Rebrands are unavailable while an airline is restricted or ceased (ADR-0018).
- Adding the first consumer of a previously undefined economy field required documenting a
  narrow compatibility exception for existing `v1` worlds.
- A player with several airlines still needs to supply the active-world header.

## Alternatives considered

| Option                                    | Why not                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Return 404 when the player has no airline | Absence is an expected pre-founding state, not a missing public resource.                         |
| Reuse the admin force-rename route        | It bypasses the player price and records a moderation action with the wrong actor and reason.     |
| Allow codes in the same form              | Replacement would release or strand scarce world resources outside ADR-0018's terminal lifecycle. |
| Accept cash or reputation and ignore them | Silent over-posting makes an authorization mistake look successful.                               |
| Charge without a domain event             | The ledger would explain the money but not which identity the payment bought.                     |
| Make the price a handler literal          | Existing worlds would not pin the terms of an operation available inside them.                    |

## Revisit when

- a later milestone permits a live airline to replace either code;
- M8-02 defines the accounting and display currency;
- M3-11 moves economy payloads to live versioned storage; or
- a public history surface needs to present the identity timeline.
