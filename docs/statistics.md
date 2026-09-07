# Statistics

Every figure §14 exposes, what it means, where it goes when a player asks
_why_, and the two dashboards that show it. Design doc **§14.1–§14.3**, **§14.6**;
built by **M8-09** and **M8-10**.

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

## The dashboards (M8-10)

§14.3 describes seven. Two are built, and they have deliberately different jobs:
the Executive page answers _"is the airline all right?"_ in one glance — §2's
check-in session — and the Financial page answers _"where did the money go?"_,
which takes tables. Merging them would produce a screen that does neither.

### Executive, at `/dashboard`

> cash, **cash runway in days**, net worth, MTD profit vs. forecast, load factor,
> OTP, reputation, credit rating, top gainers and losers this week

Nine figures from six subsystems, assembled by `GET /api/statistics/executive`
rather than by the page. Six of them already exist somewhere; **three do not**,
and those three are the reason the endpoint exists:

| Figure              | Why the server computes it                                                         |
| ------------------- | ---------------------------------------------------------------------------------- |
| **Net worth**       | cash + tangible assets − debt, on the same asset basis the lender advances against |
| **MTD vs forecast** | a partial month compared against a **band**, scaled to the days actually elapsed   |
| **Top movers**      | a week-over-week difference by route, which nothing else computes                  |

A page that derived those would own three numbers the server could not explain,
which is the opposite of §14.1's rule.

Two decisions inside them worth keeping. **Net worth must not move when an
airline borrows** — cash and debt rise together — because a dashboard that read
it off cash alone would congratulate a player for taking a loan, precisely the
confusion §13 exists to prevent; a database test holds that line. And **the
forecast is scaled to the elapsed days**: comparing a whole month's projection
against six days of trading would report every airline in the game as
catastrophically behind plan for the first three weeks of every month.
`withinBand` is what stops a variance being an alarm — a projection is never
exactly right.

**Movers are ranked on the change, not the level.** The best route in the network
is not news if it was also the best last week.

### Financial, at `/finance`

The P&L with its lines and its four dimensional rollups, the unit economics as
tiles, and the debt with its DSCR and §13.4's per-game-day interest drain. A
`null` dimension key renders as **Unattributed** rather than being dropped, so
the columns still add up to the statement above them.

### Every headline carries its movement

> Absolute value **and** rate of change on every headline metric — a falling
> profit that's falling more slowly is a different story from one that isn't.

So `MetricTile` renders three things and none is optional: the level, the
movement, and the drill-down. Tone pairs its hue with an arrow glyph and spells
the movement out in words, so it survives greyscale and a screen reader (H.4,
H.7).

**A drill-down with no page yet is named, not linked.** `drillHref` maps an API
endpoint to this build's page for it and returns `null` when there is none — the
tile then shows its figure with the destination named in plain text. M8-09's
guard proves the endpoint exists on the server; nothing proves a page consumes
it, and a link to a page that cannot answer is how a drill-down rots.

### 390px is the layout, not a media query

M8-10's third criterion is _"renders usefully on a 390px-wide screen"_, and
§14.6 asks for a mobile-first executive view. Both grids are `auto-fit` with a
`minmax` floor that fits inside 390px, so they collapse to one column on their
own rather than at a breakpoint somebody has to maintain. The one thing
`auto-fit` cannot do is stop a four-column money table pushing the page
sideways, so every table sits in an `overflow-x: auto` box — letting the
**page** scroll instead is the real failure, because it takes the navigation off
screen to show one more column.

jsdom has no layout engine, so the tests assert the two decidable facts — the
`auto-fit` floors, and that every rendered table is inside a scroll container —
and read `dashboard.css` to do it. A visual check belongs on dev.

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
| The Executive assembly                    | `packages/server/src/statistics/executive.ts`         |
| The tile, the formatting and the href map | `packages/web/src/dashboard/`                         |
| One chart language for both dashboards    | `packages/web/src/dashboard/dashboard.css`            |

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

## What is still not built

- **Dimensions other than route.** §14.3's Financial dashboard wants profitability
  by aircraft, hub and cabin class, and `GET /api/finance/pnl` already answers all
  four — so the money metrics drill there. Adding a dimension to the breakdown
  means the breakdown can actually _produce_ it; a dimension listed and unserved
  would be the dead-end drill-down §14.1 forbids, so `by=hub` is a 404 today
  rather than an empty answer.
- **Profitability by cargo.** §14.3 lists it. `flight_result` records `cargo_kg`
  but settlement splits no revenue between passengers and freight, so a cargo
  column would be an invented number in the middle of a real table. RTK appears
  on the traffic side, where the tonnage is genuine.
- **A debt amortisation schedule.** The Financial page lists the loans; nothing
  repays principal yet (see [`loans-and-credit.md`](loans-and-credit.md)), so a
  payment timetable would promise something the game does not do.
- **A cash-flow statement.** The runway answers the question it was built for; a
  statement is its own rollup.
- **§14.4's ranked profit-by-route chart** with the breakeven line — M8-11,
  deliberately its own issue, because it is the one chart the design doc says
  players learn the game through.
- **The other five dashboards** in §14.3 — traffic, fleet, crew, ground,
  reputation — which are M8-12.
- **§14.5's alerts** and §14.6's CSV export and world-median benchmarks.
- **Forecast inputs beyond the airline's own history**, as above.
- **Fleet, crew, ground and reputation metrics.** §14.3 lists seven dashboards'
  worth; M8-09 covers the traffic, commercial and financial figures that
  `flight_result` can answer. The rest need their own rollups.
