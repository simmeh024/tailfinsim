# The research tree — "Operational Doctrine"

§10.3's research tree is the airline-wide half of §10's progression layer: _"skill trees make
one pilot good, research makes your whole airline good."_ This document is the current contract
for M9-05 — where research points come from, what a node costs, how tiers are gated, what a
completed node is worth, and what is deliberately **not** built yet.

Design reference: `docs/tailfin-design-doc.md` §10.3 and §10.4. Where this document and the
design doc disagree about current behaviour, this one describes what the code does, and the
conflicts are listed at the end.

---

## Research points

```
RP/day = Σ(academy levels) × academyStaffQuality × (fleet flight hours ÷ scalingFactorHours)
```

§10.3 names both free terms and leaves them open. Issue #92 asks for them to be defined
explicitly, and they live in `EconomyConfig.research.pointsFormula`:

| Term                  | What one unit means                                                             | Shipped |
| --------------------- | ------------------------------------------------------------------------------- | ------- |
| `scalingFactorHours`  | The block hours that make one **aircraft-day** — one aeroplane's ordinary day   | 8       |
| `academyStaffQuality` | Research points **one academy level** draws from **one aircraft-day** of flying | 1.0     |

So on the shipped balance **every academy level earns one point for every aircraft-day the fleet
flies**. `fleet flight hours ÷ scalingFactorHours` reads as "how many aircraft-days did the fleet
fly", and it is the only place an airline's size enters the formula — multiplied by the
academies, never on its own. Staff quality is one number for the whole world today; if something
later lets one academy's instructors be better than another's, it multiplies there.

Flight hours are **block hours**, the figure settlement already bills crew and maintenance
against. `Σ(academy levels)` is the sum of the airline's **commissioned** levels: a building site
(level 0) counts nothing, and a level under construction counts the level below it until the
worker commissions it.

### What that gives, at three sizes of airline

| Airline           | Fleet | Block h/day each | Σ levels          | RP/day |
| ----------------- | ----- | ---------------- | ----------------- | ------ |
| small             | 5     | 8                | 1 (Training Room) | 5      |
| mid               | 30    | 10               | 5                 | 187.5  |
| large             | 90    | 12               | 12                | 1,620  |
| large, no academy | 90    | 12               | 0                 | **0**  |

The last row is §10.3's _"a big airline that never built academies generates almost none — size
alone doesn't buy competence"_, and it is exactly none rather than almost.

### Earned per flight, summed per day

Points are credited **per settled flight**:
`RP(flight) = Σ(levels) × quality × (blockHours ÷ scalingFactorHours)`. The formula is linear in
flight hours, so a game day's flights sum to exactly the per-day figure, whatever the mix of
sectors. Nothing has to run at midnight to do the day's sum, so nothing can miss a midnight.
`packages/sim/src/research/points.test.ts` proves the sum against the formula.

`accrueResearchPoints` runs inside `settleArrivedFlight`, **after** the `flight_result` insert
has proved the arrival is not a replay — the same position and reason as `accrueFlightHours` and
the crew XP award — so a flight's points accrue once, in the same transaction as its money. The
accrual is recorded on `flight_result.breakdown.research`
(`points, academyLevelSum, academyStaffQuality, scalingFactorHours, blockHours`) **even when it
is zero**, so _"why did I earn nothing?"_ has an answer on every flight.

### Stored as integer milli-points

`research_account` holds `earned_milli` and `spent_milli`, two monotonic integer counts of
thousandths. A 50-minute sector at a Training Room earns about a tenth of a point; rounded to
whole points it would earn nothing, and a small airline — the one the formula is meant to be
_slow_ for — would be stopped instead. The balance is `earned − spent`, and a CHECK refuses
`spent > earned`. There is no row until an airline first earns something.

---

## You cannot buy research points

§10.3: _"You cannot buy RP."_ Issue #92: _"Research points cannot be purchased through any
path."_ Held by the shape of the code, and a source-scan test (`research/no-purchase.test.ts`)
holds the shape:

1. Only `research/points.ts` names the `research_account` table. Its `accrueResearchPoints` is
   the only thing that raises `earned_milli`; `debitResearchPoints` only raises `spent_milli`
   and refuses a non-positive amount, so a debit cannot be turned into a credit.
