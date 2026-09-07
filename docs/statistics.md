# Statistics

Every figure §14 exposes, what it means, where it goes when a player asks
_why_, the two dashboards that show it, and the one chart the design doc says
players learn the game through, and the five operational dashboards beside it.
Design doc **§14.1–§14.4**, **§14.6**; built by **M8-09** through **M8-12**.

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

## §14.4's chart (M8-11)

> **Profit by route, ranked, with a breakeven line.** It's the chart that turns a
> confused player into an airline manager. Loss-making routes sit below the line
> in red and the drill-down tells you whether it's yield, cost, load factor or a
> competitor — and therefore whether to **reprice**, **re-gauge**, **re-time**,
> or **kill it**.

It leads `/finance`, above the statement: a player who opens that page to find
out why they are losing money should not scroll past four tables to reach it.

### The chart is a list, not a canvas

Every row is real text, every colour is a theme token, and the breakeven line is
a **border down the middle of each track** rather than a drawn axis — exactly one
pixel in every theme, and nothing to measure. A chart library would have brought
its own palette, which is the thing §14.6's _"colour never the sole carrier of
meaning"_ has to survive.

Bars grow right from the centre rule for profit and left for a loss, each a share
of the widest absolute value in the set.

### Five routes and three hundred (AC2)

Both fall out of one layout rather than needing a mode:

- **Rows are fixed height and the list scrolls in its own box.** Three hundred
  rows is nothing to render; three hundred rows pushing the page to 12,000px is
  the actual failure.
- **Ranking is what makes it readable at scale.** The extremes sit at the two
  ends, so the routes a player must act on are the first and last thing they see
  however many there are. No filter, no paging, and no "top ten" that hides the
  airline's worst route on page 31.

Ranked by **profit**, deliberately re-sorted from the breakdown endpoint's own
order — that one ranks by magnitude, biggest contributor first whichever
direction, which interleaves the best and worst routes.

### Colour is never alone (AC3)

A loss-making row carries three signals: the loss hue, a **hatched fill**, and a
`▼` glyph beside a figure that is already signed. Any one of them survives
greyscale, colour blindness or a screen reader reading only text. The legend says
the hatch is doing work, so it does not read as decoration.

---

## The drill-down: one cause, one action (M8-11)

`GET /api/routes/:routeId/diagnosis`. Four causes, four actions, paired
one-to-one, plus `none`/`keep` for a route that is fine — §14.4's chart ranks
profitable routes too, and naming their weakest lever as a problem would be an
invented finding.

| Cause         | Action       | What it means                                         |
| ------------- | ------------ | ----------------------------------------------------- |
| `yield`       | **reprice**  | selling too cheaply for what it costs to fly          |
| `cost`        | **re-gauge** | costs more per seat offered than the network average  |
| `load_factor` | **re-time**  | it could pay at a normal load; it is flying too empty |
| `competitor`  | **cut**      | a rival holds most of the market, so it will not fill |

### Why it is a decision tree and not a ranking of gaps

The obvious implementation compares each figure to the airline's median and names
whichever is furthest below. It answers for every route, including the routes
where it is **wrong**: a thin route whose cost base no load factor could cover
gets "re-time", and re-timing cannot help it.

So the classifier is the **breakeven load factor**, the one figure that says
whether a route is fixable by filling it:

```
contribution >= 0        → nothing to fix
BELF > 1                 → no load factor saves it   → cost or yield
BELF <= 1 and LF < BELF  → it is under-filled        → competitor or timing
```

`BELF > 1` means every extra passenger loses money, which is why M8-09
deliberately does **not** clamp it to 1. That unclamped value is what makes this
tree possible, and a test asserts the unfillable route is never sent to be
re-timed.

The peer medians are still there, as the three **quantified gaps** the response
always carries — how a player sees the working (§14.1), and how the tree chooses
between cost and yield. They are simply not the classifier.

### Two judgement calls

**Unknown competition means `load_factor`, not `competitor`.** Re-timing a route
a rival owns wastes a week; cutting a route that only needed re-timing throws a
market away. The cheaper mistake wins.

**The benchmark excludes the route being diagnosed.** A median a route sits
inside pulls toward that route's own figure, and the effect is largest exactly
when it matters most — a two-route airline would be comparing one against the
average of itself and one other.

