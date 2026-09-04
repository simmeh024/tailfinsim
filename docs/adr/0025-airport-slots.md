# ADR-0025: Airport slots

- **Status:** Accepted
- **Date:** 2026-09-04
- **Deciders:** @simmeh024
- **Constrains:** M7-05 and everything downstream of it — slot trading (→ MARKET), slot
  seasonality and use-it-or-lose-it (→ SEASON), incumbency/reputation priority, and any NPC slot
  consumption

## Context

The design doc calls slots "the scarce resource of the shared world — held, traded, and lost
through underuse", and reachability's seventh check has always been the slot gate. But every piece
around it was a placeholder: `open-route.ts` passed `hasSlot: true`, `schedule/store.ts` read a
`context.slots` array nobody populated, and the only real fact on the airport was `slot_level` (the
IATA designation, 1/2/3/null, set by classification). There was no model of _holding_ a slot, so the
gate never fired.

M7-05 is the first cut. The milestone map explicitly defers slot **trading** to MARKET and slot
**seasonality** / use-it-or-lose-it to SEASON, so this ADR is deliberately about the smallest model
that makes the scarcity real and enforceable without pulling those in.

## Decision

### 1. A slot is a per-band operating right, held per airline

A `slot_holding` row is one airline's standing right to operate **departures** at one coordinated
airport in one **hourly band** (0–23, `floor(departureMinute / 60)` — `bandOf` in `@tailfin/sim`).
One row covers _every_ departure the airline flies in that band; it is not a per-movement token.
Per-movement counting would force schedule authoring to allocate specific held slots to specific
legs, which is an assignment problem the first cut does not need to create scarcity — holding the
band is enough of a decision.

### 2. Only Level 3 airports require a slot

`slot_level = 3` (coordinated) is the only level a held slot is mandatory at. Levels 1 and 2 and
uncoordinated airports are free: `resolveLegSlots` returns `true` for them, so nothing there is ever
refused. Classification already makes flagship and large tiers Level 3 (minus the US-heavy
`slot-levels.csv` overrides), so the gate bites at exactly the airports where scarcity is
interesting.

### 3. Capacity is a structural airport attribute, not economy config

A coordinated band takes a finite number of **holders**, by tier (flagship harder than large, with a
fallback for any airport an override forces to Level 3). This is a scarcity attribute of the airport
like its runway or its slot level — it prices nothing and a world would never retune it independently
of the catalogue — so it is a documented constant in the server, deliberately **not** an
`EconomyConfig` coefficient. If it ever needs per-world tuning it can move, but a balance payload is
the wrong home for it today, and putting it there would drag the immutable-version machinery into a
number that is really geography.

### 4. Free to hold; enforcement is at scheduling, not route-opening

Claiming a slot is free and first-come up to capacity; the per-movement airport charge already flows
through settlement's `airport_slot` ledger category, and a recurring holding fee would need a worker
to bill it (which §"Costs" puts later). The gate lives at **schedule authoring**, where a real
departure time — and therefore a band — exists. Opening a route is never slot-gated: a route is not a
movement, and gating it would ask for a slot before the player has chosen a time.

### 5. No worker, and no retroactive grounding

Holdings are standing state: nothing expires, drifts or bills on a tick, so the slot system works
identically on a world with no worker (unlike almost everything else in the network engine). The
gate is consulted only when a player **authors or edits** a schedule over HTTP. The worker's
`FLIGHT_DEPART` dispatch gate checks crew, not reachability, so turning enforcement on does not
re-validate and ground flights that were already materialised. NPC scheduling does not pass through
this authoring path, so NPCs are unaffected in this cut — their slot consumption, and the shared-world
scarcity that follows from it, is future work.

## Consequences

- A player scheduling a departure from a coordinated airport in a band they do not hold is refused
  with `no_slot` and the exact band, and must claim the slot first (`POST /api/airports/:icao/slots/:band`).
- Slots are addressed in the **context of the airport** (`/api/airports/:icao/slots`), because that is
  what they belong to. `:icao` is a public identifier and `:band` a public selector; ownership lives
  in the holdings, resolved from the session.
- The scarcity is currently only among players, and only bites once enough of them compete for a
  band. Making it a true shared-world constraint needs NPC consumption; making a held slot something
  you can lose needs use-it-or-lose-it; trading needs MARKET. All three are deliberately out of scope
  here and gated behind their own milestones.
