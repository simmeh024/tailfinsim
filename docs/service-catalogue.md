# Service and ancillary catalogue

What an airline serves, what it costs, what it earns, and how it reaches a
flight. Design doc **Appendix D**; built by **M8-03**.

This document is the boundary. It says what exists today, what is deliberately
elsewhere, and the two decisions M8-03 had to make because the appendix does not.

---

## The one rule

> **Tier sets the ceiling. Execution decides where you land inside it.**

Every category is a ladder of tiers, and every tier owns a **score band**. How
well the airline executes decides where inside its band a tier lands, and
nothing moves a tier outside it. So:

|                                          |      |
| ---------------------------------------- | ---- |
| A perfectly executed catering **Tier 2** | 0.42 |
| A badly executed catering **Tier 3**     | 0.45 |

The hot meal still wins. That is App. D.1's requirement that a basic offering can
never beat a luxury one however well run, and it answers the opposite failure
too: buying a high tier and running it badly is _"the most expensive mistake in
the catalogue"_, because you paid for the ceiling and got the floor.

**The rule is enforced, not trusted.** `ServiceCategoryBalance` in
`packages/shared/src/economy-config.ts` refuses to parse a ladder whose bands
touch or cross, or one that does not start at zero. It is the only balance
section in the file that validates its own numbers, and it does so because the
roadmap's line for this work is _"tune the service tier bands"_ — the rule has to
survive every future retune, not only the first write.

`ladderCrossings` in `packages/sim/src/service/bands.ts` states the same
guarantee in outcomes rather than intervals: every tier at execution 1 against
every tier above it at execution 0. That is the shape of the acceptance test,
and it catches a non-adjacent crossing that a neighbours-only check would miss.

---

## Where each thing lives

|                                                                     | Where                                                  | Why                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Categories, ladders, tier names, `requires`                         | `packages/shared/src/service.ts`                       | Identity. Not a number anyone tunes.             |
| Cost, revenue, score band, turnaround delta, intensity coefficients | `EconomyConfig.service`                                | Balance. Versioned, pinned per world, retunable. |
| Band arithmetic, package totals                                     | `packages/sim/src/service/`                            | Pure, and holds no balance literal.              |
| Packages, route groups, membership                                  | `service_package`, `route_group`, `route_group_member` | Player state.                                    |
| The API                                                             | `packages/server/src/service/`                         | Owner-scoped by query.                           |

**The catalogue is not a third pinned version.** A world pins
`economy_config_version` and `aircraft_catalogue_version`, and services were
deliberately not given a third. An aircraft type is thirty fields of physical
fact gated by entry-into-service dates; a service tier is a name and four
numbers. Splitting the name from the numbers would buy nothing and cost a
version nobody could explain the difference of.

**The catalogue is an endpoint, not a bundle.** `GET /api/service/catalogue`
merges the shared ladders with the caller's world's _pinned_ prices. Two worlds
on different economy versions see different prices for the same named tier,
which is the whole point of the balance being pinned — and a client that bundled
the numbers would show one world's prices in another's configurator.

---

## The seven ladders

`catering` is quoted from App. D.1, the only ladder the design doc writes out in
full. The other six are ordered from App. D.2's option lists.

| Category           | Tiers                                             | Direction             |
| ------------------ | ------------------------------------------------- | --------------------- |
| `catering`         | 0–5, nothing → chef-designed                      | spend                 |
| `baggage_seating`  | 0–3, everything charged → everything included     | spend (revenue falls) |
| `ife_connectivity` | 0–4, none → 4K seatback with free Wi-Fi           | spend                 |
| `amenities`        | 0–3, none → bedding and pyjamas                   | spend                 |
| `onboard_retail`   | 0–3, nothing sold → scratch cards and raffles     | **revenue**           |
| `ground_services`  | 0–4, nothing → lounge, arrivals lounge, chauffeur | spend                 |
| `atmosphere`       | 0–3, standard cabin → full scheme                 | spend                 |

Two directions, on purpose. Five ladders are **spend**: you buy score, so net
cost rises with the tier. `onboard_retail` is a **revenue** ladder — every rung
sells more to the same passenger — so its net cost _falls_, and its price is
paid in the satisfaction band rather than in money.

