# Hubs

A hub is where an airline bases aircraft, holds gates and stations crew. Without one there
is no operation. This document is the current contract for M7-04 — purchase, the App. B.5
cost curve, the annual fee, and facilities — including the parts of App. B.5 that are
deliberately **not** built yet and why.

Design reference: `docs/tailfin-design-doc.md` App. B.5. Where this document and the design
doc disagree about current behaviour, this one describes what the code does; the design doc
describes what it is aiming at.

---

## The cost curve

```
HubCost = tierBaseMinor[tier] × costGrowth^(hubs_owned − 1)
```

The first hub is free at any tier. After that the price is the tier's base doubled for every
hub **already owned** — and the multiplier counts hubs owned, _not_ hubs of that tier. That is
the whole design: every cheap hub bought early makes every later flagship dearer.

| Hub # | Small | Medium | Large | Flagship |
| ----- | ----- | ------ | ----- | -------- |
| 1st   | free  | free   | free  | free     |
| 2nd   | $2M   | $5M    | $10M  | $25M     |
| 3rd   | $4M   | $10M   | $20M  | $50M     |
| 4th   | $8M   | $20M   | $40M  | $100M    |
| 5th   | $16M  | $40M   | $80M  | $200M    |
| 6th   | $32M  | $80M   | $160M | $400M    |
| 7th   | $64M  | $160M  | $320M | $800M    |
| 8th   | $128M | $320M  | $640M | $1.6B    |

Four flagships taken as hubs 2–5 cost **$375M**. Three small hubs first and then four
flagships cost **$14M + $3,000M** — $2.6 billion more for $14M of early convenience.
`packages/sim/src/economy/hub-cost.test.ts` checks every cell of that table and both
scenarios.

The coefficients are `EconomyConfig.hubs`, pinned per world. `packages/sim` holds no balance
literal; retuning is a new economy-config version, never an edit.

### Tiers: five airports, four prices

B.3 classifies airports into five tiers and App. B.5 prices four. A **regional** airport has
no band of its own and is sold at the `small` base — the cheapest band, for the least capable
airport. An airport with **no** tier (no scheduled service) cannot be a hub at all and is
refused with `422 airport_not_playable`.

The band is **pinned on the hub row at purchase** (`airline_hub.tier`), not re-read from the
airport. A reference-data refresh can reclassify an airport; it must not silently re-price a
hub somebody already owns.

`airline_hub.tier` is **nullable, and null means a hub granted before M7-04** — every existing
founder hub. Those read at their airport's current tier, which is the only answer available
and was true when the grant was made. Do not backfill it: a backfilled tier would be
indistinguishable from a pinned one.

---

## Buying a hub

`POST /api/hubs` with `{ airportIdent, expectedCostMinor }`.

`expectedCostMinor` is **required and enforced**, and it is not belt-and-braces. The price
depends on how many hubs the airline owns, so a quote is only correct until it buys something
else. Echoing the quoted figure back lets the server refuse a stale one with
`409 hub_cost_changed` and re-quote, which is what App. B.5's _"the player can see the
arithmetic before committing"_ has to mean when the arithmetic can move underneath the player.

The whole purchase is serialised on the airline with an advisory lock taken **before** the
hub count is read, so two concurrent purchases cannot both pay the third-hub price and leave
the airline with four hubs.

Money moves through AIR-06 in the same transaction as the hub row, with the movement's
reference being the new hub's id. A free hub gets a row and **no movement** — AIR-06 records
causes, and "nothing moved" is not one; the zero is explained by `purchase_cost_minor`.

Refusals, all of which change nothing:

| Problem                          | Status | Code                   |
| -------------------------------- | ------ | ---------------------- |
| No such airport                  | 404    | `not_found`            |
| Airport has no scheduled service | 422    | `airport_not_playable` |
| Already a hub for this airline   | 409    | `already_a_hub`        |
| The quoted price is stale        | 409    | `hub_cost_changed`     |
| Not enough cash                  | 422    | `insufficient_funds`   |

Insufficient funds is a **refusal**, not an overdraft. Every player-initiated spend refuses;
only payroll and hub upkeep, which cannot, are allowed to take a balance negative.