2. `accrueResearchPoints` is called from `flight/settle.ts` and nowhere else.
3. No admin route or CLI reaches either, the only research routes are the read and the start,
   and the economy schema has no field that could turn cash or time into points.
4. `researchPoints`, `earnedMilli` and `spentMilli` are on SEC-09's list of server-owned
   financial fields, so every strict write contract is tested to refuse them.
5. The database CHECKs are the last line.

---

## The tree

Six branches of four tiers, one node per cell — §10.3's own sample nodes. The tree's shape is
**design** and lives in `@tailfin/shared`'s `research.ts`; what a node costs and what it removes
is **balance** and lives in `EconomyConfig.research.nodes`, pinned per world.

### Tier gating

| Tier | Needs an academy at level | That level's name      | In this release |
| ---- | ------------------------- | ---------------------- | --------------- |
| 1    | 1                         | Training Room          | yes             |
| 2    | 3                         | Flight Academy         | yes             |
| 3    | 4                         | Full-Flight Sim Centre | **no**          |
| 4    | 5                         | Centre of Excellence   | **no**          |

Read from §10.1's own _"Research tier"_ column (`academyLevelForResearchTier`), so the gate and
the academy ladder cannot disagree. The level is the **highest commissioned** academy the airline
holds — research is airline-wide, so one Flight Academy anywhere opens tier 2 everywhere.

**Issue #92: the MVP ships tiers 1–2.** Tiers 3 and 4 are in every response, priced in full and
labelled with the academy they need, and refused with `not_released` even to an airline whose
academy would open them. They carry **no effects**: several are capabilities nothing models yet
(ETOPS authority, in-house heavy checks), and an effect on a node nobody can complete would be a
promise the release does not keep.

Each node needs the tier below it **in the same branch** complete first.

### What a node costs

Priced by **tier**, not by branch: what a branch is worth depends on the network, and pricing
one above another would make the choice arithmetic rather than character.

| Tier | Points | Cash  | Build (game weeks) |
| ---- | ------ | ----- | ------------------ |
| 1    | 100    | $30K  | 3                  |
| 2    | 600    | $100K | 6                  |
| 3    | 2,500  | $300K | 10                 |
| 4    | 8,000  | $800K | 16                 |

A small airline with a Training Room earns its first tier-1 node's points in twenty game days,
so its first doctrine is a three-week wait and a three-week build — and a small airline stays
bound by **points**. A mid-sized airline earns a tier-2 node in about three days and a large one
in nine hours, so they are bound by the **build weeks** instead: one project runs at a time, and
the twelve released nodes take 54 game weeks back to back however many points are banked. Cash
is scaled against the academy that gates each tier and is never the scarce thing.

### What a node removes

| Branch               | T1                                    | T2                                          |
| -------------------- | ------------------------------------- | ------------------------------------------- |
| Fuel & Performance   | Cost-index SOP: fuel −1.5%            | Continuous descent: fuel −1.8%, block −1.6% |
| Turnaround & Ground  | Boarding SOP: turnaround −3.5%        | Parallel servicing: turnaround −4.5%        |
| Safety & Reliability | Reporting culture: incidents −5%      | Predictive fault detection: incidents −7%   |
| Service & Cabin      | Service standards: service cost −2.5% | Signature service: service cost −3.5%       |
| Crew Development     | Efficient conversion: crew XP +4%     | Cadet pipeline: crew XP +6%                 |
| Maintenance          | Line efficiency: maintenance −2%      | Predictive maintenance: maintenance −2.8%   |

A branch's two released tiers together fill **about 40%** of their §10.4 ceiling (fuel 41%,
block 40%, turnaround 39%, incidents 39%, service cost 39%, maintenance 40%). M9-03's skills
already reach about half of each with one veteran, so skills and research together reach or pass
most ceilings — and the resolver's multiplicative stacking plus the hard cap does the rest. What
the numbers decide is that **no single source fills a ceiling alone**. `crewXp` is a rate added
to the XP crew earn, 10% for both nodes together, about a sixth of M9-04's combined XP cap.

Every effect is a cost or a duration (§10.4: _"never demand or money directly"_), and a
`superRefine` on the balance holds each released node's effects to exactly the quantities its
catalogue entry targets, and every unreleased node's to none.

