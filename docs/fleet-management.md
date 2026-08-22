# Fleet management (M4-07)

The fleet a player owns: a table you scan and a record you open. Two read-only endpoints,
`GET /api/fleet/airframes` and `GET /api/fleet/airframes/:airframeId`, and the Fleet page
above the catalogue M4-02 already renders.

The interesting part is not the table. It is that **three figures on it would be dead ends
if they were sent alone**, and CONTRIBUTING's fourth invariant says a number a player cannot
attribute is one they will assume is a bug.

---

## The effective spec, taken apart

> **Acceptance criterion 1** — _"Effective spec shows base value and delta per option, not
> just the total."_

`effective-spec.ts` folds a build into one answer, which is the shape every consumer wants:
App. C.6's rule is that _"everything downstream reads only `effective_spec`"_. A player
needs the opposite — which option moved which number.

### Why the deltas are not the option's published deltas

The obvious implementation prints each option's `specDeltas`. It is wrong, and quietly:
`computeEffectiveBuild` multiplies where C.3 quotes a percentage, rounds `maxSeats` once at
the end, rounds `runwayRequirementM` up, clamps `seatsTwoClass` to the certificate and clamps
the wingspan code at both ends of the scale. An A320neo with the efficiency package and
sharklets — both quoted by C.3 as a percentage of burn:

|                            | printed from `specDeltas` |  actually folded |
| -------------------------- | ------------------------: | ---------------: |
| base                       |                 2100 kg/h |        2100 kg/h |
| efficiency package (×0.98) |                       −2% |           −42.00 |
| sharklets (×0.965)         |                     −3.5% |           −72.03 |
| **effective**              |        −5.5% = **1984.5** | **1985.97** kg/h |

The percentages are accurate about the options and add up to the wrong aeroplane, because the
second factor applies to a burn the first already reduced. `maxSeats` fails the same way from
the other direction: high-density exits are _"+22%"_, and what a player needs is _"180 seats
becomes 220"_.

So `spec-decomposition.ts` reports the difference between **two real folds** — prefix `i` and
prefix `i − 1`. That makes the decomposition **exact by construction**: every `after` is a
spec the engine really computed, the last one _is_ `computeEffectiveSpec` of the whole build,
and every axis satisfies `base + Σ deltas = effective`. The same approach `used-market.ts`
takes with its valuation, and for the same reason — a decomposition that can disagree with
the number it explains is worse than none.

The cost is that attribution is **order-dependent**, and it has to be: whichever factor is
applied second gets the smaller share. The order used is the one the billing fold uses,
canonical by option id, so what a player is shown is what the engine did.

### The two things that guard it

- **`fleet.test.ts` (server, CI)** asserts the decomposition equals the airframe's stored
  `effective_spec` column. That is the one place M4-07 could produce two numbers for one
  fact: the detail view recomputes a spec the acquisition already wrote. If they diverge, the
  build screen is explaining a different aeroplane from the one that is flying.
- **`fleet.test.ts` (shared)** asserts `SPEC_AXES` plus `wingspanCode` is exactly
  `AircraftSpec`. Add a specification field without adding it to the axis list and the test
  fails, rather than the build screen quietly omitting the number that moved.

The capability axes — belly volume, comfort, maintenance cost, low-visibility cancellations,
ETOPS — are decomposed alongside the spec, because most of C.3's options spend there. A
lightweight cabin shown as _"−1.8 t OEW"_ and nothing else has hidden the comfort charge that
is the whole trade.

---

## The other two numbers, and their working

