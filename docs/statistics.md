# Statistics

Every figure §14 exposes, what it means, and where it goes when a player asks
_why_. Design doc **§14.1–§14.3**; built by **M8-09**.

---

## The rule

> **Every figure drills down to its cause.** Load factor → by route → by flight →
> by segment → the Appendix A waterfall showing which competitor took the
> passengers and why. A number you cannot interrogate is a number players will
> not trust, and the whole design (A.1) is built on trust.

That is a **structural** requirement, not a UI convention. A metric is a record
in `server/src/statistics/registry.ts` and the record has no optional fields, so
there is nowhere to put a metric without saying where it goes — and
`drilldown.test.ts` asks the router whether that somewhere is actually served.

A convention would not have survived. Somebody adds a metric in a hurry, the
drill-down is a follow-up, the follow-up does not happen. The interesting failure
is not a missing drill-down, which the type system already refuses; it is one
that names an endpoint that **used to exist**.

---

## Three horizons, always (§14.2)

| Horizon      | On the wire | What it is                                            |
| ------------ | ----------- | ----------------------------------------------------- |
| **Now**      | `value`     | the trailing 30 game days                             |
| **Trend**    | `trends`    | 7 / 30 / 90 game days, each against the window before |
| **Forecast** | `forecasts` | 7 / 30 / 90 ahead, each a **band**                    |

A trend carries the level _and_ the movement, because §14.6 asks for both: _"a
falling profit that's falling more slowly is a different story from one that
isn't."_ `changePct` is null when the previous window was zero — there is no
percentage change from nothing — and `changeAbsolute` still answers, which is why
both are there.

### A forecast is a band, never a number

`low`, `mid` and `high` are all required and the half-width scales with
`sqrt(1 + horizon / observed)`, so ninety days is visibly less certain than
seven. A fixed-width band would claim otherwise.

**Fewer than three observed buckets and there is no forecast at all** — an
absent projection is honest, a flat line through one observation is not.

What the projection reads is the airline's **own recent history**, fitted by
least squares. §14.2 also names committed schedule, booking curves and §18's
events; none of those is a queryable forecast input yet — the schedule horizon is
14 game days, bookings are not modelled as a curve, and §18 has no event model at
all. Saying so is the point: a forecast that claimed those inputs while using
none of them would be the untrusted number §14.1 is about.

---

## The metrics

Seven of these are §14.3's named unit economics; the rest are the headline
figures its dashboards open with.

| Metric         | Unit         | Up is   |
| -------------- | ------------ | ------- |
| Load factor    | ratio        | good    |
| ASK            | seat-km      | neither |
| RPK            | passenger-km | good    |
| RTK            | tonne-km     | good    |
| Spill          | ratio        | bad     |
| On time        | ratio        | good    |
| RASK           | minor / ASK  | good    |
| CASK           | minor / ASK  | bad     |
| Yield          | minor / RPK  | good    |
| Breakeven load | ratio        | bad     |
| Revenue        | minor        | good    |
| Cost           | minor        | bad     |
| Contribution   | minor        | good    |

Every definition carries four things a client cannot infer: the **unit**, because
`0.081` is a fraction of a dollar per seat-kilometre and `0.81` is a load factor
and nothing about the number says which; the **polarity**, because a rising CASK
is bad and a rising load factor is good; a one-sentence **description**, because
RASK and yield are not obviously different; and the **drill-down**.

### RASK, yield and CASK are three different questions

|           | Per what             | Answers                          |
| --------- | -------------------- | -------------------------------- |
| **RASK**  | available seat-km    | what a seat you _offered_ earned |
| **Yield** | revenue passenger-km | what a seat you _sold_ earned    |
| **CASK**  | available seat-km    | what a seat you offered cost     |

`RASK = yield × LF`, exactly, and a test proves it against real rows. An airline
whose yield rises while RASK falls is pricing into a market that is leaving —
the single most useful thing this vocabulary can say, and invisible if the two
are conflated.

### Breakeven load is deliberately not clamped to 1

`BELF = CASK / yield`. Above 1 the route cannot break even at **any** load
factor — every extra passenger loses money — and `1.34` says that where a clamped
`1.00` reads as _"nearly there"_. §14.4's ranked chart has to tell "reprice it"
from "kill it".

### Nothing flown is null, never zero