---

## Projects

`POST /api/research/projects` with `{ nodeId }` starts one. In one transaction it:

1. locks the airline's `research_account` row — which serialises every start for the airline;
2. reads the projects, academies and cash, and asks `researchNodeState` for the verdict;
3. debits the points, moves the cash as a `research` movement referenced
   `<airlineId>:research:<nodeId>` (ledger category `crew`, beside the academies that teach it),
   and inserts the `research_project` row.

Refusals are `409 { code, message }` with `code` from the closed `ResearchRefusal` set, checked
in this order: `already_complete`, `already_in_progress`, `academy_level`, `not_released`,
`prerequisite`, `project_running`, `insufficient_points`, `insufficient_funds`. The first five
describe the node; `project_running` is the **one project at a time** rule, which no constraint
can state because "running" depends on the game clock, so the row lock holds it. The tree's
`startRefusal` on each node is the same function's answer, so the button and the 409 cannot
disagree.

### Build time is game weeks, and nothing shortens it

§10.3 says points are generated _"per real day"_ and that you _"cannot rush it"_. The weeks are
the **world's** (ADR-0026), exactly as §10.1's academy construction is, and `research_project`'s
`started_at` and `completes_at` are game instants. Nothing shortens a project:
`researchCompletesAt(startedAt, buildWeeks)` has no third parameter, and there is no rush cost,
no multiplier and no route.

### Completion is lazy

A project is complete exactly when the world's clock has reached `completes_at`. There is **no
sweep and no status column**: every read asks `isResearchComplete(project, gameNow)`. Nothing a
missing worker can leave undone, and nothing for ADR-0005's world reset to forget.

---

## The API

| Route                         | What it does                                                   |
| ----------------------------- | -------------------------------------------------------------- |
| `GET /api/research`           | The whole tree, the airline's points, the formula, the academy |
| `POST /api/research/projects` | Start researching one node                                     |

`requireAirline` to read, `requireActiveAirline` to start. No handler accepts an `airlineId` and
no route takes a path id; the body's `nodeId` is a **selector over the fixed catalogue**, not an
owned resource (SEC-07 classifies it `computed-selector`), so there is nothing of another
player's to conceal — their progress is simply not in the query. The start returns the whole
`ResearchResponse`, like the academy and roster endpoints.

`points.recentPerDay` is the points recorded on the airline's flights settled in the last seven
game days, divided by seven — an observation, understating a brand-new airline on purpose.

---

## This is half a worker story

Research **completion** works on every node, production included, because it is lazy. Research
**points** accrue only in settlement, which is the `FLIGHT_ARRIVE` handler, which only the worker
runs. So on production every airline sits at **0 RP for ever**, and the tree reads _"no
academy"_ or _"fly more"_ rather than _"no worker"_. There is no counter of its own: points are a
side effect of an arrival, so `flightsMaterialised` and the queue depth are what to look at.

---

## Doctrine applied, upkept and lapsing (M9-06, §10.4)

> _"Boosts are **operational efficiency**, never demand or money directly. They make you
> cheaper and faster, not more popular."_

### One resolver, every source, every consumer

`resolveAirlineEfficiency` (`server/src/economy/efficiency.ts`) gathers §10.4's three sources —
named crew's skill points, Training Captains at their reduced line value (M9-04) and completed
doctrine at its current strength — and hands them to `resolveEfficiencyBoosts` **together**,
against the world's own ceilings. Stacking is multiplicative (diminishing returns before the
cap) and the cap is applied once to the sum, so three sources each at the ceiling still give the
ceiling. A seeded property test in `sim/economy/boost-resolver.test.ts` hunts for the stack that
breaks it.

Every consumer reads its quantity from that one resolution and is handed the resolved fraction
as a single boost (`appliedBoosts`):

| Quantity      | Ceiling | Consumer                                                               |
| ------------- | ------- | ---------------------------------------------------------------------- |
| fuel burn     | −8%     | `settleArrivedFlight` → `computeFuelBurn`                              |
| block time    | −4%     | `settleArrivedFlight` (billed block) and `placeLegs` (the planned leg) |
| maintenance   | −12%    | the settlement's per-block-hour reserve, and a check's price           |
| incident rate | −30%    | the departure disruption roll                                          |
| turnaround    | −20%    | `turnaroundResolver` (the planned turn)                                |
| service cost  | −15%    | App. D's per-passenger cost in the service configurator                |