**Utilisation** is block hours a day (§11's fleet panel), and it is sent with the window and
the hours as well as the rate. §2488's onboarding warning fires off exactly this number
—_"you aren't using the three you have"_ — so it has to be traceable to the flights that
produced it.

- **Flown, not planned.** What a rotation _intends_ is in `assignments`; this is what the
  aeroplane did, summed from `actual_arrival − actual_departure`.
- **A trailing week of _game_ days.** A world at 4× flies four times as much per real day, so
  a rate measured in real time would not be comparable between worlds or across a speed
  change (ADR-0005).
- **The window is shortened for a new arrival, and null under a day.** An aeroplane delivered
  two game days ago is not idle because it flew nothing in the five days before it existed.
  Dividing by a fixed seven would fire the onboarding warning on the day a player's first
  aircraft arrived.

**The next check** is quoted by the limit that binds — hours or cycles, whichever arrives
first — which is M4-06's rule carried into the table.

### Grounding is a latch, and the sort reads the latch

The list is ordered by what needs the player: **grounded first**, then anything a recomputed
status says is unairworthy, then whatever is closest to due — and an aeroplane already _in_ a
check sorts to the bottom, because the decision has been taken and it is inventory rather than
a decision.

Grounded has to come from the `status` column rather than from recomputed airworthiness. The
worker sets that latch and the player clears it by booking the work, so a row can legitimately
read `grounded` while a fresh calculation finds nothing overdue. Sorting on the calculation
instead put a row labelled "Grounded" below a healthy one.

The first version sorted on airworthiness alone, which left two new aeroplanes equal and let
the tie-break fall to registrations minted from a random order UUID. It passed once and failed
in CI on the next unrelated pull request. `fleet.ts` and `maintenance.ts` now share the
ordering, so the fleet table and the maintenance page cannot disagree about which aeroplane
needs attention first. _"A-check in 95 cycles"_ is a plan;
_"an A-check soonish"_ is not.

---

## Where an aeroplane is, and what it is not

The task's column list says _"base"_. **Tailfin has no aircraft base**, and this reports
where the aeroplane _is_ instead.

§9.2's base is a **crew** base — _"a crew base is an unlockable facility at an airport, with
its own hiring pool and cost structure"_ — and §17 lists it among the per-hub facilities.
Neither crew nor hub facilities are built. Meanwhile `positioning.ts` is explicit that an
aircraft's position is derived from its flights and that a stored `location` column would be
a second source of truth that drifts the first time a flight diverts.

So there is nothing to assign an aircraft to, and a column labelled "base" filled with a
delivery airport would be a number that meant nothing. `locationIcao` is folded from the
airframe's movements — a diversion wins, and a flight that has not departed does not count.

---

## What M4-07 did not build, and why

The issue's third task bullet is _"Bulk actions: apply livery, assign to base."_ **Neither
has a substrate**, and both are recorded here rather than approximated.

### Apply livery — blocked on M6

There is no livery. A livery is a layered JSON document ([M6-01](https://github.com/simmeh024/tailfinsim/issues/57)),
drawn on per-family templates ([M6-02](https://github.com/simmeh024/tailfinsim/issues/58)) in
a builder ([M6-03](https://github.com/simmeh024/tailfinsim/issues/59) onward), and applied
fleet-wide by [M6-07](https://github.com/simmeh024/tailfinsim/issues/63). There is no
`livery` table; `airframe.livery_id` exists and nothing writes it. A bulk action that set a
column no builder can populate would be a button that does nothing.

### Assign to base — blocked on the base itself

See above: the base does not exist as a thing an aircraft can be assigned to. Adding an
`airframe.base_airport_id` would be inventing a mechanic — it would have to interact with
crew basing (§9.2), ferry costs (§7.2) and gates (§17), none of which are built — and doing
it in the milestone that does not own the subject.

### Livery thumbnails — acceptance criterion 2, honestly

> **Acceptance criterion 2** — _"Livery thumbnails render from the server-side renderer, not
> client-side re-render."_

**This is not met, and it cannot be from here.** The server-side renderer it names is
[M6-06](https://github.com/simmeh024/tailfinsim/issues/62) — a headless SVG rasteriser, a
cache keyed on livery version and projection, and content-addressed immutable URLs. It does
not exist, it has nothing to render, and building a stand-in raster pipeline would be
answering M6's question with M6's design decisions still open.

What is built is the **seam**, so the criterion becomes true the moment M6-06 lands rather
than needing this code changed:

- `FleetAirframeView.liveryThumbnailUrl` is a nullable URL the **server** decides. It is
  always `null` today.
- The fleet table renders that URL verbatim in an `<img>` when it is set, and a **type mark**
  — the manufacturer's initial and a class abbreviation — when it is not. A type mark is
  deliberately not a livery.
- The client has no livery document, no template and no renderer, and never composes one.
  `fleet-ui.test.tsx` asserts both halves: no `<img>` while the field is null, and the
  server's exact URL when it is set.

A client-composed approximation would be worse than nothing: the fleet table and the world
map would then disagree about what a player's aircraft looks like, which is the problem
M6-06 exists to prevent.

---

## Where it runs

Read-only. Nothing in `fleet.ts` mutates, and `POST /api/fleet/maintenance/checks` remains
the only fleet write besides an acquisition.

Two concealment rules, both ADR-0020's. `GET /api/fleet/airframes` is scoped to the
session-resolved airline, so it cannot be asked what somebody else owns. The detail route
answers an **identical 404** to a malformed id, an unknown id and another airline's id — the
query is scoped by owner, so there is no state in which it could answer 403 and thereby
confirm that an id is a real aeroplane. The UUID shape is checked before it reaches Postgres,
because a non-UUID compared against a `uuid` column raises a driver error and a 500 where a
404 belongs is itself a disclosure.

> **Production has no worker**, so on a production world nothing accrues hours, no flight
> settles and no check completes. The fleet table would show every aircraft at
> `0.0 h/day`, sitting for ever at its delivery airport, with a check that never came due —
> which **reads like a broken page rather than like a missing process**. Same trap as
> _"ticks: 0, errors: 0"_. OPS-12 ([#191](https://github.com/simmeh024/tailfinsim/issues/191))
> is the production worker.

---

## Deliberate boundaries

- **The configurator.** M4-03 owns the option rules and M4-04 the order flow. This renders
  what was ordered; it does not let a player reconfigure an airframe. Retrofits are C.3 rule
  5 and M4-03's.
- **The cabin.** `cabinConfigId` is reported and is always `null`, because §6.1's cabin
  builder is M6's. Reported rather than omitted: "no cabin fitted" is a real state, and the
  decomposition already handles a cabin the moment one exists.
- **Registration editing.** `provisionalRegistration` in `acquisition.ts` mints `TF-XXXXXXX`;
  §5.2's player-defined prefix is M6's identity work.
- **Provenance beyond `owner_history[]`.** HIST-01 through HIST-11 own the living airframe
  history, including what a previous owner may be told about.
- **Booking a check from this page.** The endpoint is M4-06's and works; wiring a button to
  it is a mutation on a read-only view and belongs with the maintenance UI decision, not
  here.