---

## Choosing one: fees and slot scarcity, before confirming

`GET /api/hubs/candidates?query=` prices every candidate airport on today's curve and carries,
on the same object, the two things App. B.5 says make a free flagship self-balancing rather
than free:

- **`annualFeeMinor`** — what the hub costs every year once taken.
- **`slots`** — real M7-05 numbers: the IATA level, whether the airport is coordinated, how
  many airlines may hold any one hourly band, and how many of the 24 bands are already full.

At an **uncoordinated** airport `capacityPerBand` and `bandsFull` are both reported as zero
rather than as a notional cap, because nothing there is ever refused for want of a slot and a
number would imply scarcity that does not exist.

Nothing blocks a flagship. App. B.5 is explicit that _"ambition should be allowed to be a
mistake"_; what M7-04 guarantees is that it is an informed one.

---

## Facilities

`POST /api/hubs/:hubId/facilities` with `{ kind, expectedCostMinor }`.

Each facility costs a fraction of its hub tier's base price to open, and a smaller fraction
every year afterwards. Fractions rather than four figures per facility, because App. B.5's
requirement is that fees _"scale with tier"_ — as a multiple of `tierBaseMinor` that scaling is
the definition rather than a second table to keep in proportion. A lounge at a flagship hub
costs 12.5× a lounge at a small one, automatically.

| Facility           | Opening   | Annual    |
| ------------------ | --------- | --------- |
| `lounge`           | 0.25 base | 0.05 base |
| `training_academy` | 0.40 base | 0.06 base |
| `maintenance_line` | 0.50 base | 0.08 base |
| `self_handling`    | 0.60 base | 0.10 base |
| `heavy_check`      | 1.00 base | 0.12 base |

`heavy_check` requires `maintenance_line` first — App. B.5's own ordering (_"maintenance line,
**then** heavy check capability"_). Nothing else gates a facility beyond having the cash.

`training_academy` here is **not** §10.1's training academy, and the two must not be confused.
This one is App. B.5's per-hub unlock: an opening cost, an annual fee and no mechanic behind
it. §10.1's academy is a separate thing at a **crew base**, with levels, modules and a rank
ceiling, and M9-01 built it — see [`training-academy.md`](training-academy.md), which records
why the design doc says both and which one the code follows. Holding this facility neither
grants nor gates that academy.

Both prices are **pinned on the `hub_facility` row** at purchase, for the same reason the hub's
tier is: a retune must not re-price something already bought.

A facility has no status column and no way back. App. B.5 gives an opening cost and an annual
fee and no closure mechanic, and a nullable `closed_at` would be a mechanic nobody has designed
sitting in the schema looking load-bearing.

### Two facilities App. B.5 lists that are deliberately absent

- **Crew base.** Already a first-class subsystem — M5-01/M5-03's `crew_base`, with its own
  opening cost, pay bands, hotel tiers and morale. A second row also called a crew base would
  be two records meaning one thing, and the one that did nothing would be the one a player
  found first.