**Catering tier 1 is the documented exception.** App. D.1 writes buy-on-board as
"−€4.20 (net revenue)": it _earns_, so it undercuts tier 0's free nothing. It is
`costPerPaxMinor: 0, revenuePerPaxMinor: 420`, never a negative cost. Cost and
revenue stay two separate lines everywhere for this reason — M8-01's itemised
P&L wants them apart, and App. D.4's payback table divides by the cost alone.

### Where the numbers come from

Catering is quoted. Four more are anchored to App. D.3's two worked
configurations: **€13.30** of bag and seat fees (which D.3 states twice, once as
budget revenue and once as premium "forgone"), **€2.10** for free Wi-Fi and
streaming, **€0.60** of scratch cards at medium intensity, **€0.40** of
atmosphere. Everything else is invented to fit those anchors and says so in a
comment beside it. They are the least-supported numbers in the payload and the
first a balance pass should revisit.

D.3's composite service scores — 0.22 and 0.52 — are deliberately **not**
reproduced. A composite needs the per-cabin category weights, and those arrive
with M8-04.

---

## Commercial intensity

App. D.2's scratch-cards-and-raffles lever, one dial per package from 0 to 1. It
raises onboard retail revenue and costs satisfaction, both **linearly in the
dial** — half intensity takes half the extra money and half the satisfaction hit
— and past `reputationRiskAbove` it carries a §15 reputation risk.