Two consequences worth knowing. **The schedule is a plan**: block time and turns are fixed when a
rotation is saved, like the handler and the stand, so new doctrine shortens a rotation the next
time it is saved. And **App. D's service cost is not billed per flight** — M8-03 left it as
decision support — so the service-cost reduction reaches the configurator's cost, net and
payback, which is where that cost lives today.

Crew Development doctrine is not one of the six: it adds to the **crew XP** rate, on every head
aboard, capped together with the Training Captains' bonus under
`crew.trainingCaptain.maxXpBonus` (M9-04), so the two can never sum past the cap.

The academy is **not** a source, by §10's core rule: it gates the ceiling and never grants the
boost. Its whole contribution arrives through the tier it opens, the Training Captains it permits
and the points its levels earn.

### Nothing reaches demand — held by a test, not a promise

`server/src/economy/boost-isolation.test.ts` walks the source: every module in
`sim/src/demand`, and every module that imports one of its functions or input types, must not
name any of the boost machinery. Feeders are discovered rather than listed, so a new market-share
readout is covered the day it is written. It was mutation-checked against a server feeder
(`network/competition.ts`) and a sim one that only imports types (`npc/carrier.ts`). This is the
acceptance criterion _"a test asserts no boost writes to any demand-model input"_.

### Upkeep, and the lapse

A completed node costs **5% of the price paid** a game month while it is funded
(`research.upkeep.monthlyFractionOfCashCost`): $1.5K for a tier-1 node, $5K for tier 2, about
$39K for the whole released tree — a Centre of Excellence's upkeep, on purpose. The player may
stop funding a node (`PUT /api/research/projects/:nodeId/funding`, a level not a toggle). It then
**lapses linearly over 8 game weeks** and, funded again, **recovers over 4** — so a stop and a
restart cost a stretch of both, never a free reset. That is the acceptance criterion _"ceasing
upkeep visibly decays the advantage over game weeks"_: the page shows each node's strength, the
date it settles and its effects at that strength, the efficiency readout falls with it, and a
flight is billed at the strength the doctrine had when it landed.

The strength is a **pure function of three columns** written when funding last changed
(`funded`, `funding_changed_at`, `strength_at_change_permille`). Nothing ticks it down, so the
decay is true whether or not anything runs, and a replay reads the strength it had then. A null
`funding_changed_at` means _funded since completion_, which is every row written before M9-06.

The month is billed **in arrears**, once, for every node that was funded at any instant of it —
so switching off on the last day does not escape that month — as one `research_upkeep` movement
referenced `research_upkeep:<airlineId>:<YYYY-MM>`. A funding change bills any closed month
**before** it records itself, which is what makes a month's facts final once it closes: the
worker and the handler always compute the same bill.

### The worker story, completed

Upkeep is billed by `runResearchUpkeep`, the academy upkeep's shape exactly, on the world's game
clock (`researchUpkeepPaid`, `researchUpkeepMinor`, `researchErrors`). **Production has no
worker**, so there doctrine is never billed — and never applied either, because settlement and
the disruption roll are the worker's too. The page still shows the lapse arithmetic and the
schedule plan still reads the resolved turnaround, because those are not worker paths.

---

## What M9-05 deliberately did not build

- **Tiers 3 and 4.** Priced, shown and refused, with no effects (issue #92).
- **Cancelling or refunding a project.** §10.3 gives a price and a wait and no way back.

## Design-document conflicts

- **"Per real day" and real build time.** §10.3 generates points _"per real day"_ and §10.1
  builds in _"real weeks"_. ADR-0026 settled both onto the world's clock; points accrue per
  flight on game time and projects run in game weeks.
- **"Best-in-class product multiplier"** (Service & Cabin T4) names a demand effect, which §10.4
  forbids. It is unreleased with no effect until the design document resolves it.
- **"Almost none"** — §10.3 says a big airline with no academies generates _almost_ none; the
  formula as written gives exactly none, and that is what is built.