- **Cargo facility.** Not blocked any more, and **not cancelled**: the cargo question was
  answered **yes** on 2026-09-07 — Tailfin has cargo, shipped as its own update rather than
  inside M7. So the facility is coming, and it arrives with
  [CARGO-10](https://github.com/simmeh024/tailfinsim/issues/1096), which explicitly builds the
  cargo terminal _"through M7-04's facility mechanism, not a parallel one"_. It is absent here
  because a facility that costs money and does nothing is what
  [GAP-14](https://github.com/simmeh024/tailfinsim/issues/667) warned against — the unlock
  arrives with the throughput, cold storage and DG handling that give it a purpose.

  Adding it later is deliberately cheap, which is why waiting costs nothing: one value in
  `HubFacilityKind`, one in the `hub_facility_kind` pgEnum (an `ALTER TYPE … ADD VALUE`, expand),
  and two fractions in `SHIPPED_HUB_FACILITIES`. Facility prices scale off the hub tier base on
  their own, so there is no new balance table and nothing already sold is re-priced.

### What a facility does

**Nothing yet, beyond costing money.** M7-04 ships the unlock — the row, the pinned prices, the
purchase, the prerequisite and the fee — because that is what App. B.5 specifies about
facilities. Each facility's _effect_ belongs to the subsystem that owns it (§9.2 crew, §10.1
the academy, §7.3 maintenance, the product score, §9.3 self-handling), and wiring five
subsystems is not this milestone. That is stated here rather than left to be discovered.

---

## The monthly fee, and the worker

**The fee is billed by the worker**, per world, on the world's game clock. `billHubUpkeep`
runs on every tick and bills once a game month.

App. B.5 states the fee annually and then describes it _"bleeding you monthly"_, so the config
holds the year and the biller charges a twelfth. Rounding is applied to the monthly instalment
rather than accumulated across the year: twelve identical predictable payments are worth more
than an annual total nothing actually charges.

The hub's own fee is read from **today's** config; each facility's from **the row it was sold
at**. That difference is deliberate — retuning `annualFeeMinor` is meant to move what hubs cost
to hold, while a facility was quoted an exact fee and pinned it.

Idempotency is AIR-06's, not a new mechanism: the reference is
`hub_upkeep:<airlineId>:<YYYY-MM>` in the world's calendar, so the sweep can be attempted every
tick and bills once, and the month just ended is retried for as long as the following month
lasts. There is no "last billed" column, and there should not be: ADR-0005 would require it to
be reset on a world reset, and forgetting would leave a fresh world believing it had paid.

**A hub is billed only for a month it was open before that month began** — one grace month on a
new hub. Not generosity: billing the month a hub opened would make the amount depend on when in
the following month the tick ran, and AIR-06's replay guard asserts identical facts, so the
second attempt would throw rather than no-op. `crew/payroll.ts` learned that on dev, where it
failed once a second from the moment it deployed.

### Production has no worker, and the failure is silent

**Production has no worker** ([OPS-12](https://github.com/simmeh024/tailfinsim/issues/191)), so
on a production world a hub would be bought once and then held for nothing, for ever. No monthly
fee, no pressure to close a hub that stopped earning — and the free flagship becoming exactly
the dominant opening App. B.5 designed against, since acquisition is waived and upkeep never
arrives.

That reads as generous balance rather than as a missing process, which is the same trap as
"ticks: 0, errors: 0". `hubFeesBilled`, `hubFeesMinor` and `hubErrors` are the heartbeat
counters that tell the two apart.

### Insolvency

Upkeep cannot refuse — the hub was held — so **an airline that cannot pay its hub fees goes
negative**, and nothing yet acts on a negative balance. §11's bankruptcy is not built. What must
not happen is the fee silently skipping, which would make "hold hubs you cannot afford" free.

---

## Accounting

Two ledger categories, and they are not interchangeable:

- **`hub_purchase`** — buying a hub, and building a facility. Capital, so it sits **outside**
  the operating P&L exactly as `aircraft_purchase` does. Charging a $25M flagship against one
  month would bury that month's operation and flatter every month after it.
- **`hub_facility`** — the recurring fee. An operating cost, and **in** the P&L
  (`PNL_CATEGORIES`). This is the line the free-flagship decision eventually shows up in.

Purchase and facility ledger lines carry the `hubId` dimension, so M8-01 can group spend by hub.

The monthly fee is also a **projected commitment** in §13.6's cash runway (`kind: 'hub'`),
folded exactly the way `billHubUpkeep` folds it. It is classified `projected` rather than a
rate for the same reason payroll is: the commitment reproduces it, and counting it in the
trailing burn as well would bill it twice.

---

## Not built by M7-04

Named so they are not mistaken for bugs:

- **Facility effects** — see above.
- **Cargo facility** — GAP-14 (#667).
- **Closing or selling a hub.** There is no disposal path. App. B.5 describes acquisition and
  upkeep and no exit, and inventing one would decide what happens to the aircraft, crew, routes
  and slots based there.
- **Gates and stands** — App. B.6, which is M7-06 (#71).
- **A web surface.** M7-04 is labelled `area:server` / `area:sim`; the API is complete and
  nothing renders it yet.