A ratio over an empty window is `null`. Zero would read as _"earned nothing per
seat"_, which is a claim about a bad month rather than about an absent one.
Volume and money are genuinely `0`, which is a different statement — and the two
together are what let a client say _"nothing has flown"_.

---

## The chain, walkable end to end

```
GET /api/statistics                        load factor, and where it goes
  → /api/statistics/load_factor/breakdown?by=route      each route's own load factor
      → /api/routes/:routeId/flights                    each departure
          → /api/routes/:routeId/waterfall              App. A's segments, and who took them
```

Each rung carries the next one, so a client walks the chain without knowing it in
advance. `/api/routes/:routeId/flights` is **new in M8-09** and was the missing
link: load factor used to drill to a route, and a route drilled straight to the
waterfall. _"Which of these departures was empty?"_ and _"who took the market?"_
are different questions and only the second was answerable.

The waterfall is already per **segment**, so the chain ends there rather than
needing another endpoint.

**A share is null for a ratio.** The load factors of five routes do not add up to
the airline's, and a share column that pretended they did would be exactly the
confident-looking wrong number §14.1 exists to prevent. Additive metrics get a
share; ratios get their value alone.

---

## Where each thing lives

|                                           | Where                                                 |
| ----------------------------------------- | ----------------------------------------------------- |
| RASK, CASK, yield, RPK, ASK, RTK, BELF    | `packages/sim/src/statistics/unit-economics.ts`       |
| The forecast band and the trend           | `packages/sim/src/statistics/forecast.ts`, `trend.ts` |
| The registry — labels, units, drill-downs | `packages/server/src/statistics/registry.ts`          |
| The rollup and the breakdown              | `packages/server/src/statistics/metrics.ts`           |
| The flights behind a route                | `packages/server/src/network/route-flights.ts`        |
| The guard that keeps drill-downs alive    | `packages/server/src/statistics/drilldown.test.ts`    |

---

## Operational notes

**This is the loudest missing-worker surface in the game.** Every figure comes
from `flight_result`, and only the worker writes one. **Production has no
worker**, so there the whole of §14 reads null and zero — not one panel, the
entire dashboard. It reads as an airline that has done nothing rather than as a
missing process, which is the same trap the fleet page, the world map and the
used market already carry.

**One read, many windows.** The rollup reads `flight_result` once over 180 game
days, buckets it by game day, and folds a slice per window. A query per metric per
window would be thirteen metrics × six windows against one table — and would let
two metrics disagree about which flights were in the window.

**180 days, because a 90-day trend needs the 90 before it** to be a trend
_against_.

**Distance comes from the route, joined on the airport pair.** `flight` carries
no route id and no distance; `route`'s unique
`(airline_id, origin_icao, destination_icao)` is what turns a flight back into a
route, the same way the service catalogue finds a flight's package. The join is
a `left` join, so a flight whose route has since been deleted still counts toward
the money totals, contributes no seat-kilometres, and says it cannot be drilled
into rather than offering a link that 404s.

**The metric id is a selector, not an owned resource.** It names nothing the
player has, so there is no cross-owner case to conceal: an unknown one is a 404
because the metric does not exist. The data behind it is owner-scoped by
resolution like every other private read (ADR-0020), and the classification is
registered in SEC-07's matrix as `computed-selector` rather than pretending it is
a resource.

**Only settled scheduled flights count.** A cancelled flight never settles, and a
ferry sells nothing — counting its seats would report an airline as having flown
empty rather than as having positioned an aeroplane.

---

## What M8-09 did not build

- **Dimensions other than route.** §14.3's Financial dashboard wants profitability
  by aircraft, hub and cabin class, and `GET /api/finance/pnl` already answers all
  four — so the money metrics drill there. Adding a dimension to the breakdown
  means the breakdown can actually _produce_ it; a dimension listed and unserved
  would be the dead-end drill-down §14.1 forbids, so `by=hub` is a 404 today
  rather than an empty answer.
- **The dashboards themselves** (§14.3) and §14.4's ranked profit-by-route chart.
  This is the API; there is no web surface yet.
- **§14.5's alerts** and §14.6's CSV export and world-median benchmarks.
- **Forecast inputs beyond the airline's own history**, as above.
- **Fleet, crew, ground and reputation metrics.** §14.3 lists seven dashboards'
  worth; this covers the traffic, commercial and financial figures that
  `flight_result` can answer. The rest need their own rollups.