The benchmark is the airline's **own** median, not a world median: §14.6 asks for
_"benchmarks against world median for your fleet size"_ and nothing computes one
yet. The panel says which it is rather than letting the other be assumed.

### Why the diagnosis is per route and on a click

The competitor cause needs App. A's share model run against the market. Three
hundred of those on one page load would make §14.4 the slowest screen in the
game. So the **chart** reads one grouped query however many routes there are, and
the **diagnosis** is one route at a time — the expensive half paid per question
asked rather than per render. A route whose market cannot be resolved still gets
a diagnosis, with the competitor cause simply unavailable.

---

## The operational dashboards (M8-12)

§14.3's other five — traffic, punctuality, fleet, crew and ground — at
`/operations`, from one `GET /api/statistics/operations`. Five sections rather
than five pages: they share one window and one read of `flight_result`, and five
separate reads would let five panels disagree about which flights were in the
period.

### Delay is attributed, and the unattributed part is a row

M2-08's taxonomy is `flight.disruption_cause`, and it was a database enum only
until M8-12 named it on the wire. A flight can arrive late with **no** disruption
row behind it — a slow turn, a long taxi, weather en route that never became a
recorded disruption.

Those minutes get an `unattributed` row. Dropping them would show a player _less_
delay than they actually suffered, and the sum of the causes would silently
disagree with the total beside it — the one thing an attribution must never do. A
database test asserts the causes add up to the headline, and the page says out
loud that the row is not one of M2-08's causes so it cannot be mistaken for one.
If the two ever do disagree, the page prints the difference rather than hiding it.

### Spill is a count first

> Spill is surfaced as 'passengers turned away', an actionable number.

A rate says you are losing 3.7% of something. A count says you turned away 1,240
people, which is a decision. Both are shown and the count leads.

### Cancellations come from the schedule, not from what settled

A cancelled flight never settles, so it has no `flight_result` row at all.
Counting only what settled would report a perfect cancellation rate on an airline
that cancelled everything.

### D0 and D15 are different questions

D0 is arrivals on time or early; D15 is the industry's fifteen-minute headline. A
flight nine minutes late counts for one and not the other, and showing only D15
would hide a whole airline's worth of small slippage.

### One chart language, enforced (AC3)

> Each dashboard shares one consistent chart language.

Every class the operations page writes must already be declared in
`dashboard.css`, `shell.css` or `ui.css`. `operations-ui.test.tsx` reads the
page's own source and fails on any class none of them declares, and asserts the
directory contains no stylesheet of its own.

A render assertion cannot see this: a page with its own `.ops-bar` looks fine in
jsdom and is a second visual vocabulary in the product. The delay chart therefore
reuses §14.4's row-and-bar markup rather than inventing a second bar — the one
difference being that its bars grow one way, because delay has no breakeven line
to sit either side of.

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
| §14.4's decision tree and the peer median | `packages/sim/src/statistics/route-diagnosis.ts`      |
| The diagnosis, fed real trading           | `packages/server/src/network/route-diagnosis.ts`      |
| The ranked chart and its drill-down panel | `packages/web/src/finance/RouteProfitChart.tsx`       |
| §14.3's five operational sections         | `packages/server/src/statistics/operations.ts`        |
| The operations page and its delay chart   | `packages/web/src/operations/`                        |

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
- **A world median benchmark** for the diagnosis levers (§14.6). The comparison
  is the airline's own median today, and the panel says so rather than letting a
  player assume otherwise.
- **§14.5's alerts** and §14.6's CSV export and world-median benchmarks.
- **A booking curve against departure** (§14.3's traffic list). Bookings are not
  modelled over time, so there is no curve to draw.
- **Vendor scorecards and turnaround against contract** (§14.3's ground list).
  Nothing measures a turnaround, so a score would be invented.
- **Satisfaction by class and route, and complaint drivers** (§14.3's reputation
  list). There is no per-cabin survey and no complaint model.
- **An airline-level product score.** M8-04 assembles one per cabin per package;
  averaging those into a single figure would be a number nothing computes, so the
  field is present and null.
- **Forecast inputs beyond the airline's own history**, as above.
- **Fleet, crew, ground and reputation metrics.** §14.3 lists seven dashboards'
  worth; M8-09 covers the traffic, commercial and financial figures that
  `flight_result` can answer. The rest need their own rollups.
