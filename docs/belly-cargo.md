# Belly cargo

Freight in the hold of a passenger flight — design doc §12.1 and §12.2, shipped by
**M8-15** ([#87](https://github.com/simmeh024/tailfinsim/issues/87)).

This is the contract: what belly cargo owns, what it deliberately does not, and where the
boundary against the CARGO milestone runs. It describes current behaviour.

---

## Why it exists

§12.1 states the mechanism in one equation and then asks for something harder than the
arithmetic:

```
Available belly payload = MTOW − OEW − fuel − passengers − passenger bags
```

> Which means belly cargo is in **direct competition with your own passengers and your own
> range**. A full cabin with full bags on a long sector leaves almost no belly capacity. A
> widebody on a medium sector has tonnes spare.
>
> **This is the quiet economic reason widebody long-haul works at all** … and the game
> should make that discoverable rather than stated.

So the deliverable is not a revenue line. It is a **decision** — visible, per route, with the
constraint that binds it named — plus the money that follows from it.

---

## What ships

| Piece                        | Where                                           | Pinned by                          |
| ---------------------------- | ----------------------------------------------- | ---------------------------------- |
| The capacity model           | `packages/sim/src/cargo/belly.ts`               | `aircraft_catalogue_version`       |
| The lane's yield and tonnage | `packages/sim/src/cargo/lane.ts`                | `economy_config_version`           |
| Resolving both from a world  | `packages/server/src/cargo/plan.ts`             | —                                  |
| The tonnage on a flight      | `packages/server/src/flight/depart.ts`          | written once, at pushback          |
| The money                    | `packages/server/src/flight/settle.ts`          | `flight_result.settlement_version` |
| The readout                  | `GET /api/routes/:routeId/cargo`                | —                                  |
| The panel                    | `packages/web/src/network/planner/CargoTab.tsx` | —                                  |

### Three limits, and the binding one is the answer

`bellyCapacity` returns three allowances and says which bound the load. All three travel,
because the gap between the binding limit and the runner-up is the decision — weight-limited
with twelve tonnes of unused hold means a lighter cabin buys freight; weight-limited with the
hold already full means it buys nothing.

| Limit          | What it is                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| **weight**     | §12.1's equation: MTOW less the aircraft, its fuel, its passengers and their bags                     |
| **structural** | `maxPayloadTonnes` — the floor and frames, which do not care that the aircraft is light on fuel today |
| **volume**     | What the hold has room for once the passengers' bags are in it (§12.6)                                |

**The bags are in the hold, and that is the point.** Baggage is subtracted from the weight
allowance _and_ from the volume allowance, because it occupies the compartments the freight
would. That is what makes §12.1's _"direct competition with your own passengers"_ literally
true rather than a figure of speech — a full cabin costs belly capacity twice over. Bags are
never displaced by freight: they belong to passengers who have been sold a seat.

**Which limit binds differs across the fleet**, and that is the property the panel exists to
make discoverable. A full narrowbody is stopped by structure on a short sector and by MTOW on
a long one; a widebody with weight to spare runs out of _room_. Both are tested in
`cargo/belly.test.ts` against App. C.2 figures.

**`cargoVolumeFactor` is finally consumed.** App. C.3's belly tanks take 18–38% of the hold
and App. C.4's long-range A321neo build ends at 62%; a main-deck cargo door gives some back at
94%. Since M4-03 that number reached `effective_spec` and the fleet API and was read by
nothing. It is now resolved from the airframe's own `build_option_ids` against its own pinned
catalogue version, so a tank ordered three years ago still costs hold space today.

### The lane is directional, and both legs are always priced

§12.2 is emphatic:

> Asia→Europe headhaul runs full at high yield; the backhaul runs half-empty at a fraction of
> the rate. **Cargo route profitability must be evaluated as a round trip, never per leg** —
> this is the single most common real-world mistake and it should be a real trap in the game.

`cargoLane` therefore answers asymmetrically, and every surface carries **both** legs' rates
and offered tonnages. A panel that showed only the direction being planned would build that
mistake into the interface.

Direction is not asserted; it falls out of the airports' own M1-03 indices. `business_index`
stands in for industrial output at the sending end and `wealth_index` for consumption at the
receiving end, so a lane from a high-output, lower-wealth airport to a wealthy one is heavier
outbound than inbound — the Asia→Europe shape, reached without a table of trade partners.
`tourism_index` is deliberately unread: §12.2 says freight does not follow tourism, and
reading it would make Palma a freight hub.

Two quantities, computed differently on purpose. **Magnitude** is sub-linear in the size of
the lane's ends, mirroring A.2's α. **Imbalance** is taken from the raw index ratio, _before_
that exponent — applying it to the direction as well crushed a genuine 1.9× asymmetry into
1.3× and quietly deleted §12.2's _"severely"_. A consequence that falls out rather than being
designed: the populations cancel in the imbalance ratio, so lopsidedness is a property of the
_character_ of the two ends and not of their size.

### The tonnage is decided at pushback, once

`flight.cargo_kg` is written in the `FLIGHT_DEPART` handler, alongside the handling-price
snapshot and for the same reason: belly capacity depends on the aeroplane, the cabin and the
fuel — facts about _this departure_ — and the lane's yield depends on a pinned economy an
admin can re-pin at any time. Resolving the load at arrival would let a retune change how much
freight an already-airborne aeroplane turned out to be carrying, and would make a replayed
arrival produce a different tonnage.

The settlement then bills exactly what the column says, at the lane's rate in the flight's
direction. A diverted flight is billed the **sold** lane's rate over the **sold** sector
length: costs follow where the aeroplane actually went (§8.4), but the shipper bought carriage
to the scheduled destination.

A **ferry carries nothing**, enforced before the tonnage is decided rather than after. And a
belly that cannot be planned — an unknown airframe, an airport with no coordinates — loads
zero rather than refusing the departure: the crew are committed by that point, and a missing
catchment row must not cancel a flight.

### The money was already wired

The `cargo` ledger category, the `cargo_customers` counterparty, the settlement's revenue line
and the P&L row have existed since M2-06 and M8-01. What was missing was a number in
`flight.cargo_kg`, which was always `0`. `GET /api/finance/pnl` has therefore reported a
`cargo` line all along; it now has something in it.

---

## The planning cabin, and the one seam to know about

`flight.load` is still `'{}'` — nothing books passengers onto a flight yet — so the plan
assumes **the seats the airframe is offering** (`effective_spec.seatsTwoClass`, the same proxy
`crew/dispatch.ts` and `crew/legality.ts` already use for cabin size).

That is deliberately the conservative direction: a load planner does not sell belly capacity
the seats it has already sold will need, and a full cabin is §12.1's own case. Belly revenue
is therefore understated rather than overstated. When real bookings arrive,
`BellyPlanInput.passengers` is the one line that changes — nothing else in the model moves.

---

## Where the numbers live, and why they are in two places

| Kind                                                                                                                | Section                                           | Pin   |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----- |
| Rate per tonne, distance term, headhaul premium, backhaul discount, imbalance cap, offered tonnage, freight density | `EconomyConfig.cargo`                             | §22.3 |
| Passenger and bag planning weights, hold volume per structural tonne, baggage density                               | `packages/sim` literals beside `payload-range.ts` | §22.5 |

A fare change and an aerodynamics change must not share a version number, or a
`flight_result` can no longer say which of the two explained it. So what a tonne **earns** is
the economy's and what **fits** is the catalogue's, and `balance-source.test.ts` holds that
line for both halves.

`freightDensityKgPerM3` is the one that looks like physics and is not: how many kilograms fill
a cubic metre is a property of what the market is shipping (§12.3 puts e-commerce at _"medium
yield, huge volume"_ against dense general freight), so the commodity mix decides it and the
commodity mix is demand. Retuning it changes which constraint binds without touching a single
aeroplane.

`EconomyConfig.cargo` **arrives with a default**, per CLAUDE.md's rule: rows in
`economy_config` are immutable and parsed on the way out against today's schema, so a required
new section would make every payload written before it unparseable and a world pinned to one
could not price a flight at all. `costs.settlement.cargoRatePerTonneMinor` stays where it is
for the same reason — every `v1` settlement written before M8-15 was billed at that number,
and it now applies only when no lane could be resolved.

---

## The boundary against the CARGO milestone

The 2026-09-07 cargo decision ([#1087](https://github.com/simmeh024/tailfinsim/issues/1087))
confirmed M8-15's independence and drew the line:

> Belly cargo (#87) needs the payload arithmetic and `cargoVolumeFactor`, not the freight
> domain, and is not blocked by any of this. … The one thing it must not do is invent a cargo
> demand pool — CARGO-03 owns that, and §12.2 is explicit that cargo demand cannot be a
> coefficient on the passenger model.

So there is **no cargo demand table**. `cargoLane` is a pure function over airport attributes
the world already has, which is enough for the belly channel precisely because belly freight
is opportunistic — the aeroplane was going anyway, and the only question is what the hold is
worth on that lane in that direction.

**What CARGO-03 replaces, exactly:** `cargoLane`'s `offeredTonnes`. Nothing else. The
direction, the yield asymmetry and the whole capacity model stay as they are.

CARGO-04 ([#1090](https://github.com/simmeh024/tailfinsim/issues/1090)) was filed as owning
the payload equation and blocking this issue; the later decision reverses that ordering, and
M8-15 ships the belly half of it — the equation, both constraints, the binding-limit report and
`cargoVolumeFactor` consumed. What CARGO-04 has left is the freighter half: a main deck, a
real `bellyVolumeM3` in the catalogue, and `flight_result.cargo_kg` for a payload-only flight.

### Deliberately not built

- **Freighters and main-deck loading.** CARGO-05. `bellyCapacity` already reads a freighter
  correctly — passengers and bags at zero, the structural limit becomes the whole payload —
  and `cargo/belly.test.ts` proves it, so the model does not need changing for one.
- **Commodity types and their certifications.** §12.3, CARGO-07. Freight is one undifferentiated
  thing at one density.
- **Contracts, spot, ACMI, block space, mail.** §12.4, CARGO-08.
- **ULDs, load planning, the cargo terminal.** §12.6, CARGO-10.
- **The night shift.** §12.5, CARGO-11.
- **Balance.** §12.6 lists _"weight and balance and volume"_; this does weight and volume. A
  centre-of-gravity envelope needs per-compartment geometry the §22.5 catalogue does not carry.
- **Maximum zero-fuel weight.** A real fourth limit, not in the App. C.2 catalogue; the
  structural limit catches most of what it would. `payload-range.ts` already names this.
- **Port proximity.** §12.2 asks for it and no column expresses it. The cost of the omission is
  understated sea-freight competition on the densest ocean lanes; CARGO-03 is where it would be
  fixed.
- **Seasonality.** §12.2's Q4 peak is not passenger seasonality and is not modelled. SEASON
  and CARGO-03.

---

## The worker boundary

Belly cargo needs the worker for exactly the part that needs a flight.

`GET /api/routes/:routeId/cargo` is a **projection** and answers on a fresh world with no
worker: it says what a flight _would_ carry. It is decision support and never a gate — nothing
it returns changes what a flight loads.

What needs the worker is everything downstream of a departure. **Production has no worker**
([OPS-12](https://github.com/simmeh024/tailfinsim/issues/191)), so on a production world no
flight ever departs, `flight.cargo_kg` is never written, no `flight_result` is settled, and the
P&L's `cargo` line stays at zero — while the Cargo tab happily reports what the hold is worth.
That reads as _"there is no freight money here"_ rather than as a missing process, which is the
same trap the used market, maintenance, crew and the fleet page all have. `docs/deploy.md` and
CLAUDE.md carry the general form of it.

---

## Verification

- `packages/sim/src/cargo/belly.test.ts` — §12.1's two claims against App. C.2 figures: a full
  narrowbody on a long sector leaves nothing, a widebody on a medium sector has tonnes spare,
  and the two are stopped by **different** limits. Plus the belly tank biting, the bags taking
  hold volume, and a freighter reading correctly through the same function.
- `packages/sim/src/cargo/lane.test.ts` — the headhaul found without being told, both legs'
  rates differing by a margin a player would act on, the imbalance independent of size, the cap
  bounding what is _paid_ without hiding the real ratio, and an unclassified airport answering
  instead of throwing.
- `packages/server/src/cargo/cargo-db.test.ts` — against real Postgres: a departure writing a
  real tonnage into a column that used to be zero, a ferry writing zero, the `cargo` ledger
  category receiving money, the headhaul out-earning the backhaul for the _same_ tonnage, and
  another airline's `airframeId` concealed exactly as an absent one is (ADR-0020, SEC-07).
- `packages/web/src/network/planner/cargo-tab.test.tsx` — the binding constraint named rather
  than only the tonnage, and both legs on screen.
- `packages/sim/src/balance-source.test.ts` — the §22.3/§22.5 split, asserted in both
  directions.