Linearity is the design, not a simplification: it is what makes the trade legible
to a player, and it is the acceptance criterion ("raises revenue and lowers
satisfaction proportionally") in one line.

The dial multiplies **onboard retail revenue only**. Applying it to, say,
checked-bag revenue would make it a second baggage policy rather than the retail
behaviour it describes. With retail at tier 0 there is nothing to push and the
dial earns nothing — a package is not paid for an attitude.

The appendix's constraint on these coefficients is unusual and worth keeping in
view when they are retuned: the strategy must be _"fully supported without being
optimal"_. A `revenueMultiplierAtMax` large enough to make maximum intensity the
obvious choice has broken the appendix rather than tuned it.

---

## Route groups — the decision the appendix left open

App. D.5 says packages are assigned _"per route group, not per aircraft"_, so
_"a single airframe flies a leisure config in the morning and a business config
in the evening"_ — and then never defines a route group. M8-03's definition:

> A route group is **player-defined**: a name and a set of that airline's routes.
> A route belongs to **at most one** group.

The alternative was to derive groups from each route's segment mix. That reads
well until a player wants two products on two leisure routes and the game will
not let them. The appendix's own justification for groups is that they _"keep the
system from becoming per-flight micromanagement"_ — an argument about
granularity, not about who decides. So the player decides, and the granularity is
the group.

**One group per route is a database guarantee**, not a convention:
`route_group_member.route_id` is unique across the whole table. That is what
makes "which package does this flight fly under?" a question with exactly one
answer, and joining a second group is also a departure from the first.

**A route in no group has no package** and flies the world's baseline product.
That is deliberately _not_ the same as an empty package, which is a package the
player wrote and which costs and scores accordingly. `servicePackageForRoutes`
leaves such a route **absent from its map** rather than present with a null, so
the two cannot be confused by a caller.

### How a package reaches a flight

A `flight` row carries no route id. It carries an airline and an airport pair,
and `route`'s unique `(airline_id, origin_icao, destination_icao)` is what turns
that pair back into exactly one route:

```
flight (airline, origin, destination)
  → route            (that unique triple)
  → route_group_member
  → route_group
  → service_package
```

Nothing is copied onto the flight. Changing a group's package changes what every
future flight on those routes serves, which is what App. D.5 asks for.

---

## Execution — where inside the band you land (M8-04)

```
Execution = f( crew service skill (§10.2) · crew morale (§9.2)
             · catering vendor quality (§9.3) · crew-to-passenger ratio )
```

> **The weakest input dominates.**

`sim/service/execution.ts` blends toward the minimum: `w·min + (1−w)·mean`, with
`w` in the economy config and shipped at 0.65. Not a pure minimum, because that
makes every other lever worthless once one is low — an airline with one weak link
would then have no reason to fix anything else.

**A lever with no source is absent, not zero.** Two of the four have none today,
and the distinction is the whole airline: counting a missing training academy as
0 would peg every carrier in the game at its band floor for a system nobody can
use yet.

| Lever                   | Source                                                          | Today                 |
| ----------------------- | --------------------------------------------------------------- | --------------------- |
| crew morale             | `crew_base.morale` at the origin, **through M5-03's own curve** | read                  |
| catering vendor quality | the origin's catering contract grade                            | read                  |
| crew service skill      | §10.2's training academy                                        | absent (M10)          |
| crew-to-passenger ratio | a flight's carried load against its rostered crew               | absent above a flight |

**Morale arrives already translated.** M5-03 built `crew/morale.ts`'s
`serviceExecution(morale)` and deliberately left it unconsumed, warning that a
caller who multiplied it into something would be making M8-04's decision early.
That curve runs **0.7 → 1.0** — "even a mutinous crew delivers most of what was
paid for" — which is why morale _alone_ cannot reach a band floor. App. D.1's
sentence has two halves, and it takes an exhausted **and understaffed** crew.

Feeding raw morale into the weakest link instead would silently use a second,
untuned curve.

## ProductScore — one composite, assembled once (M8-04)

```
ProductScore = w_seat·seat + w_service·band_position + w_ife·ife + w_ground·ground
```

Weights are **per cabin class and live in the economy config**, and each cabin's
four must sum to 1 (a schema refinement, so a retune cannot ship scores above
one). `PRODUCT_SCORE_TERM_OF_CATEGORY` maps the seven catalogue categories onto
the four terms; that mapping is identity, not balance.

**`seat` has no source yet** —
[M6-09](https://github.com/simmeh024/tailfinsim/issues/65) owns §6.4's comfort
score. Its weight is **redistributed across the terms that do have one** rather
than multiplied by zero. Zeroing it would cap every business-class product at
`1 − 0.5` uniformly, for a reason no player could act on.

**Nothing else computes one.** `product-score-source.test.ts` scans `sim`,
`server` and `shared` for a module assigning a product-score literal and allows
only four places, each with a stated reason. It caught two on the way in:
`REFERENCE_SELF.productScore` and `PLAYER_ASSUMPTION.productScore`, both a flat
`0.6`, both reasonable local decisions when they were made.

`server/src/service/product-score.ts` is the one resolver that feeds real state
in, and `createEconomicsProvider` calls it once per route. A **rival's** package
is resolved for real too — a competitor's product is not private to the
simulation, since App. A.3 cannot allocate passengers without it — but their
_execution_ stays the configured reference, because reading every competitor's
crew base and contracts on every route view is a query per rival per lever for a
number the viewer sees as an estimate.

## What is still not built

- **The payback table.** App. D.4's cost-per-pax against supported fare premium,
  live as you toggle options, is **M8-05**.
- **Settlement.** A flight is still not _charged_ for its service. `ProductScore`
  now feeds demand, but `packageEconomics`' cost and revenue per passenger reach
  no ledger line yet.
- **Seat comfort** (M6-09) and **crew service skill** (§10.2), as above.
- **A web configurator.** The API is complete; no page consumes it yet.

---

## Operational notes

**Nothing here is a worker story.** Unlike most of M4 and M5, the service
catalogue has no sweep, no queue and no heartbeat counter — a package is read on
demand and resolved by query. A production world with no worker configures
service exactly as dev does. What production still cannot do is _fly_, so the
configuration has nothing to apply to; that is the missing worker, not this
subsystem.

**Deleting a package a group still flies is refused**, with a 409 naming the
groups. The foreign key is `ON DELETE SET NULL` rather than `RESTRICT` on
purpose: deleting an airline cascades into `service_package` and `route_group` at
once, and a RESTRICT would turn an ordinary airline deletion into a constraint
error. The API is where the refusal belongs, because it can say why.

**A package this build cannot parse is omitted from the list**, not returned
broken — the rule `wireAirline` already applies to an unsupported logo. The row
is untouched, so a build that understands it again lists it again.
