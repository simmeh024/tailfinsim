# ADR-0025: Airport slots

- **Status:** Accepted
- **Date:** 2026-09-04
- **Deciders:** @simmeh024
- **Constrains:** M7-05 and everything downstream of it — slot trading (→ MARKET), slot
  seasonality and use-it-or-lose-it (→ SEASON), incumbency/reputation priority, and any NPC slot
  consumption
- **Note:** this ADR keeps 0025. The CSRF decision was also filed as ADR-0025 a day later and has
  been renumbered to [ADR-0027](0027-no-csrf-token.md). A reference to "ADR-0025" in a commit,
  issue or pull request written between 2026-09-05 and the renumber may mean either — read the
  surrounding subject rather than the number.

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

---

## Amendment, 2026-09-08: peak shaping and release waves

**Status:** Accepted. Extends this ADR; reverses nothing in it.

The first cut above made slots _holdable_. It did not make them _obtainable_, and M7-05 (#70) has
two acceptance criteria that turn on obtainability:

> A new player joining a mature world can still obtain off-peak slots at a Level 3 airport.
> Slot holdings are visible per airport for all airlines.

Neither was met. A flat capacity across all 24 hours meant a mature world was uniformly full or
uniformly empty, and the read model returned a count with no attribution.

### 6. Capacity is shaped by hour, not flat across the day

A coordinated airport's base capacity is multiplied by how contested the hour is: **peak** (06–09,
16–19) × 0.5, **shoulder** × 1, **off-peak** (22–05) × 1.75. A flagship therefore runs 4 holders at
08:00 and 14 at 03:00.

This is not decoration. App. B.5 already states the intended experience — _"slot scarcity is brutal
at Level 3 airports — as a new entrant at LHR you get 05:40 and 23:10, and nothing else"_ — and a
flat capacity cannot produce it. Under a flat model the newcomer finds either room everywhere or
room nowhere, and the design's central slot bargain (a bad slot is available, a good one is not)
does not exist. The shape is what makes the first acceptance criterion true rather than aspirational.

### 7. Capacity is released in waves, measured in game days since the world's epoch

§21's third open question is the reason:

> _"Slot allocation at world launch: first-come-first-served creates a permanent land grab.
> Consider scheduled slot release waves."_

Waves: **50% at world launch, 75% at game day 30, 100% at game day 90**, as a cumulative fraction of
every band's shaped capacity. A founding cohort cannot take the whole board on opening day, and an
airline founded a game quarter later still meets unallocated capacity rather than a carve-up.

Fractions rather than absolute counts, because capacity already varies by tier and by hour; a wave
is _"a quarter of everything opens now"_, which stays true at a flagship's 08:00 and a regional's
03:00 alike.

Like the per-band capacity in decision 3, the schedule is a **documented server constant, not an
`EconomyConfig` coefficient** — for the same reason, and it is worth restating because it is a
slightly different one. Capacity is geography; a wave schedule is an allocation-fairness rule.
Neither prices anything, and putting either in the balance payload would drag the immutable-version
machinery into a number that is not balance.

### 8. A wave adds; it never revokes

`released` can be **lower than `held`** — on a world whose slots were claimed before waves existed,
or if the schedule is ever retuned downward. The read model reports `max(released − held, 0)` as
available and takes nothing away. Decision 5's _"no retroactive grounding"_ is preserved exactly: no
holding is withdrawn, no materialised flight is re-validated, and nothing is grounded.

### 9. Still no worker, and that is why waves are computed rather than stored

A wave is a pure function of the world clock read at request time. Nothing has to fire on game day
30 for the capacity to appear — the next read simply sees more.

This was the deciding factor in choosing computed waves over scheduled ones. A wave that had to be
materialised by a job would have made slots the fifth subsystem that silently does nothing on a
production world (CLAUDE.md lists the other four), and the failure would have been invisible: a
board that stays half-open for ever looks exactly like a board where nobody has claimed anything.

### 10. Holdings are attributed, not merely counted

Each band lists the airlines holding it — id, name, IATA code, and whether it is you. Identity only:
name and codes are already public on every competing airline, and nothing commercial is disclosed.

Slots are _"the scarce resource of the shared world — held, traded, and lost"_ (§8.1), and a scarce
resource you cannot attribute is just a closed door. It is also the read that MARKET's slot trading
will need: you cannot open negotiations with a holder you cannot see.

### What this amendment still does not do

Unchanged from the original: **use-it-or-lose-it** remains SEASON-09's (#1046), **trading** remains
MARKET's, and **NPC slot consumption** remains future work. The waves make a slot obtainable; they
do not make a held one losable, and M7-05's second acceptance criterion — _"underused slots are
reclaimed and returned to the pool"_ — is deliberately left to SEASON-09 rather than duplicated here.
