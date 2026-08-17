# TAILFIN
### Design Document v1.4 — Full Feature Outline

> **Name:** Tailfin
> **Genre:** Real-time online airline management sim
> **Domain:** tailfinsim.com
> **Platform target:** Browser-first (desktop + mobile web), persistent server
> **Presentation:** Modern flat UI over a live world — **player-selectable 2D flat map or 3D globe** (App. H)
> **Time model:** Continuous real time at **2× speed** — a 10h flight lands in 5h
> **Flagship world epoch:** 20 October 2024
> **World model:** Single shared persistent world; all players compete in the same market

Sections marked **`[MVP]`** are in scope for the first shippable build; **`[MVP-lite]`** means a reduced version ships in MVP with depth added after. Everything else is the long-term vision — documented now so the MVP is architected to grow into it.

---

## 1. The Pitch

You start with one leased aircraft and one airport. You paint it, you fit the cabin, you pick a route, and you watch it fly — in real time, on a live world map, alongside every other player's fleet. Nothing is instant. A widebody to the other side of the world is a half-day commitment. Your airline becomes a thing that exists whether you're watching or not.

The two pillars:

1. **Time has weight.** 2× real time means routes are decisions, not clicks. Long-haul is a genuine capital commitment. Short-haul is a grind with volume. Turnarounds, curfews, and slot windows matter because you can feel them.
2. **Your airline looks like *yours*.** The livery and cabin builders are not a cosmetic afterthought — they are the identity system and a real gameplay input. Passengers respond to brand and product, not just price.

**Player fantasy:** "That's my airline. I designed that tail. I chose those seats. And it's flying to Singapore right now while I sleep."

---

## 2. Core Loop

**`[MVP]`**

```
ACQUIRE aircraft  →  CONFIGURE (livery + cabin)  →  STAFF (crew + ground chain)
      ↑                                                    ↓
      │                                             ASSIGN to route + PRICE
      │                                                    ↓
   REINVEST  ←  EARN revenue  ←  FLY in real time (2×)  ←──┘
```

**Session shapes** — the game must reward all three:

| Session | Length | What the player does |
|---|---|---|
| Check-in | 1–3 min | Glance at map, clear alerts, adjust a fare, dispatch idle aircraft |
| Operate | 10–20 min | Plan a route, run the numbers, handle a disruption, rebalance the schedule |
| Create | 30–90 min | Livery design, cabin layout, brand identity, fleet-wide rollout |

The creative session is the retention hook. The check-in session is the habit.

---

## 3. Time & Simulation

### 3.1 The 2× clock **`[MVP]`**

- World time runs at 2× wall-clock, continuously, server-authoritative.
- A 12h ULH flight = 6h real. A 1h regional hop = 30 min real.
- **The sim never pauses.** Flights progress while the player is offline. This is the point.
- One in-game day = 12 real hours. Two in-game days per real day.
- Server tick: coarse (~1/sec) for flight position interpolation; economic resolution at flight events (departure, cruise entry, arrival).

**Design tension to watch:** offline progression must feel like your airline living, not like the game playing itself. Rule of thumb — **flights complete offline, decisions never do.** The delegation tier (§9.5) is not an exception to this: a delegated Ops Controller executes *the policy you already wrote*, and any situation outside that policy waits for you. An arriving aircraft goes idle at the gate and waits for you. It doesn't auto-reassign unless you explicitly set up a repeating schedule.

### 3.1b The epoch — world start date **`[MVP]`**

**The flagship world starts on 20 October 2024.**

Every world has an **epoch** (its in-game start date) and a **speed multiplier**, both set at creation by an admin (§19). The flagship world runs `epoch = 2024-10-20`, `speed = 2×`.

```
InGameDate = Epoch + 2 × (real time elapsed since world launch)
```

#### The catch-up property — a genuinely useful design consequence

The epoch sits in the past while the world runs at double speed, so **the in-game calendar closes on reality by one day for every real day that passes.** With a launch around mid-2026, the gap is ~666 days, and the world converges with real time in **mid-2028** — after which it overtakes reality and runs into a speculative future.

This is not a quirk to hide. It structures the whole content plan:

| Era | In-game period | Content sourcing |
|---|---|---|
| **Catch-up** | epoch → convergence | Real history is *known*. Aircraft deliveries, fuel prices, and world events can be authored from the actual record. |
| **Convergence** | ~mid-2028 | The world "arrives at today." A one-time in-world moment worth marking. |
| **Beyond** | after convergence | Reality can no longer supply events — the world becomes **speculative**. Procedural events, announced-but-undelivered aircraft, and plausible near-future scenarios take over. |

Practically: **you get roughly two years of real, verifiable world data to build on before you must invent.** That's a long runway to build the procedural generator properly, and the transition is a natural marketing beat.

### 3.2 Time-skip policy **`[MVP]`**

No fast-forward, no time acceleration purchase. It would dissolve the core premise. Instead:

- **Schedules** let you queue a repeating rotation so aircraft keep working while you're away *by your prior design*.
- **Offline arrival digest** — you come back to a readable feed of what happened.

### 3.3 Flight lifecycle **`[MVP]`**

`Scheduled → Boarding → Pushback → Taxi → Departure → Climb → Cruise → Descent → Approach → Landing → Taxi-in → Turnaround → Idle`

**Failure branches**, reachable from the phases where they make sense: `Delayed` · `Cancelled` (pre-departure) · `Returned to stand` (pre-taxi) · `Air-return` · `Diverted` (in-flight). Each carries its own cost, passenger-rebooking obligation and reputation consequence (§8.4, §15).

Each phase has a duration and can host events. Turnaround time is a real cost driver and is affected by cabin config, ground staff level, and airport congestion.

---

## 4. The Map & Flight View

### 4.1 World map **`[MVP]`**

- **Two selectable projections of one world — flat 2D map or 3D globe** — switchable at any time, same data, same interactions (full spec in App. H).
- Scrollable and zoomable, with a live day/night terminator.
- Aircraft render as top-down livery sprites on great-circle paths, moving continuously.
- **Live route lines** drawn between served city pairs, weighted and coloured by traffic, with your network distinguished from everyone else's.
- Filter layers: my fleet / all traffic / route profitability heat / delays.
- Click any aircraft → flight detail panel (load factor, ETA, fuel, revenue projection).

### 4.2 Flight detail view **`[MVP-lite]`**

- Progress bar with phase markers, live ETA, altitude/speed readout.
- Passenger manifest summary by cabin class, satisfaction meter.
- **Post-MVP:** side-on cross-section of *your actual cabin config* with passenger dots, live satisfaction bubbles, cabin service events. This is where the cabin builder pays off emotionally.

### 4.3 Airport view **`[MVP-lite]`**

- Gate list, your aircraft on stand, turnaround timers, departures/arrivals board.
- **Post-MVP:** 2D apron layout, gate assignment as a puzzle, visible congestion.

---

## 5. Livery Builder — Signature Feature

**`[MVP]`** — this ships in the first build, deliberately expansive.

### 5.1 Canvas model

Layered vector editor on a side-profile aircraft template. Each aircraft family has its own template (A320 family, 737 family, 787, A350, ATR/Dash, E-Jets…). Templates share a layer schema so a livery applies fleet-wide with per-type adjustment.

Templates exist in **two projections**: side profile (for the builder) and top-down (for the world and airport maps). One livery document renders to both.

**Zones:** fuselage · nose · belly · tail/fin · winglets · engine nacelles · wings · cheatline band · door surrounds · registration area

### 5.2 Tools **`[MVP]`**

- Base fill: solid, linear gradient, radial gradient, split
- Cheatline: multi-stripe, adjustable width, angle, sweep, taper
- Shape layers: rectangle, ellipse, polygon, bezier path, boolean ops
- Text: airline name on fuselage, custom fonts, arc/skew along fuselage curve, drop shadow, outline
- Logo: place on tail, nacelle, winglet; scale, rotate, mirror
- Masking + clipping to zone boundaries
- Layer order, opacity, blend modes
- Colour: full picker, HEX/RGB input, saved brand palette, eyedropper
- **Registration plate:** auto-placed, player-defined prefix (e.g. `PH-`), auto-incremented per airframe

### 5.3 Logo creation **`[MVP-lite]`**

- In-app symbol composer: shape primitives, curves, mirroring, radial repeat
- Library of neutral base marks (bird, chevron, star, wave, crest, roundel) to modify
- **Post-MVP:** SVG upload with moderation queue

### 5.4 Fleet identity system **`[MVP]`**

- **Livery = a saved brand object**, not a per-aircraft paint job.
- Apply to a whole fleet, a sub-fleet, or one airframe.
- **Variants:** standard, retro, special/one-off, cargo, alliance scheme
- Repainting costs money and takes hangar downtime — scaling with aircraft size

### 5.5 Post-MVP livery features

- Weathering/age (paint fades; a repaint is a visible refresh)
- Nose art, special titles, decal library
- Community showcase: browse, like, and fork other players' liveries
- Livery contests with in-game reward
*(moved to MVP — see §5.1; the map and airport views both render liveries from day one)*

---

## 6. Cabin Builder — Signature Feature

**`[MVP]`** — a real systems layer, not decoration.

### 6.1 Layout **`[MVP]`**

- Top-down floorplan of the actual aircraft type with real cabin dimensions and exit constraints.
- Drag-place **zones** front-to-back; each zone has a class and a seat product.
- Hard constraints: exit row spacing, maximum certified seat count, galley/lav minimums per pax count, weight & balance.
- Live readout: total seats by class, effective range impact, turnaround estimate, config cost.

### 6.2 Seat products **`[MVP]`**

| Class | Products (cheap → premium) |
|---|---|
| Economy | Slimline high-density · Standard · Extra-legroom rows |
| Premium Econ | Recliner · Wide recliner |
| Business | Angled lie-flat · Full-flat 2-2-2 · Full-flat 1-2-1 direct aisle · Reverse herringbone |
| First | Enclosed suite · Suite with door · Residence-tier |

Each product has: pitch, width, weight, unit cost, comfort score, maintenance cost.

### 6.3 Cabin fittings **`[MVP-lite]` / Post-MVP**

- Galleys, lavatories, crew rest, bar/lounge module, self-service snack bar
- IFE tier: none / seatback / streaming / 4K + power + wifi tier
- Ambient design: seat fabric/leather colour, trim, carpet, mood lighting scheme, bulkhead artwork — all inheriting from your brand palette
- Amenity/service tier per class: meal quality, bedding, amenity kit — **full catalogue in Appendix D**

### 6.4 Why it matters mechanically **`[MVP]`**

Every config is a trade:

```
seats ↑  →  revenue potential ↑  ·  comfort score ↓  ·  weight ↑ → range ↓, fuel ↑
premium ↑ →  yield per seat ↑    ·  seat count ↓     ·  config cost ↑, turnaround ↑
```

**Product score** (weighted from seat comfort, IFE, service tier, cabin ambience) feeds directly into demand capture and price tolerance. On a business-heavy trunk route, a good J cabin wins share from a cheaper competitor. On a leisure route, it's dead weight.

### 6.5 Post-MVP

- Cabin templates saved as **"Products"** with player-given names (e.g. "Tailfin Signature Business") and marketed as such
- Retrofit programmes: fleet-wide cabin upgrades scheduled over weeks with aircraft downtime
- Cross-section view of your cabin in the live flight panel

---

## 7. Fleet

### 7.1 Aircraft **`[MVP]`**

Launch set of **18 types** (App. C.2) spanning: regional turboprop, regional jet, narrowbody (short + long variants), widebody twin, ULH widebody, freighter.

Each type: capacity envelope, range, cruise speed, fuel burn, purchase price, lease rate, maintenance profile, turnaround baseline, runway requirement, noise rating.

**Real specifications, and configurable at order.** The full catalogue and the manufacturer options configurator are in **Appendix C** — players order custom builds (extended range, higher MTOW, high-density, engine variant), and every option is paid for in seats, payload, weight, cost or delivery time.

### 7.2 Acquisition **`[MVP]`**

- **Lease** — low upfront, monthly drain, available immediately. The MVP entry path.
- **Buy used** — market of listed airframes with age, hours, and existing config
- **Buy new** — cheapest per-hour long-run, but **delivery slots are weeks out** (real time). Ordering is a bet on your future network.

### 7.2b Era gating — aircraft unlock by in-game date **`[MVP]`**

The aircraft catalogue is **keyed to the in-game calendar**, not to player level. Every type carries real dates:

```
Aircraft {
  first_flight        // prototype availability
  entry_into_service  // orderable by everyone
  production_end      // no new-build after this
  restriction_dates[] // progressive: noise quota bans, emissions charges, curfew exclusions
  out_of_service      // hard date: type may no longer be operated at all
}
```

An aircraft simply **does not exist** in a world whose clock hasn't reached it. In a 2024-epoch world you fly current metal and watch the next generation arrive on schedule. In a **1950s world** you start on DC-3s and Constellations, and the arrival of the 707 is a world-shaking event that obsoletes half the fleets in the game overnight.

**This is the best thing era-gating buys you:** the fleet meta *changes underneath everyone simultaneously*. Nobody is permanently ahead, because the aircraft that won last decade become noise-banned liabilities in the next. It's a natural, non-punitive reset that doesn't require wiping the world.

Retirement pressure is real too: noise regulations, emissions rules, and fuel price shocks progressively strangle old types rather than deleting them. Your beloved fleet becomes uneconomic before it becomes illegal.

### 7.2c Prototypes & launch customers **Post-MVP**

Between `first_flight` and `entry_into_service`, a type exists in a **prototype window** — and this is where the risk-appetite gameplay lives.

| Path | What it means |
|---|---|
| **Launch customer** | Commit capital before certification. Deep discount, priority delivery slots, prestige, and your livery on the manufacturer's first frame. |
| **Test programme participation** | Fly pre-production airframes on limited ops. Generates **research points** (§10) and early type ratings for your crew — you get a trained pilot pool before rivals can even order. |
| **Wait for maturity** | Safe. Boring. Everyone else already has slots and rated crew. |

**The risk is real and must bite.** Prototypes can suffer:

- Certification delays — your capital is tied up and your planned routes have no aircraft
- Teething reliability problems — higher AOG, more cancellations, reputation damage
- Performance shortfalls against brochure figures (range or burn worse than promised)
- **Outright cancellation** — the programme dies and you recover only part of your deposit

Manufacturers announce programmes in advance with published specs and a **confidence band**, same mechanic as event forecasting (§18). Betting early on a good aircraft is one of the biggest available edges in the game. Betting early on a dud is how a good airline dies.

**Speculative aircraft:** past the convergence point (§3.1b), the manufacturer pipeline becomes fictional — plausible next-generation types generated by the world, unknown to everyone. Nobody can look up the answer.

### 7.3 Maintenance **`[MVP-lite]`**

- Flight hours and cycles accumulate; A/C/D-check tiers with escalating downtime.
- Skipped maintenance → reliability decay → delays and cancellations → reputation damage.

### 7.4 Post-MVP

- Aircraft age and resale market between players
- Engine variant choice, winglet retrofits, cargo conversion
- Fleet commonality bonus (crew/maintenance efficiency for a single-family fleet)

---

## 8. Network & Operations

### 8.1 Routes **`[MVP]`**

- Pick origin + destination from the full real-world airport database — **every airport is loaded**; reachability is limited by your aircraft, not by an artificial list. Full specification in **Appendix B**.
- Route economics: distance, demand pool (business/leisure/VFR split), seasonality, competition.
- **Slots:** major airports have finite departure/arrival slots per time band. Slots are the scarce resource of the shared world — held, traded, and lost through underuse.
- Route rights/authority costs per country pair.

### 8.2 Scheduling **`[MVP]`**

- Assign an aircraft to a rotation; the sim runs it continuously.
- Frequency vs. gauge is the central planning decision.
- Curfews at noise-restricted airports block overnight ops.
- Connection banks at your hub: arrivals feeding departures generate transfer demand.

### 8.3 Pricing & demand **`[MVP]`**

Demand capture per route is a share model over competing operators, weighted by:

```
price  ·  product score  ·  frequency  ·  schedule convenience  ·  brand reputation  ·  alliance
```

- Simple per-route fare setting by class in MVP.
- **Post-MVP:** fare buckets, dynamic pricing, revenue management minigame.

> **The full specification is in Appendix A.** It is the single most load-bearing system in the game and is written out as testable maths, not prose.

### 8.4 Disruption **`[MVP-lite]`**

Weather, ATC flow, technical faults, crew timeout. Player choices: delay, cancel, swap aircraft, rebook. Each has a cost and a reputation consequence.

---

## 9. Crew, Staff & Ground Services

The people layer. An aircraft with no roster and no handler is a parked asset. This section covers the full chain: the office that plans the flight, the crew that operate it, and the suppliers that turn it around.

**Design guard, stated up front:** this system must never become a spreadsheet of individuals. The player manages **pools, contracts and policies** — the sim assigns individuals. Named characters exist only where a name carries meaning (senior leadership, and crew who earn a reputation). If the player has to hand-roster 400 flight attendants, the feature has failed.

### 9.1 Layer A — Head Office **`[MVP-lite]`**

Senior hires are **capability unlocks and automation**, not stat bonuses. Each one takes a job off the player's hands or opens one up.

| Role | What hiring them does |
|---|---|
| **Route Planner** | Surfaces ranked route opportunities with demand/competition analysis. Higher tier = better forecasting accuracy and earlier sight of unserved markets. |
| **Revenue Manager** | Unlocks automated fare rules and (post-MVP) fare buckets. Set a policy, they run it per-flight. |
| **Ops Controller** | Handles disruption by your standing policy while you're offline — swap, delay, or cancel per rules you set. The single most valuable hire in a real-time game. |
| **Chief Pilot** | Unlocks crew training programmes, type-rating conversions, and raises the fatigue safety margin. |
| **Head of Ground Ops** | Unlocks self-handling and improves turnaround baseline across your network. |
| **Brand / Cabin Director** | Unlocks premium seat products and named cabin Products; raises perceived product score. |
| **CFO** | Better financing terms, unlocks fuel hedging (post-MVP), deeper P&L reporting. |
| **Safety & Compliance** | Required for long-haul/ETOPS authority and international rights. |

Office staff are salaried, hired from a rotating candidate market with visible traits, and **poachable by other players** (post-MVP). A great Route Planner is a genuine competitive asset.

### 9.2 Layer B — Flight Crew **`[MVP]`**

#### Structure

- Crew belong to a **base** (a crew base is an unlockable facility at an airport, with its own hiring pool and cost structure).
- Crew are grouped into **pools** by rank and type rating. The player manages pool size, training, and pay band.
- Every flight needs a valid **crew complement**: flight deck (Captain + First Officer, +relief crew on ULH) and cabin crew scaled to seat count by regulation, led by a **Purser**.

#### Ranks & progression

**Flight deck:** Cadet → First Officer → Senior First Officer → Captain → Training Captain
**Cabin:** Cabin Crew → Senior Cabin Crew → **Purser** → Cabin Service Manager (widebody/premium)

Crew accumulate hours and gain proficiency on a type. Promotion needs hours + training slots + a clean record. **You cannot buy a Captain instantly** — you either hire an experienced one at market rate (expensive, and competing players want them too) or grow one over real weeks. That's the long game the 2× clock makes meaningful.

#### Type ratings **`[MVP]`**

Crew are rated per aircraft family, not per aircraft. Adding a new family means paying for conversion training and losing crew availability during it. **This is the mechanical teeth behind fleet commonality** — a mixed fleet fragments your crew pool and quietly wrecks your utilisation.

#### Duty, rest & fatigue **`[MVP]`** — the flagship crew mechanic

Because the world runs continuously at 2×, duty limits are a live constraint, not a footnote:

- Max duty period, minimum rest, cumulative limits over rolling windows
- Crew must be **positioned** where the aircraft is — an aircraft night-stopping away from base needs crew hotelling, or deadheading crew out to it
- Exceeding limits is not allowed; running close to them causes **crew timeout** → the flight cancels or delays until legal rest is served

The failure case is instructive and fair: you built a tight rotation, weather delayed leg two, and now leg four has no legal crew. That's the moment the player learns why airlines keep reserves.

- **Reserve/standby crew** cost money and do nothing most days — until they save your on-time performance. Deliberately a hard call.

#### Wellbeing, pay & morale **`[MVP-lite]`**

Pay band, roster stability, hotel quality, and rest ratio feed a **morale** score per base. Low morale → sickness, attrition, worse service scores, and (post-MVP) **industrial action**: work-to-rule, then strike. Cost-cutting on crew is a viable strategy with a delayed, visible bill.

#### Service quality link **`[MVP]`**

Cabin crew experience, ratio to passengers, purser quality, and morale feed the **service component of product score** (§6.4). A gorgeous suite served by a burnt-out understaffed cabin does not deliver a premium experience — and the passenger satisfaction model should show the player exactly that.

### 9.3 Layer C — Ground Services & Suppliers **`[MVP-lite]`**

At every airport you serve, each service is either **self-handled** (requires a station and headcount; cheap at scale, heavy upfront) or **contracted** to a vendor.

**Service lines:** ramp & baggage · fuelling · catering · cabin cleaning · pushback/towing · de-icing (seasonal, weather-driven) · security screening · passenger/check-in handling · lounge operation (premium hubs) · cargo handling · maintenance line support

Each vendor at each airport has:

```
price  ·  reliability  ·  speed (turnaround effect)  ·  quality (product/satisfaction effect)  ·  capacity
```

- **Contracts** run for a fixed term with volume commitments. Breaking one early costs a penalty.
- Cheap ramp handlers = slower turns and more mishandled bags = OTP and reputation damage.
- **Catering is a first-class choice**, tiered per cabin class, and links straight into the cabin builder: you can define a meal service per class, priced and rated. A premium J cabin with budget catering scores badly and the player can see why.
- **Fuel** is bought per station — into-plane fees vary by airport, prices vary by region. **Tankering** (uplifting extra fuel at a cheap station to avoid buying at an expensive one) is a real, learnable optimisation and a great advanced mechanic: cheaper fuel vs. extra weight vs. burn.
- Vendor capacity is finite at busy airports — **players compete for the good handlers**, which makes ground ops part of the shared world rather than a private menu.

**Post-MVP:** vendor relationship/reputation, exclusive contracts, self-handling as a service you sell to *other players* at your hub, seasonal de-icing crises.

### 9.4 How it all chains together **`[MVP]`**

One flight, end to end, showing every dependency:

```
Route Planner  identifies the market
      ↓
Slot + schedule  set by the player
      ↓
Aircraft assigned  →  cabin config sets seat count & crew requirement
      ↓
Crew pool  must supply legal, rested, type-rated flight deck + cabin + purser
      ↓
Ground chain at origin:  fuel uplift · catering load · bags · cleaning · pushback
      ↓
FLIGHT  (real time, 2×)  — service quality delivered by crew + catering + cabin
      ↓
Ground chain at destination:  bags off · turnaround · crew rest or return leg
      ↓
Satisfaction & OTP  →  reputation  →  demand & price tolerance on the next flight
```

**Any weak link in that chain shows up as a specific, diagnosable number** — not a vague penalty. If OTP drops, the player should be able to trace it to the handler at one station, or a crew base running too thin, and fix that one thing. That diagnosability is the whole design goal of this section.

### 9.5 Automation ladder **`[MVP]`**

Because this is a real-time game, depth without delegation becomes a chore. Every crew/ground system gets three modes:

1. **Manual** — full control, best results, highest attention cost
2. **Policy** — set rules ("always keep 2 reserve crew per base", "auto-rebook delays under 2h"), sim executes
3. **Delegated** — an office hire runs it entirely, slightly sub-optimally, for their salary

The player should be able to run a 200-aircraft airline on policy and delegation, and beat it by 10% with attention. **Never** by 100% — otherwise the game punishes people for having jobs.

---

## 10. Training Academy, Crew XP & Research

**`[MVP-lite]` core / Post-MVP depth** — the deep, opt-in progression layer. §9 is about *having enough* crew. This section is about *making them exceptionally good*, and it is deliberately the most granular system in the game.

**Where it sits in the design:** §9.1 warned against managing individuals. This is the sanctioned exception, and it works because it's **opt-in and inverted** — you're not forced to roster people one by one, you *choose* to invest in specific pilots because the payoff is a named, measurable asset. Micro here is a reward, not a tax.

**The core rule:** **Academy level gates the ceiling. It does not grant the boost.** Levelling the facility unlocks *which tiers of boosts are researchable at all*; you still have to earn the research and train the crew. Facility level is permission, not power.

### 10.1 The Academy facility

Built at a crew base. One academy per base; a base without one can only hire pre-qualified crew at market rates.

| Lvl | Name | Unlocks (ceiling) | Trainable up to | Research tier |
|---|---|---|---|---|
| 1 | Training Room | Basic CBT, induction | Cabin Crew | Tier 1 |
| 2 | Training Centre | Type conversion for narrowbody | Senior Cabin Crew, FO | Tier 1 |
| 3 | Flight Academy | Fixed-base sims, purser programme | Purser, Senior FO | Tier 2 |
| 4 | Full-Flight Sim Centre | Full-motion sims, widebody types | Captain | Tier 3 |
| 5 | Centre of Excellence | ULH/ETOPS, cadet programme, own Training Captains | Training Captain | Tier 4 |

Each level costs capital, takes **real weeks** to construct, and adds fixed monthly upkeep. A level 5 academy at a base with 12 aircraft is a money pit; at a 90-aircraft hub it's the best investment in the game. **Deciding when you're big enough is the interesting question.**

#### Modules (built inside the academy, independently)

`CBT Suite` · `Cabin Service Mock-up` · `Emergency & Wet Drill` · `Fixed-Base Sim` · `Full-Flight Sim (per aircraft family)` · `Ground Ops Bay` · `Dispatch & Performance Lab`

Modules determine **what** you can train; academy level determines **how far**. A Full-Flight Sim for a family you own converts crew in-house at a fraction of the cost of outsourcing — and (post-MVP) you can **sell sim slots to other players**, turning your academy into a revenue line.

#### Throughput

Each academy has finite **training slots**. Crew in training are unavailable to fly. This is the permanent tension: training crew costs you the crew you were training. Scaling an airline means eating that gap deliberately.

### 10.2 Crew XP

Every crew member accumulates XP per completed flight:

```
XP = base(sector length) × type factor × difficulty multiplier
```

**Difficulty multiplier** rewards the hard stuff — and this is where the system gets genuinely characterful:

- Airport difficulty rating (short/sloped/high-altitude/terrain-constrained, steep approaches)
- Weather at arrival (crosswind, low visibility, snow)
- Night operations
- Disruption handled well (diversion flown, technical fault managed)
- Long-haul / ULH sectors and oceanic crossings

Grinding easy domestic hops levels crew slowly. A pilot who flies your hard winter northern network becomes measurably better than one who doesn't. **Your route network shapes your crew, not just your balance sheet.**

#### Personal skill trees

Levelling a pilot grants points into one of four branches. Points are per-person and mostly irreversible — you are specialising an individual.

| Branch | Effect |
|---|---|
| **Performance & Fuel** | Cost-index discipline, optimal cruise, continuous descent, tankering judgement → % fuel burn |
| **Handling & Safety** | Fewer incidents, better weather minima, diversion avoidance, difficult-airport certification |
| **Command & Leadership** | Faster turnarounds, better crew morale on their flights, disruption recovery |
| **Type Mastery** | Deep proficiency on one family; big bonuses, lost if you sell that fleet |

Cabin crew get a lighter three-branch version: **Service**, **Safety**, **Leadership** (the path to Purser).

#### Named crew

Crew who cross a level threshold become **named, tracked individuals** with a visible history — hours, types, notable flights, incidents handled. They appear on your roster board and on your public airline profile. **Post-MVP:** rivals can see and poach them; a legendary Captain is a status object.

#### Training Captains — the compounding loop

A max-level pilot can be converted to **Training Captain**: they stop generating full revenue value and instead multiply XP gain for everyone they fly with. This is the loop that makes long-term investment pay:

```
hard routes → pilot XP → Training Captains → faster XP for everyone → deeper bench → harder routes
```

### 10.3 Research tree — "Operational Doctrine"

Airline-wide, permanent unlocks. Distinct from personal skill trees: **skill trees make one pilot good, research makes your whole airline good.**

**Research points** are generated per real day by:

```
RP/day = Σ(academy levels) × academy staff quality × (fleet flight hours ÷ scaling factor)
```

You cannot buy RP. You cannot rush it. A big airline that never built academies generates almost none — **size alone doesn't buy competence.**

#### Branches

| Branch | Sample nodes (T1 → T4) |
|---|---|
| **Fuel & Performance** | Cost-index SOP → Continuous descent approach → Tankering doctrine → Fleet-wide performance optimisation |
| **Turnaround & Ground** | Boarding SOP → Parallel servicing → Rapid turn certification → Sub-25-min narrowbody turn |
| **Safety & Reliability** | Reporting culture → Predictive fault detection → ETOPS authority → All-weather Cat IIIb ops |
| **Service & Cabin** | Service standards → Signature service → Premium ritual → Best-in-class product multiplier |
| **Crew Development** | Efficient conversion → Cadet pipeline → Fatigue resilience → In-house Training Captain programme |
| **Maintenance** | Line efficiency → Predictive maintenance → Reduced AOG → In-house heavy checks |

**Tier gating is the whole point:** Tier 3 and 4 nodes are visible but locked until you have an academy at the required level. The player can see exactly what they're working toward and what facility investment it demands.

### 10.4 The boosts themselves

Boosts are **operational efficiency**, never demand or money directly. They make you *cheaper and faster*, not *more popular*.

| Boost type | Realistic ceiling (all sources stacked) |
|---|---|
| Fuel burn reduction | **−8%** |
| Turnaround time reduction | **−20%** |
| Block time reduction (taxi/routing efficiency) | **−4%** |
| Maintenance cost reduction | **−12%** |
| Incident/delay rate reduction | **−30%** |
| Service **cost** reduction | **−15%** |

Three balance rules, non-negotiable:

1. **Hard caps.** Stacking academy + research + personal skill + Training Captain never exceeds the ceiling. Diminishing returns before the cap.
2. **Efficiency only.** No boost touches demand capture, price tolerance, or reputation directly. Crew training does raise *service execution* (App. D.1) — but execution is **band-capped**, so a new entrant who simply buys a higher service tier still outscores a veteran running a lower one. A veteran airline is *leaner*, not *more attractive*.
3. **Upkeep.** Academies and research carry ongoing cost. Doctrine lapses if you stop funding it — advantages must be maintained, not just banked.

**Why this matters in a shared world:** a year-one player must never face an unbeatable wall of stacked veteran bonuses. −8% fuel is a real edge that a smarter network plan can beat. −40% would be a moat, and moats kill persistent multiplayer games.

### 10.5 UI

The micro lives here, and it should be a place players *want* to spend time — closer to the livery builder than to a settings menu.

- **Academy dashboard:** slots in use, courses running with real-time countdowns, upcoming qualification expiries
- **Roster board:** filter and sort crew by level, type rating, branch, base, fatigue
- **Pilot card:** portrait, hours, types, skill tree, career history, notable flights
- **Research tree:** visual node graph, locked tiers greyed with the facility level required stated plainly
- **Offline digest:** "3 FOs completed A320 conversion · Capt. Meijer reached level 12 · Tier 3 unlocked"

---

## 11. Economy

**`[MVP]`**

**Revenue:** ticket sales by class · ancillary (bags, seat selection, food) · **cargo, belly and freighter (§12)** · charter · ACMI
**Costs:** fuel (per-station price + into-plane fees) · lease/finance · **crew salaries, training & hotelling** · **office staff salaries** · maintenance · airport & slot fees · ATC · **ground handling contracts (ramp, catering, cleaning, de-icing)** · marketing · repaint/retrofit

- Fuel price fluctuates on a world curve — hedging is a **post-MVP** decision layer.
- Financing: loans with interest, credit rating driven by balance sheet.
- Weekly financial report; P&L by route so the player can find and kill loss-makers.

**Failure state:** insolvency → forced asset sale → administration. Should be recoverable, not run-ending, in MVP.

---

## 12. Cargo

**`[MVP-lite]` belly cargo / Post-MVP freighters** — the second business hiding inside every airline, and a complete alternative career.

Cargo is not a bolt-on. It has its own demand model, its own customers, its own daily rhythm, and its own airports. A player can run a pure freight operation and never sell a single seat.

### 12.1 Two channels

**Belly cargo `[MVP-lite]`** — freight in the hold of passenger flights.

The revenue is close to free: the aircraft is already flying, already crewed, already fuelled. The constraint is physical:

```
Available belly payload = MTOW − OEW − fuel − passengers − passenger bags
```

Which means belly cargo is in **direct competition with your own passengers and your own range**. A full cabin with full bags on a long sector leaves almost no belly capacity. A widebody on a medium sector has tonnes spare.

**This is the quiet economic reason widebody long-haul works at all.** On many real trunk routes belly freight is the difference between a profitable and a loss-making flight, and the game should make that discoverable rather than stated.

**Freighters `Post-MVP`** — dedicated aircraft, main-deck loading, no passengers.

| Class | Examples | Role |
|---|---|---|
| Turboprop feeder | ATR 72F, Q400F | Thin regional lanes, island resupply, mail |
| Narrowbody converted | 737-800BCF, A321P2F | Express networks, overnight domestic |
| Widebody converted | 767-300BDSF, A330P2F | Regional intercontinental |
| Purpose-built | 777F, 747-8F | Long-haul trunk freight, nose-loading outsize |
| Outsize specialist | An-124 class | Project cargo — rare, lucrative, era-gated |

Freighters use the same livery builder (§5) and skip the cabin builder entirely.

### 12.2 Cargo demand — a different world

Cargo demand does **not** follow passenger demand. It follows **trade**, and that changes everything about how routes are chosen.

- **Manufacturing → consumption.** Cargo pools are driven by industrial output, port proximity, and trade balance, not by tourism or population.
- **Directionally imbalanced, severely.** Asia→Europe headhaul runs full at high yield; the backhaul runs half-empty at a fraction of the rate. **Cargo route profitability must be evaluated as a round trip, never per leg** — this is the single most common real-world mistake and it should be a real trap in the game.
- **Different seasonality.** Peak is Q4 pre-Christmas, not summer. Perishables spike at harvest. A cargo airline's calendar is the inverse of a leisure carrier's — which makes a mixed operation genuinely counter-cyclical.
- **Different airports.** LEJ, CVG, MEM, HKG, ICN, LGG, and **ANC as a technical fuel stop** on transpacific routings. Cargo hubs are often unglamorous, cheap, curfew-free airports — and they're uncontested, because pax airlines don't want them.

### 12.3 Commodity types

| Commodity | Yield | Requirement |
|---|---|---|
| General freight | Baseline | None |
| Express / time-critical | High | Guaranteed schedule; heavy penalty for lateness |
| E-commerce | Medium, huge volume | Volume over weight; fills space fast |
| Perishables | Medium-high | Cold chain at both ends |
| Pharmaceuticals | **Very high** | Temperature-controlled ULDs, certification, audited handling |
| Live animals | High | Certification, welfare rules, specialist handling |
| Dangerous goods | High | Certification (§10 research), restricted airports |
| Outsize / project | Very high | Nose-loading or main-deck capable aircraft |
| Mail contracts | Low but guaranteed | Government tender; stable baseline volume |
| Human remains / AOG parts | Niche, premium | Priority handling |

Certifications are earned through the research tree, so cargo has its own progression ladder rather than borrowing the passenger one.

### 12.4 Customers & contracts

| Model | Yield | Risk |
|---|---|---|
| **Spot market** | Highest | Volatile; capacity can go empty |
| **Forwarder contracts** | Medium | Committed volume over a term; stable |
| **Integrator ACMI** | Low but guaranteed | You fly someone else's network on their schedule — near-zero commercial risk, near-zero commercial upside |
| **Block space agreements** | Medium | Partner buys fixed capacity on your flights |
| **Government / mail tender** | Low | Won by bid; extremely stable |

A young cargo operation on ACMI is safe and dull. A mature one trading spot is exposed and lucrative. Moving between them is the cargo career arc.

### 12.5 The night-shift synergy — the best reason cargo exists here

**Cargo flies at night.** Passenger demand collapses after 22:00; freight demand doesn't care.

That means cargo monetises everything your passenger airline leaves idle overnight:

- Gates and stands, otherwise empty from 22:00 to 06:00
- Ground crew and handling contracts already paid for
- Curfew-free airports that are useless for passenger flying
- Aircraft utilisation — a converted narrowbody flying freight at night on your own network

Running both is genuinely more efficient than running either, and the player feels it directly in gate utilisation and cost-per-block-hour. It also makes the **airport map** (App. B.7) come alive at night, which is a nice visual payoff.

### 12.6 Cargo operations

- **ULD management:** container/pallet pools per station, positioning costs, shortages if you're careless
- **Load planning:** weight *and* balance *and* volume. Dense freight hits weight limits; e-commerce hits volume limits first. Both are real constraints.
- **Cargo terminal** as a hub facility — throughput capacity, cold storage, DG handling, customs clearance speed
- **Customs** as a delay source and a service-quality factor

### 12.7 Demand model integration

Cargo runs through the **same Appendix A logit**, with its own coefficients and capacity in tonnes rather than seats:

```
β_price:      4.2   (freight buyers are ruthlessly price-driven)
β_reliability 2.8   (a missed connection ruins a supply chain)
β_frequency:  1.1
β_product:    0.4   (only matters for specialist commodities)
β_transit:    1.9   (total door-to-door time, not flight time)
```

Spill works identically, in kilos.

---

## 13. Finance, Loans & Credit

**`[MVP]`** — the rule you set is the design brief: **loans support, they never carry.**

### 13.1 The principle, enforced mechanically

A loan should let a profitable airline move faster. It must never let an unprofitable airline keep existing. The mechanism is that **borrowing capacity is a function of demonstrated profit, not of ambition** — so the airlines that most want to borrow their way out of trouble are exactly the ones that can't.

```
MaxTotalDebt = min(
    CreditTierCap,
    3.0 × trailing 12-month operating profit,
    0.60 × tangible asset value
)

DSCR = trailing EBITDA ÷ annual debt service        must be ≥ 1.25 to borrow
```

If you're losing money, `3.0 × operating profit` is zero or negative. **You cannot borrow at all.** No special-case rule needed — the formula does it.

### 13.2 Credit tiers

Rating is built from operating margin, revenue stability, DSCR, route count and diversity, on-time record, payment history, and net worth.

| Tier | Requirement | Max debt | Interest | Term |
|---|---|---|---|---|
| **Startup** | New airline — **founder facility, exempt from the profit test**, personally guaranteed against the airline | $250K | **14%** | 12 mo |
| **D** | 3 profitable months | $1M | 12% | 24 mo |
| **C** | 6 profitable months, 4+ routes | $5M | 10% | 36 mo |
| **B** | 12 months, 2+ hubs, stable margin | $25M | 8% | 60 mo |
| **A** | Sustained margin, diverse network | $100M | 6% | 84 mo |
| **AA** | Major carrier, fortress balance sheet | $500M+ | 4.5% | 120 mo |

Ratings fall faster than they rise. One bad quarter costs a tier; recovering it takes two good ones.

### 13.3 Instruments

| Instrument | Secured on | Rate | Use |
|---|---|---|---|
| **Working capital line** | Nothing | Tier rate **+3%** | Cash flow gaps. Expensive on purpose. |
| **Aircraft finance** | The airframe | Tier rate **−2%** | Buying aircraft. Cheapest money available — the bank can repossess. |
| **Facility loan** | Hub, gates, hangar | Tier rate | Hubs, academies, cargo terminals |
| **Sale-leaseback** | — | n/a | Sell an owned aircraft for immediate cash, lease it back. Raises capital instantly, permanently raises your cost base. The classic desperation move. |
| **Bond issue** *(post-MVP)* | — | Below tier rate | AA only, large scale |

### 13.4 Interest is a live drain

Interest accrues **per in-game day** and appears in the daily P&L as its own line. It is never hidden in a summary. Players should watch it eat the margin in real time.

**Worked example — the one-aircraft Amsterdam airline** (App. B.6 setup: ATR 72, 8 sectors/day, 68% load factor, €75 average fare):

```
Revenue                      $856,800 / month
Costs                        $808,472
  fuel 168k · maintenance 202k · airport fees 144k
  handling 91k · lease 85k · crew 60k · gate 18k · admin 40k
Operating profit              $48,328 / month     margin 5.6%
```

Now borrow against it:

| Loan | Rate | Interest/month | Share of your profit |
|---|---|---|---|
| $250K | 14% | $2,917 | **6%** — comfortable, genuinely useful |
| $1M | 12% | $10,000 | **21%** — heavy, needs to earn its keep |
| $3M | 10% | $25,000 | **52%** — you now work for the bank |

And the cap bites before you get there: `3.0 × $580K annual operating profit` = **$1.74M maximum debt**. A one-aircraft airline cannot borrow its way to a $2M second hub — it has to earn most of it first. That's the rule working exactly as intended, with no arbitrary gate.

### 13.5 Default

Missed payment → rating drop → refinancing at worse rates → **covenant breach** → lender takes control:

1. **Warning** — 7 in-game days to cure
2. **Restriction** — no new routes, no new aircraft, no dividends
3. **Forced disposal** — sell aircraft or gates to service the debt
4. **Repossession** — secured aircraft seized; you keep the livery, not the airframe
5. **Administration** — network stripped to profitable core, control returned with a wrecked rating

**Recoverable, not run-ending.** Losing your airline outright to a bad loan would push players away from the entire system, which defeats the point of having it.

### 13.6 Cash vs. profit

The distinction is deliberately taught. A profitable airline can still run out of cash — lease deposits, aircraft down payments, gate leases and academy construction all hit cash long before they show up in profit. The dashboard shows a **cash runway in in-game days** at all times, and it is the single most prominent number when it drops below 30.

---

## 14. Statistics & Analytics

**`[MVP]`** — in a real-time sim you play the numbers, not the animation. The dashboard *is* the game's main interface after the first week.

### 14.1 The governing principle: no dead-end numbers

**Every figure drills down to its cause.** Load factor → by route → by flight → by segment → the Appendix A waterfall showing which competitor took the passengers and why. A number you cannot interrogate is a number players will not trust, and the whole design (A.1) is built on trust.

### 14.2 Three time horizons, always

| Horizon | Question |
|---|---|
| **Now** | Cash, aircraft airborne, today's bookings, live alerts |
| **Trend** | 7 / 30 / 90 in-game days — direction and rate of change |
| **Forecast** | Next 7 / 30 / 90, with a confidence band widening with distance |

Forecasts come from committed schedule, current booking curves, known events (§18), and contracted costs. They carry a **confidence band, never a single number** — the same honesty rule as event forecasting.

### 14.3 Dashboards

**Executive** — cash, **cash runway in days**, net worth, MTD profit vs. forecast, load factor, OTP, reputation, credit rating, top gainers and losers this week

**Financial** — full P&L; profitability by **route / aircraft / hub / cabin class / cargo**; cost breakdown; unit economics: **RASK, CASK, yield, breakeven load factor**; cash flow and runway; debt schedule, DSCR, interest drain

**Traffic & commercial** — pax and tonnes carried, **RPK / ASK / RTK**, load factor by class, yield by class, spill (turned-away demand), booking curve vs. departure, market share by route with the competitive waterfall

**Fleet & maintenance** — utilisation in block hours/day per airframe, cost per block hour, **AOG count**, checks due timeline, reliability trend, age profile, fuel burn vs. type baseline

**Crew** — headcount by rank, type and base; **fatigue and duty-limit exposure**; morale by base; attrition; training pipeline and completion dates; crew cost per block hour; reserve coverage

**Ground & vendors** — turnaround performance by station vs. contract, delay minutes attributed by cause, vendor scorecards, contract expiries, mishandled baggage

**Reputation & service** — OTP (D0 and D15), cancellation rate, satisfaction by class and route, product score components, complaint drivers, reputation trend with attribution

**Cargo** — tonnes by lane and commodity, **directional imbalance** (headhaul vs. backhaul), yield per kg, cargo load factor by weight and by volume, contract vs. spot mix

**Alliance** *(post-MVP)* — codeshare revenue, feed contribution by partner, alliance share by region

### 14.4 The single most important chart

**Profit by route, ranked, with a breakeven line.** It's the chart that turns a confused player into an airline manager. Loss-making routes sit below the line in red and the drill-down tells you whether it's yield, cost, load factor or a competitor — and therefore whether to reprice, re-gauge, re-time, or kill it.

### 14.5 Alerts

Delivered in the offline digest and on the dashboard:

`route loss-making 7 days running` · `cash runway < 30 days` · `DSCR approaching covenant` · `crew shortfall at base in 5 days` · `C-check due, no slot booked` · `gate lease expiring` · `competitor entered your route` · `event announced affecting your network` · `spill > 15% on a route` *(you're turning away money)*

### 14.6 Presentation

- Consistent chart language across every dashboard; light and dark; colour never the sole carrier of meaning
- Absolute value **and** rate of change on every headline metric — a falling profit that's falling more slowly is a different story from one that isn't
- Benchmarks against world median for your fleet size, so a number has context
- **CSV export on everything.** Some players will build their own spreadsheets, and that's a compliment, not a threat.
- Mobile-first executive view: the check-in session (§2) is one glance at cash, alerts, and aircraft airborne

---

## 15. Brand & Reputation

**`[MVP-lite]`**

- Airline name, ICAO/IATA code, callsign, base country, HQ airport, brand palette, logo, livery — set at creation, editable at a cost (rebrand is an event).
- **Reputation** is a compound score on a **0.00–1.00 scale**, used consistently throughout this document (App. A.3, F.4, E.6): on-time performance · product score · cancellation rate · service consistency. New airlines start at **0.35**; the world median sits near 0.50.
- Reputation gates premium demand. Cheap-and-late is a viable strategy; it just caps your ceiling.

**Post-MVP:** marketing campaigns, brand tracking by region, PR crisis events. **Loyalty programme: full system in Appendix E.**

---

## 16. The Shared World

**`[MVP]`** — the world is shared; direct player-vs-player systems are staged.

**MVP scope:**
- One persistent world server, all players in the same airport/slot/demand space
- Route competition is real: your load factor drops when someone credible enters your market
- Public airline profiles — see any player's fleet, network, and liveries
- Global leaderboards: revenue, fleet size, on-time, **and a community-voted livery board**

**Post-MVP:**
- Alliances: player-founded, branded, governed — full system in §17
- Slot trading marketplace between players
- Used aircraft marketplace between players
- Wet lease / ACMI contracts between players
- Regional "seasons" with resets and prestige carry-over
- New-player protection: a sheltered starter region, graduation into contested markets

**Anti-griefing:** slot hoarding needs a use-it-or-lose-it rule. Predatory undercutting should be bounded by cost floors so a whale can't operate at a permanent loss to erase newcomers.

---

## 17. Alliances

**Post-MVP, first major expansion** — the feature that turns a competitive world into a political one.

Players found and run their own alliances, SkyTeam-style: a real brand, a real member roster, real shared benefits, and a logo that goes on every member's tail.

### 17.1 Two tiers of partnership

**Tier 1 — Bilateral partnership** (lightweight, earlier unlock)
Two airlines sign a codeshare. No branding, no governance, minimal overhead. This is the tutorial for the concept and stays useful forever for niche route swaps.

**Tier 2 — Alliance** (the full system)
A founded, branded, governed multi-member organisation.

**Founding requirements:** ≥3 founding members · minimum reputation and fleet size each · a substantial capital deposit · a designated HQ airport. Deliberately hard. Alliances should be rare and mean something — a world with forty of them has none.

### 17.2 The Alliance Brand Creator

Uses the **same vector editor as the livery builder** (§5). If you can design a livery, you already know how to do this.

**Alliance identity:**

- Name, tagline/slogan, three-letter code
- Logo built in the symbol composer — the SkyTeam/Star Alliance problem: it must read at tail size, at map-icon size, and on a lounge sign
- Alliance palette (2–4 colours) that members can pull into their own brand
- Alliance typeface for shared applications

**Where the logo lands — this is the part that pays off emotionally:**

1. **Member livery layer.** Once you join, the alliance logo becomes an available layer in *your* livery builder. Constrained placement zones only — forward fuselage near the door, aft fuselage, or engine nacelle. Never the tail; the tail stays yours.
2. **Alliance house livery.** The alliance can design a full scheme, in alliance colours with the member's name in the shared typeface. Members may volunteer aircraft to wear it — a genuine status flex, and free advertising for the alliance. Real-world airlines fight over which frame gets it.
3. **Compulsory titles.** A small alliance wordmark near the forward door, applied automatically on join. Non-negotiable, tiny, real.
4. **Lounges, boarding passes, cabin service items** *(later)* — alliance branding in the passenger-facing surfaces.

**Rebranding an alliance** costs money and forces every member into a repaint cycle. Alliance leadership changing the logo on a whim has real consequences for everyone — which is exactly the kind of politics this system should generate.

### 17.3 Benefits — what membership actually buys

Ordered by how much they matter. Every one of these resolves into Appendix A.

| Benefit | Mechanical effect |
|---|---|
| **Codeshare** | Sell seats on partners' flights. Your network effectively includes theirs for connecting itineraries. |
| **Interline & through-check** | Cuts `ConnectionPenalty` sharply — the biggest single demand effect |
| **Coordinated banks** | Members schedule arrivals/departures to feed each other at shared hubs, boosting `SchedFit` for connections |
| **Loyalty reciprocity** | Partial `Loyalty` term transfers across members |
| **Lounge network** | Product score bonus for business/first passengers at partner hubs |
| **Joint ground contracts** | Pooled volume → better vendor rates and priority capacity (§9.3) |
| **Sim & training exchange** | Members share academy capacity and spare-part pools (§10) |
| **Joint slot bids** | Alliance can bid as a bloc for slot releases |
| **Alliance utility term** | Small direct `β_alliance` bonus in the demand model |

**The critical design constraint:** alliance benefits overwhelmingly improve **connecting traffic**, not point-to-point. A solo carrier running dense point-to-point routes is unaffected by the existence of a mega-alliance. This is what keeps independence viable, and it happens to be true in reality.

### 17.4 Governance

- **Roles:** Founder / Board / Member / Applicant, with configurable permissions
- **Admission modes:** open · application + board vote · invite only
- **Voting** on: admissions, expulsions, brand changes, dues, joint bids. Weighted by fleet size or one-member-one-vote — set at founding, amendable by supermajority.
- **Dues:** flat, per-aircraft, or revenue-share. Fund the joint marketing pot and slot war chest.
- **Revenue proration** on codeshared itineraries, split by an agreed formula
- **Exit:** notice period, forfeit of deposit, forced repaint. Leaving should hurt a little.

Expect drama. That's the feature, not a bug — alliance politics is the retention mechanic that content updates can't replicate.

### 17.5 Alliance-vs-alliance

- Alliance leaderboards: total network reach, passengers, on-time, and a **community-voted alliance branding board**
- Regional market share tracked per alliance — visible to everyone, which makes contested regions into ongoing wars
- Hub-vs-hub competition for connecting traffic between alliance super-hubs

### 17.6 Anti-monopoly guards

The obvious failure mode is one mega-alliance absorbing the world and the game ending.

| Risk | Guard |
|---|---|
| Everyone joins the biggest alliance | **Diminishing returns:** benefit strength scales with `√(members)` and hard-caps. Member 40 adds almost nothing. |
| Regional stranglehold | **Antitrust regulator:** an alliance exceeding a set share of a region's capacity faces forced slot divestment and blocked new codeshares |
| Independents become unviable | Alliance benefits target connections only; strong point-to-point play stays fully competitive |
| Dead-weight members | Dues plus inactivity rules push out non-participating members |
| Alliance = the only endgame | Solo prestige tracks and boutique-carrier leaderboards run in parallel |

---

## 18. World Events & Live Demand

**`[MVP-lite]` (calendar) / Post-MVP (breaking events)** — the system that keeps a persistent world from feeling like a spreadsheet that never changes.

Demand should move because *the world moves*. Two tiers, with very different design intent.

### 18.1 Tier 1 — The scheduled calendar **`[MVP-lite]`**

Real, recurring, **announced in advance**. This is the good gameplay: foresight is rewarded, and planning ahead is the skill.

| Type | Examples | Demand effect |
|---|---|---|
| Mega sport | World Cup, Olympics, Euros, Super Bowl | Huge spike to host cities; multi-week; leisure/VFR heavy |
| Religious & cultural | Hajj/Umrah season, Ramadan, Diwali, Lunar New Year | Enormous directional VFR flows; strongly one-way |
| Festivals | Carnival, Oktoberfest, major music festivals | Sharp short leisure spikes |
| Business calendar | CES, Mobile World Congress, Davos, major trade fairs | Business segment spike; premium cabins fill; fares spike |
| Seasonal | School holidays per country, summer peak, ski season, Christmas | The baseline rhythm of the whole year |

**How it plays:** events are announced **weeks of real time ahead** on an Events Board with a demand forecast and a confidence band. You reposition aircraft, add frequencies, upgauge, hire seasonal crew, raise fares — and you commit that capacity before you know exactly how big the spike lands. Miss the window and you fly the surge half-empty *after* it.

The Lunar New Year flow is deliberately **directional and asymmetric**: full one way, near-empty the other. Learning to fly a profitable one-directional surge is a real skill.

### 18.2 Tier 2 — Breaking events **Post-MVP**

Unannounced, disruptive, and about crisis response rather than planning.

| Type | Effect |
|---|---|
| Airspace closure | Routes forced to reroute → longer block time, more fuel, some routes become unflyable |
| Volcanic ash / extreme weather | Regional grounding for days |
| Oil shock | Fuel price spike — hedging (§11) suddenly matters enormously |
| Currency/economic crisis | Regional demand collapse, especially business |
| Airport closure | Strike, incident, or infrastructure failure at a hub |
| Health emergency | Broad demand suppression with a slow recovery curve |
| Sudden destination boom | A city becomes fashionable; a visa regime opens up |

Recovery curves matter as much as the shock. Demand shouldn't snap back — it should limp back over real weeks, so the decision of *when to restore capacity* is its own gamble.

### 18.3 Real events, including grim ones — the house style

**Decision: real-world events stay real, wars included.** During the catch-up era (§3.1b) the world replays actual history, so real conflicts, closures and crises are part of the simulation. The airline industry is shaped by exactly these forces, and a sim that pretends otherwise is a weaker sim.

What matters is *how* they are represented. The house style, to be applied consistently:

**Model the aviation consequence, never the conflict itself.**

| Represent | Don't represent |
|---|---|
| Airspace closed over a FIR; reroute adds 47 min and 3.1t fuel | Combat, casualties, imagery, or sides |
| Demand to a country collapses 80%, recovers over 14 months | Political commentary or attribution of blame |
| Sanctions ban leasing to operators in a region; your lessor repossesses | Any framing that treats suffering as a scoreboard |
| Evacuation and humanitarian charter demand surges | "Opportunity" language in the UI around a humanitarian crisis |

Concretely, that means:

- **Neutral, factual, dispatch-desk register.** The tone of a NOTAM or an ops bulletin, not a news ticker and not a headline. "FIR closed to civil traffic, effective immediately" is correct. Anything editorialising is not.
- **Named where naming is factual** — a real airspace closure names the real airspace. Naming the geography is information a dispatcher needs. Narrating the war is not.
- **No profit framing on human suffering.** Humanitarian and evacuation flying exists as a mechanic, but the UI treats it as duty and logistics, never as a jackpot. Reputation, not margin, is the reward.
- **Curated, never automated.** Grim events are hand-authored by admins (§22.4), reviewed before they go live. **No live news ingestion, ever** — an unmoderated pipeline turning breaking tragedy into a demand modifier is the one version of this that genuinely cannot be defended, and it is also unbalanceable.
- **Regional compliance:** some markets restrict depiction of specific real conflicts. The admin console supports per-region event suppression so a world can be legally shipped everywhere.

Handled this way, the grim events become the most memorable content in the game — the season everyone's Moscow network evaporated, the week the ash cloud grounded Europe, the year fuel doubled. That is aviation history, and players who care about airlines care about exactly this.

**Post-convergence:** past ~mid-2028 there's no real record left to draw on, so the generator takes over and produces plausible fictional crises in the same register.

**Implementation:** curated event calendar as versioned JSON, authored ahead by admins, plus a procedural generator for the speculative era.

### 18.4 Anti-exploit

| Risk | Guard |
|---|---|
| Everyone piles onto the World Cup route | Slots are finite; oversupply crashes fares via the demand model naturally — no special rule needed |
| Event demand is free money | Event spikes cost real repositioning: ferry flights, crew hotelling, seasonal hiring, opportunity cost on your core network |
| Only veterans can react | Events are announced to everyone simultaneously; reacting needs spare capacity, not accumulated bonuses |
| Perfect foresight | Forecasts carry a **confidence band**, not a number. Actual demand lands within the band. You're betting, not reading an answer key. |

---

## 19. Progression

**`[MVP]`**

Not XP levels. Progression is **capability unlocked by operational reality**:

| Gate | Unlocked by |
|---|---|
| Larger aircraft types | Fleet experience + capital + crew base |
| Long-haul authority | Regulatory rating earned via safety record |
| Additional hub | Traffic volume + capital |
| Slot priority at congested airports | Incumbency + reputation |
| Premium cabin products | Brand reputation threshold |
| Efficiency doctrine (fuel, turnaround, ETOPS) | Academy level + research points earned over real weeks |
| International rights | Country relations built by serving their markets |

The first hour: leased regional jet, one domestic route, paint it, fly it, land it, see the money. Ends with the player wanting a second aircraft.

---

## 20. Monetisation *(direction, not committed)*

**Never sell:** time acceleration, direct revenue, competitive advantage, **research points or training speed**. All four break the premise.

**Candidate model:**
- Free to play a full airline
- Cosmetic depth: **alternate** aesthetic sets — never a strictly better tool, and never the legendary tier, which is earned only (App. G.4)
- Convenience that isn't power: extra livery save slots, design history, fleet-wide preview renders
- Optional subscription: extra design storage, fleet render exports, an ad-free community showcase — **never analytics, planning tools, or anything that confers market information a non-payer lacks**
- Sell a **high-res poster/print of your own livery.** Players will buy this.

---

## 21. Technical Shape

**`[MVP]`**

- **Server-authoritative** simulation. The client is a viewer + command issuer. Non-negotiable for a shared world.
- Flight state is computed, not stored per-tick: store departure time, route, aircraft, config → interpolate position on read. Cheap at scale.
- Event queue for discrete transitions (arrival, maintenance due, slot expiry) rather than per-aircraft polling.
- Client: 2D canvas/WebGL map; livery + cabin builders as **SVG-based vector editors** (resolution-independent, small payloads, easy to render server-side for thumbnails).
- Livery stored as a JSON layer document, not a bitmap. Renders at any size; applies across aircraft templates; diffs cheaply.
- Economic resolution at flight events only, not continuously.

**Open technical questions:**
1. Server-side livery rendering for map icons and profile thumbnails — headless SVG raster pipeline, cached.
2. Demand share model — needs to be deterministic and explainable, or players won't trust it.
3. Slot allocation at world launch: first-come-first-served creates a permanent land grab. Consider scheduled slot release waves.
4. Airport/route dataset licensing.

---

## 22. Admin Console & World Management

**`[MVP]` for the core subset** — flagged per feature below.

A live persistent multiplayer economy cannot be operated without this. It is not a nice-to-have added later: **if you can't retune a β coefficient, author an event, or reverse a bad transaction on day one, the world will break and you will have no way to fix it.**

### 22.1 Access & safety **`[MVP]`**

- Role-based: `Support` (read + limited) · `GameMaster` (player actions) · `Economist` (balance config) · `WorldAdmin` (world lifecycle) · `SuperAdmin`
- Mandatory 2FA; separate credentials from any player account
- **Immutable audit log** on every action: who, what, before/after, why (reason field required, not optional)
- **Two-person rule** on the dangerous set: world deletion, mass currency grants, live β changes on a production world, publishing a sensitive event
- All destructive actions are soft-delete with a restore window

### 22.2 World management **`[MVP]`**

Admins create and run multiple parallel worlds. A world is defined entirely by config:

```
World {
  name, epoch, speed_multiplier, launch_date
  aircraft_catalogue_version
  airport_set            // global, or region-scoped
  ruleset                // hardcore / standard / sandbox
  economy_config_version // the Appendix A coefficient set
  event_calendar_id
  player_cap, entry_mode // open / invite / seasonal
  status                 // staging / open / locked / archived
}
```

**Era presets** ship as starting points:

| Preset | Epoch | Character |
|---|---|---|
| **Piston & Prop** | 1950-01-01 | DC-3s, Constellations, no jets. Short hops, fuel stops, tiny networks. |
| **Jet Age** | 1958-01-01 | The 707 arrives and rewrites everything |
| **Widebody Era** | 1970-01-01 | 747s, mass tourism, the first oil shock waiting in 1973 |
| **Deregulation** | 1978-01-01 | LCCs become possible; the rulebook changes |
| **Modern** | **2024-10-20** | The flagship world |
| **Sandbox** | any | Unlimited capital, no failure state, for testing and creative builds |

**Lifecycle tools:** clone a world (config + catalogue, no players) · staging worlds for testing before production · pause/resume · scheduled maintenance windows with player-facing notice · archive to read-only (networks and liveries stay browsable forever — players should never lose their airline's history)

**Speed multiplier is editable but gated behind the two-person rule and a loud warning.** Changing time speed mid-world invalidates every player's schedule and crew plan simultaneously. Almost never the right call.

### 22.3 Economy & balance console **`[MVP]`**

Live-editable, versioned config — no deploy required:

- **Appendix A coefficients** (β by segment, elasticities, new-entrant bonus, connection penalties)
- Demand pool scalars, globally or per region/route
- Fuel price curve and volatility
- Cost tables: leases, crew pay bands, airport fees, vendor rates
- Boost ceilings (§10.4) and research costs
- Alliance scaling and the antitrust threshold

**Safety rails:** every change is versioned with a diff and one-click rollback · a **simulation preview** runs the change against a snapshot and reports the impact ("median route share shifts 4.2%; 31 routes flip operator") before anything goes live · promotion path is **sandbox → canary world → production**, never straight to production.

### 22.4 Event authoring **`[MVP]`**

The tool behind §15. Full CRUD on the event payload from A.13, plus:

- Visual calendar of scheduled events per world
- **Impact preview** — simulate against live data and report affected routes and demand delta before publishing
- Region suppression flags for legal/market compliance
- **Approval workflow required for sensitive events** (§15.3): drafted by one admin, reviewed and published by another, with the review recorded in the audit log
- Templates for recurring events (school holidays, seasonal peaks) with per-year date shifts
- Retract/amend a live event, with a player-facing notice

### 22.5 Aircraft catalogue editor **`[MVP-lite]`**

- Full CRUD on types: specs, all four era dates, prices, maintenance profiles
- Catalogue **versioning** — a world is pinned to a version, so retuning aircraft doesn't retroactively break running worlds
- **Manufacturer programme manager:** announce a prototype, set its published-vs-actual specs (the gap is the gameplay), schedule delays, or cancel the programme outright (§7.2c)
- Post-convergence speculative types authored here

### 22.6 Players, content & moderation **`[MVP]`**

- Account search; view any airline read-only with full financial history
- **Livery and logo moderation queue** — the highest-volume moderation surface in the game. Player-reported content is triaged here; hate symbols and impersonation are the known problem cases and need a fast path.
- Airline name / IATA-ICAO code / callsign conflict resolution
- Alliance administration: dissolve, force-remove, transfer ownership on founder inactivity
- Sanctions ladder: warn → force-rename → feature suspension → temporary ban → permanent ban, each with a required reason and an appeal record

### 22.7 Support & remediation **`[MVP]`**

- Read-only "view as player" for reproducing a reported issue
- Full transaction ledger per airline, searchable, with the ability to **reverse a specific transaction** rather than hand out compensation blind
- Reprocess or void an individual flight when the sim demonstrably misfired
- Compensation grants, capped per admin per day, logged and reviewable
- Restore an airline from a point-in-time snapshot

### 22.8 Observability **`[MVP-lite]`**

Sim health: tick lag, event queue depth, flights resolved per minute, error rates.

Economy health — the numbers that tell you a world is dying before players do:

- Median and distribution of player net worth (a Gini-style spread — runaway inequality kills retention)
- **Market concentration (HHI) by region** — the early warning for monopoly and mega-alliance capture
- Average load factor and fare levels — inflation and deflation detection
- New-player 7/30-day survival, and specifically **whether new entrants are reaching viable route share** (the A.12 validation test, monitored live)
- Automated alerts on runaway conditions

### 22.9 Feature flags & comms **`[MVP-lite]`**

- Per-world and per-cohort feature flags for staged rollout
- In-game announcement broadcast, written in the ops-bulletin register
- Maintenance banners and countdowns

### 22.10 Data & compliance **`[MVP]`**

- Automated backups with tested point-in-time restore
- GDPR data export and deletion, honoured without destroying world history (anonymise the player, keep the airline's operational record)
- Per-region content gating (§18.3)
- Full export of a world's config as JSON so a world is reproducible from source

---

## 23. MVP Definition — What Ships First

**In:**
- Shared persistent world, 2× real-time server sim, **epoch 20 Oct 2024**
- ~18 aircraft types with **real specs, era-gated by in-game date** (App. C), lease + used purchase
- **Factory options configurator** — range, MTOW, density, winglets, engine variant, with real trade-offs
- **Admin console core:** world creation, balance config with rollback, event authoring, moderation queue, support tooling, backups (§22)
- **Full airport dataset**, reachability checks, $500k start, free first hub, exponential hub costs (App. B)
- **Airport map** with gate holdings, live stands and turnaround progress
- **World view in both projections** — flat map and 3D globe, live route lines, livery-rendered aircraft (App. H)
- **Belly cargo** on passenger flights, with payload/range trade
- **Service & ancillary catalogue** (App. D) with tier bands, execution multiplier, and the live payback table
- **Loans and credit tiers** with DSCR cap, live interest drain, default ladder
- **Onboarding, Fleet Expansion Programme and daily check-in** (App. F)
- **Objectives system:** campaigns, milestones, mastery tracks, rotating operations, reward economy (App. G)
- **Full statistics suite:** executive, financial, traffic, fleet, crew, ground, reputation dashboards with forecasts and drill-down
- Live world map with real-time flights and flight detail panel
- **Full livery builder** (layers, shapes, text, cheatlines, logo composer, fleet apply)
- **Full cabin builder** (zones, seat products, constraints, product score)
- Route creation, slots, scheduling, per-class fare setting
- **Crew system:** bases, pools, ranks, type ratings, duty/rest/fatigue, purser, reserves
- **Ground services:** contracted vendors per station for fuel, catering, ramp/baggage, cleaning
- **Automation ladder** (manual / policy / delegated) across crew and ground
- **Scheduled event calendar** (seasons, holidays, a handful of named mega-events) with forecast bands
- Core office hires: Route Planner, Ops Controller, Chief Pilot, **Safety & Compliance** (gates long-haul/international rights), **Revenue Manager** and **Head of Ground Ops** (both required for the delegated automation tier)
- **Training academy L1–3, crew XP, personal skill trees, research tiers 1–2**
- Demand/competition model, weekly P&L by route
- Reputation, basic maintenance, basic disruption
- Public airline profiles + leaderboards incl. livery board

**Explicitly out of MVP:**
- **All partnership systems** — bilateral codeshares, alliances, the alliance brand creator — plus player-to-player marketplaces and wet lease. Codeshares ship first, as the foundation the alliance layer is built on.
- Breaking/crisis events, oil shocks, regional demand collapse
- **Ordering and operating dedicated freighters**, cargo contracts, ULD management, cargo terminals, ACMI *(freighter types appear in the App. C catalogue as data from day one; they are not orderable in MVP)*
- Bond issues, sale-leaseback, alliance analytics
- **Launch-customer programmes and manufacturer announcements** *(types in their prototype window are visible in the catalogue with their status shown; they simply cannot be ordered early in MVP)*
- Historical-era worlds (1950s+), multi-world operation, speculative post-convergence content
- **Loyalty programme** (App. E): configurator, tiers, co-brand deals, liability, development research tree
- Marketing campaigns
- Cabin cross-section flight view, apron/gate layout
- Fuel hedging, fare buckets, dynamic pricing, tankering
- Industrial action, staff poaching between players, self-handling as a sellable service
- Academy L4–5, research tiers 3–4, Training Captains, selling sim slots to other players
- Remaining office roster (CFO, Brand Director)
- SVG logo upload
- Seasons/resets

**MVP success test:** *Does a player come back the next morning to see where their aircraft ended up — and does anyone screenshot their livery unprompted?*

**The measurable version (App. F.8):** >75% reach their first departure, >50% complete 90 minutes, and the strongest signal of all — the share of day-1 players who open the livery builder a *second* time.

---

## 24. Open Design Debt

An audit of this document surfaced systems that are **referenced by existing mechanics but not yet specified**. They are listed here rather than left implicit, ordered by how much depends on them. Nothing below is optional-but-nice; each one is already load-bearing somewhere in the text above.

### Blocking for MVP

| Gap | Referenced by | Why it blocks |
|---|---|---|
| **Disruption model** | §8.4 is four lines | OTP, reputation, crew timeout (§9.2), Cat IIIb (App. C.3), the −30% incident boost (§10.4), the Ops Controller hire, and A.1's "randomness lives in disruption" all rest on it. **The second-largest hidden system after Appendix A.** |
| **Weather** | Disruption, crew XP (§10.2), de-icing (§9.3), remote stands (App. B.6) | No source, granularity, forecast horizon or seasonality defined |
| **AI / NPC carriers & world seeding** | A.8's whole worked example, A.10's monopoly guard, §22.8's HHI monitoring | 500 players cannot populate 4,000 airports. Without AI incumbents the world is empty and the demand model has nothing to compete against |
| **Maintenance** | §7.3 is two bullets | AOG, check scheduling, retrofits (App. C.3), hangar facilities (App. B.5), lender repossession (§13.5) |
| **Slots** | §8.1 is three lines; §21 open question 3 unresolved | Called "the scarce resource of the shared world" (§16). Allocation at world launch is still an open question about an MVP system |
| **Safety, incidents & insurance** | §10.2, §10.3, §10.4, §9.1 all reference incidents | No incident definition, severity ladder, investigation, grounding, or hull/liability cover — the latter mandatory for leased and financed airframes |
| **Currency, FX & tax** | §11, §13, §14 unit economics | The document mixes `$` and `€`; §13.4 derives dollars from a euro fare. No home currency, no corporate or ticket taxes, in a game promising full P&L |
| **Regulatory layer** | App. B.4 check 6, §19 gates, A.10's "regulator investigation" | Traffic rights, AOC, freedoms of the air and the regulator entity are all named and none defined |
| **Anti-cheat & multi-accounting** | Slots, exclusive gates, alliance voting, livery contests, player trading | The most predictable exploit in the design, entirely unaddressed |
| **Server architecture & scale** | §21 is eight bullets | No stack, sharding, concurrency target, persistence model, or `player_cap` value. The only scale figure in the document is a 30 MB distance matrix |

### Needed before launch, not before MVP

Crew labour market as a real shared pool (§9.2 asserts one) · lessor counterparties, lease terms and return conditions · used-aircraft supply and depreciation model · distribution channel and booking costs · seasonal schedules (A.2 has a `Season` term; §8.2 has only permanent rotations) · service recovery and passenger compensation · passenger charter and wet lease (named revenue lines in §11) · aircraft delivery positioning and ferry flights · IATA code scarcity (~1,300 usable two-letter codes vs. an unbounded player count) · in-game communication, without which alliances, poaching and marketplaces cannot function · progressive tutorials past week one · endgame, prestige and the seasons/reset philosophy (§16 and §7.2b currently propose two competing ones)

### Production, not design

Team, roles, budget, timeline and critical path · art production plan and asset counts · QA plan including economy regression, determinism tests and rollback drills · live-ops staffing and content cadence · localisation and unit systems (the document currently mixes nm, ft, m, t and kg) · legal — ToS, age rating, UGC liability and DMCA, payment compliance · business KPIs beyond the onboarding funnel

### Two decisions to make deliberately

1. **Reset philosophy.** §7.2b argues era-gating provides a natural reset without wiping worlds; §16 proposes seasonal resets with prestige carry-over. Both are defensible. **They are not compatible**, and choosing late will cost architecture.
2. **Sim fidelity ceiling.** Weather, ATC and disruption can each be modelled anywhere from a probability table to a real system. The 2× clock rewards depth, but every increment multiplies server cost and QA surface. Set the ceiling before building, not during.

---

## 25. Next Steps

1. Lock the name and secure the domain / app handles
2. Paper-prototype the demand share formula — it decides whether the game is fair
3. Prototype the livery builder standalone (it's the highest-risk, highest-value component)
4. Define the aircraft template layer schema before any art is produced
5. Build a single-route real-time vertical slice to validate that 2× time feels good and not slow
6. Model the boost ceilings against a year-one vs. year-two airline — confirm the veteran edge is beatable
7. Paper-test the crew duty/rest model against a 4-leg day — confirm it produces interesting failures, not just admin
8. Implement Appendix A as a standalone simulator and tune the β coefficients before any UI is built
9. Write the §18.3 house style into a one-page editorial standard every event author signs off against
10. Author one full year of the event calendar as data (Oct 2024 → Oct 2025, from the real record) to prove the format holds
11. Build the aircraft catalogue with real specs and era dates first (App. C) — it's the backbone of both the modern and historical worlds
12. Implement `effective_spec` as the single source of truth before any option exists, so nothing downstream ever special-cases a configuration
13. Build the admin console **before** the first public world opens, not after
14. Import and clean the airport dataset; precompute the distance matrix (App. B.9)
15. Playtest the first 90 minutes against App. F, especially the airborne livery session — it's the whole hook
16. Build the profit-by-route chart (§14.4) early — it's the tool players will learn the game through
17. Validate the loan caps against a losing airline: confirm it genuinely cannot borrow (§13.1)
18. Tune the service tier bands (App. D.1) so no two bands overlap after execution is applied — verify with the extremes
19. Model the loyalty programme over 3 in-game years to confirm the liability wave actually arrives and bites (App. E.4)
20. Author *one* full campaign end-to-end (App. G.2) before writing any others — prove the format carries before scaling it
21. Lock the earnable-vs-purchasable line on design items (App. G.4) before the store exists, not after
22. Build the world renderer with **both projections from day one** (App. H.2) — retrofitting a globe onto a flat-map codebase is a rewrite
23. Close the §24 blocking gaps in order — **disruption first**, since more systems depend on it than on anything except Appendix A
20. Lock the earnable-vs-purchasable line on design items (App. G.4) before the store exists, not after

---

# Appendix A — Demand & Competition Model

**`[MVP]`** — the core arbiter of the entire game. Everything else in this document eventually resolves into this appendix: your fare, your cabin, your crew, your catering, your on-time record and your brand all become numbers here, and this is where the game decides who fills a seat.

## A.1 Design principles

Four requirements, in priority order:

1. **Explainable.** A player who loses a route must be able to see *exactly* why, decomposed by factor. If the model is a black box, players will assume it's rigged — and in a persistent shared world, that belief is fatal.
2. **Deterministic.** Same inputs, same outputs. Randomness lives in disruption events (weather, faults), never in demand allocation. Players must be able to plan.
3. **No dominant strategy.** Cheapest, most premium, and highest-frequency must all be viable on *different* routes. If one wins everywhere, there is no game.
4. **Cheap to compute.** This runs across every route, every operator, every departure, forever.

The model is a **segmented multinomial logit** — the same structure real airline planning departments use. It is well-understood, well-behaved, and, critically, **exactly decomposable**, which buys principle 1 for free.

## A.2 Step 1 — Market size (the demand pool)

Each city pair has a base daily pool, generated once from a gravity model and then modulated live.

```
D_base = k · (Pop_o · Wealth_o · Pop_d · Wealth_d)^α · f(distance) · Affinity_od
```

- `α` ≈ 0.4 — sub-linear, so megacity pairs don't dwarf everything
- `f(distance)` — rises from ~0 at very short distance (surface transport competes), peaks at medium haul, decays slowly at long haul
- `Affinity_od` — tourism pull, business links, historical/migration ties (drives VFR), shared language

Live modulation:

```
D_route = D_base · Season(date) · DayOfWeek · Economy_global · InducedDemand(fare)
```

### Segments

The pool splits into three passenger segments, each with its own behaviour. **This split is what makes different strategies viable.**

| Segment | Typical share | Cares about | Ignores |
|---|---|---|---|
| **Business** | 10–35% | Frequency, schedule timing, product, reliability | Price (mostly) |
| **Leisure** | 40–70% | Price, price, price | Almost everything else |
| **VFR** | 15–30% | Price, but sticky to familiar/national carriers | Product |

A route's segment mix is a property of the city pair. AMS–LHR is business-heavy. AMS–PMI is leisure-heavy. **You choose which market you're built for.**

### Induced demand (price elasticity of the whole market)

The pool itself grows or shrinks with the market's average fare:

```
InducedDemand = (P_avg_market / P_reference)^(-ε)
   ε_business = 0.35     ε_leisure = 0.9     ε_VFR = 0.7
```

Cheap fares grow the market. This is why an LCC entering a sleepy route doesn't purely steal — it partly *creates*. It also means a whole market of high-fare operators is a smaller market.

## A.3 Step 2 — Attractiveness (utility per operator, per segment)

For each operator `i` on the route, for each segment `s`:

```
U(i,s) = − β_price(s) · PriceRel(i)
         + β_prod(s)  · ProductScore(i)
         + β_freq(s)  · ln(Frequency(i))
         + β_sched(s) · SchedFit(i,s)
         + β_rep(s)   · Reputation(i)
         + β_loyal(s) · Loyalty(i)
         + Alliance(i,s)
         − ConnectionPenalty(i,s)
```

### Terms

| Term | Definition | Fed by |
|---|---|---|
| `PriceRel` | operator fare ÷ market average fare | §8.3 pricing |
| `ProductScore` | 0–1 composite: seat product, pitch, IFE, catering tier, **crew service quality** | §6.4 cabin, App. D, §9.2 crew |
| `ln(Frequency)` | daily departures, **log** — 2→4 flights matters far more than 10→12 | §8.2 scheduling |
| `SchedFit` | how well departure times match segment preference (business wants early-out/late-back; leisure doesn't care) | §8.2 |
| `Reputation` | OTP, cancellation rate, service consistency | §15 |
| `Loyalty` | frequent-flyer stickiness *(post-MVP)* | App. E.5 |
| `Alliance` | codeshare/feed bonus *(post-MVP)* | §17 |
| `ConnectionPenalty` | one-stop itineraries penalised vs. nonstop; business heavily, leisure mildly | §8.2 hub banks |

### Starting coefficients (to be tuned)

| β | Business | Leisure | VFR |
|---|---|---|---|
| price | 1.1 | 3.0 | 2.4 |
| product | 2.2 | 0.8 | 0.6 |
| frequency | 1.6 | 0.9 | 0.8 |
| schedule | 1.0 | 0.4 | 0.4 |
| reputation | 1.4 | 0.5 | 0.7 |

**These six numbers are the entire game balance.** They belong in a config file that can be tuned live, never hard-coded.

## A.4 Step 3 — Market share

Standard softmax over operators within each segment:

```
Share(i,s) = exp(U(i,s)) / Σ_j exp(U(j,s))

Pax(i,s) = D_route · SegmentShare(s) · Share(i,s)
```

Then sum across segments for each operator's total demand.

## A.5 Step 4 — Capacity, spill & recapture

Demand is not bookings. If an operator's demand exceeds seats, the excess **spills** to competitors:

```
1. Booked(i)  = min( Demand(i), Seats(i) )
2. Spill      = Σ max( 0, Demand(i) − Seats(i) )
3. Redistribute Spill across operators with remaining seats,
   using shares re-normalised over that subset
4. Repeat once. Any remaining spill is lost demand (not carried over).
```

Two passes, not convergence to a fixed point — cheap and close enough.

**Spill is a real strategic signal.** A route where you consistently spill is a route where you should upgauge or add frequency, and the game should surface it as *"you turned away 40 passengers a day."* That's an actionable, satisfying number.

## A.6 Step 5 — Class allocation

Run the logit **per cabin class**, not just per route. Each class has its own fare, its own seat count, and draws from a segment mix weighted toward that class (business class draws mostly from the business segment).

This is what makes the cabin builder matter mechanically: a 1-2-1 business cabin only pays off where the business segment pool is deep enough to fill it. **Fit the cabin to the route, not to your ego.**

## A.7 Booking horizon (anti-exploit) — *see A.15 for the full curve*

Demand resolves **per departure, one in-game day ahead**, not instantly on price change.

This prevents the degenerate loop of flipping fares seconds before departure to game the model, and it mirrors reality: your pricing decision affects the flights you haven't sold yet. Price changes take effect with a visible, understandable lag.

## A.8 Worked example

**Route:** AMS–BCN · pool 1,200 pax/day each way · mix: 20% business, 60% leisure, 20% VFR

| Operator | Fare | Product | Freq | Reputation |
|---|---|---|---|---|
| **You** | €95 | 0.62 | 3× | 0.55 |
| **Rival A** (LCC) | €69 | 0.38 | 5× | 0.45 |
| **Rival B** (legacy) | €140 | 0.78 | 4× | 0.72 |

Market average fare = €101.33 → `PriceRel` = 0.938 / 0.681 / 1.382

**Leisure segment** (720 pax):

```
U(You) = −3.0(0.938) + 0.8(0.62) + 0.9·ln(3) + 0.5(0.55) = −1.053
U(A)   = −3.0(0.681) + 0.8(0.38) + 0.9·ln(5) + 0.5(0.45) = −0.065
U(B)   = −3.0(1.382) + 0.8(0.78) + 0.9·ln(4) + 0.5(0.72) = −1.913

shares → You 24.3%  ·  A 65.4%  ·  B 10.3%
pax    → You 175    ·  A 471    ·  B 74
```

**Business segment** (240 pax):

```
U(You) = −1.1(0.938) + 2.2(0.62) + 1.6·ln(3) + 1.4(0.55) = 2.861
U(A)   = −1.1(0.681) + 2.2(0.38) + 1.6·ln(5) + 1.4(0.45) = 3.292
U(B)   = −1.1(1.382) + 2.2(0.78) + 1.6·ln(4) + 1.4(0.72) = 3.422

shares → You 23.3%  ·  A 35.9%  ·  B 40.8%
pax    → You 56     ·  A 86     ·  B 98
```

**The model is working:** the same three airlines produce almost opposite outcomes in the two segments. The LCC takes 65% of leisure and the legacy carrier takes 41% of business *at double the fare*. Nobody wins everywhere.

**Totals** (VFR modelled on leisure betas): You 289/day · A 714/day · B 197/day

```
You:  289 ÷ 3 flights = 96 pax/flight  → 53% load factor  (overserving)
A:    714 ÷ 5 flights = 143            → 77%              (healthy)
B:    197 ÷ 4 flights = 49             → 27%              (bleeding badly)
```

## A.9 "Why am I losing?" — the decomposition

Because share is a ratio of exponentials, the utility gap decomposes **exactly**. Your leisure share vs. Rival A:

| Factor | ΔU (you − A) | Reading |
|---|---|---|
| Price | **−0.770** | Your €26 premium is most of the gap |
| Frequency | **−0.460** | 3× vs 5× — they're more convenient |
| Product | **+0.192** | Your cabin is genuinely better |
| Reputation | **+0.050** | Marginally more reliable |
| **Net** | **−0.988** | → `exp(−0.988)` = 0.372 = your 24.3% vs their 65.4% |

This is the model's most important property. **The waterfall isn't an approximation of the result — it *is* the result.** The UI shows this exact chart, and the player learns the game by reading it.

### The lesson it teaches

Say you add a 4th daily frequency. Share rises: leisure 24.3% → 29.4%, business 23.3% → 32.5%. Total demand climbs 289 → 361/day.

But you're now spreading it over four flights:

```
361 ÷ 4 = 90 pax/flight → 50% load factor  (down from 53%)
```

**More passengers, worse economics.** Frequency buys share but costs a whole aircraft rotation. The log term means the fifth frequency buys less than the fourth. Discovering that trade — and that it lands differently on a business route than a leisure one — is the actual game.

## A.10 Anti-degenerate rules

| Exploit | Guard |
|---|---|
| Price to zero and dominate | Fares below 60% of route variable cost are blocked; sustained below-cost pricing triggers a regulator investigation *(post-MVP)* |
| Infinite frequency spam | Slots are finite (§8.1); `ln` gives hard diminishing returns; each frequency costs a real aircraft and crew |
| Whale buys a market | Boosts are efficiency-only and capped (§10.4) — they can be leaner, never more attractive |
| New entrants are hopeless | **New-entrant bonus:** +0.3 utility on entry, decaying to zero over 14 real days — enough to get discovered, not enough to win |
| Ghost flights holding slots | Use-it-or-lose-it slot rule (§8.1 / App. B.8) |
| Monopoly forever | Fat margins on an uncontested route visibly attract AI entrants and are flagged publicly as an opportunity |

## A.11 Tuning levers

Ordered by how much they move the game. Change one at a time.

1. **β_price by segment** — the master dial for "is this a price war game or a product game?"
2. **Segment mix by route type** — decides how many distinct viable strategies exist
3. **β_freq** — controls whether frequency-stacking beats quality
4. **Induced-demand ε** — sets how much LCCs grow markets vs. cannibalise them
5. **New-entrant bonus size and decay** — the single biggest lever on long-term player retention

## A.12 Validation tests

The model ships only when all five pass:

1. **No dominant strategy** — LCC, full-service, and boutique-premium airlines each win a meaningful share of routes
2. **Segments separate** — a premium carrier loses leisure and wins business, per the worked example
3. **New entrant viability** — a fresh player entering a contested route reaches ≥15% share within **21 days** with a sensible plan — i.e. measured a full week *after* the A.10 entry bonus has decayed to zero, not at the moment it expires
4. **Monopolies erode** — an uncontested fat-margin route attracts entry within ~30 days
5. **Explicability** — 10 test players shown the waterfall can correctly state why they lost, unprompted

## A.13 Event modifiers (§18)

Events do not touch market share. They modify the **pool** and the **segment mix** — which means every existing balance rule keeps working untouched.

```
D_route = D_base · Season · DayOfWeek · Economy_global · InducedDemand
                 · Π EventMod(e, route, date)
```

Each event carries a small, fully inspectable payload:

```
Event {
  scale:        pool multiplier at peak, per direction
  directional:  true/false      // Lunar New Year: 2.4× outbound, 0.7× return
  segment_shift: { business, leisure, vfr }   // a trade fair inverts the usual mix
  ramp:         build-up curve into the peak
  decay:        recovery curve out of it      // shocks limp back, spikes stop dead
  geography:    origin set, destination set, or region pair
  visibility:   { announced_days_ahead, forecast_confidence }
  hard_effects: airspace closure, airport closure, reroute penalty
}
```

**Worked shape — a World Cup host city:** `scale 1.9×` on inbound routes, `segment_shift` toward leisure/VFR, `ramp` over 10 days, hard stop at the final, `decay` 3 days. Announced 60 real days ahead with a ±25% confidence band that narrows to ±8% in the final two weeks.

**The confidence band is the whole game.** Commit capacity early at ±25% and you're gambling for the best slots and the best fares. Wait for ±8% and the slots are gone. That tension is the entire event system in one sentence.

### Hard effects

Airspace and airport closures are **not** demand modifiers — they're routing constraints applied before the demand model runs. A closed corridor lengthens the great-circle path, raising block time and fuel burn, which flows into cost and schedule, which then flows into utility normally. No special-casing.

### Alliance terms (§17)

```
Alliance(i,s)         = β_alliance(s) · min( √(members_i) / √(12), 1.0 )
ConnectionPenalty(i,s) = base_penalty · (1 − interline_quality_i)
```

The `√(members)` with a hard cap at 12 is the anti-mega-alliance guard from §17.6, expressed in one line. Member 3 is transformative; member 40 is decorative.


## A.14 Connecting itineraries — the missing half of the model

**`[MVP]`** — A.2–A.9 model a single city pair served by direct operators. But hub-and-spoke is presented throughout this document as one of the two grand strategies (§8.2 banks, App. B.6's 5× gate cost, §17.3 alliance feed). **Without connecting itineraries, none of that has any maths behind it.** This closes that gap.

### The product is the itinerary, not the flight

For every O&D city pair, candidate products are enumerated:

```
Direct       A → B
One-stop     A → H → B     for every hub H where both legs are operated
                            by the same airline, or by codeshare partners
```

A one-stop itinerary is valid only if:

```
MCT(H) ≤ connection time ≤ 6 h        (MCT = minimum connect time at that airport,
                                        longer for terminal changes and immigration)
total detour ≤ 1.35 × great-circle A→B
both legs have available seats
```

### It competes as a single option

The itinerary enters the A.3 logit as one competitor, with combined attributes:

```
price          = sum of leg fares, less a connection discount the operator sets
product        = weighted mean of the two legs' product scores
frequency      = daily valid connections at H
ConnectionPenalty = base(segment) + λ · (connect_time − MCT) + terminal_change_penalty

base:  Business 0.9  ·  Leisure 0.35  ·  VFR 0.30
```

Business travellers hate connections; leisure travellers will accept one for a cheaper fare. That single asymmetry is why hub carriers chase business traffic and point-to-point LCCs chase leisure.

### Revenue proration

A booked itinerary's fare splits across legs by **distance × leg product weight**, so the operator of the long premium leg earns more of it. Across a codeshare or alliance boundary, the same formula divides revenue between airlines (§17.4).

### Why banks pay for themselves

Connection count at a hub scales roughly with the **square** of the aircraft on the ground together — every arrival can feed every departure. That is precisely why a banked hub puts every aircraft on the ground at once, and precisely why it costs 5× the gates (App. B.6).

```
one bank of 12 aircraft   ≈ 132 possible connections
12 aircraft rolling       ≈ a handful
```

**The gate bill and the connection revenue are the same decision seen from two sides.** That symmetry is the strongest argument in the design for building the hub system properly rather than approximating it.

### Cost and scale

Enumerating every one-stop over ~4,000 airports is O(n³) and impossible. Restrict candidate hubs to airports where the operator actually bases aircraft (≤ 10 per airline), evaluate only city pairs with a non-trivial demand pool, and cache per schedule change. That makes it tractable.

## A.15 The booking curve — reconciling A.7

A.7 said demand resolves once, one in-game day ahead. §14 charts a booking curve. Both are needed, so the resolution is:

**Demand accrues progressively across a booking horizon and each booking is priced at the fare in force at that moment.**

```
Booking horizon:  14 in-game days before departure
Curve:            ~15% of demand in days 14–8   (early leisure, price-led)
                  ~45% in days 7–3
                  ~40% in the final 48 h        (late business, price-tolerant)
```

- The logit runs **once per in-game day per departure**, allocating that day's slice of demand at current fares and current competitor attributes.
- Changing a fare affects only bookings **not yet taken** — the anti-exploit property A.7 was protecting, preserved exactly.
- Segment mix shifts across the curve, which is what makes late-window pricing genuinely different from early-window pricing and gives revenue management (post-MVP) something real to manage.

Cancelling or re-timing a flight inside the horizon forces rebooking, at your cost (§8.4).

---

# Appendix B — Airports, Hubs, Gates & the Route Dataset

**`[MVP]`** — Appendix A decides *who wins a route*. This appendix defines *which routes exist at all*, and it is the physical substrate the whole game sits on.

## B.1 Scope — every airport is loaded

The world contains the **complete real airport dataset**, not a curated shortlist. A player is never told "that airport isn't in the game." They're told "your aircraft can't reach it yet" — which is a goal, not a wall.

| Layer | Count | Role |
|---|---|---|
| **Full dataset** | ~75,000 | Everything with an ICAO code. Present as geography, mostly unserviceable. |
| **Scheduled-service airports** | ~4,000 | Have a demand pool and can be served commercially. The playable world. |
| **Hub-capable** | ~800 | Sufficient infrastructure to base a fleet |
| **Slot-coordinated** | ~200 | IATA Level 3 — finite slots, the contested space |

**Source:** OurAirports (public domain) for the base geography and runway data, enriched with catchment population, wealth index, and IATA slot-coordination level. Era worlds (§19.2) filter by opening/closing date, so a 1950s world simply doesn't contain airports built in 1994.

## B.2 Airport record

```
Airport {
  icao, iata, name, city, country, region
  lat, lon, elevation_ft, timezone
  runways[]      { length_ft, width, surface, ils_category }
  tier           // flagship | large | medium | small | regional
  slot_level     // IATA 1 (free) | 2 (schedules facilitated) | 3 (coordinated)
  catchment      { population, wealth_index, tourism_index, business_index }
  capacity       { movements_per_hour, contact_gates, remote_stands, cargo_stands }
  fees           { landing_per_tonne, pax_fee, parking_per_hour, gate_lease_annual }
  curfew         { start, end, exemptions }
  constraints    { noise_quota, max_wingspan_code, customs, fuel_available }
  opened, closed // era gating
}
```

`catchment` is what feeds the gravity model in A.2. Everything else feeds cost, feasibility, or scarcity.

## B.3 Tiers

| Tier | Count | Examples | Demand | Slots | Gate competition |
|---|---|---|---|---|---|
| **Flagship** | ~25 | LHR, JFK, DXB, HND/NRT, CDG, SIN, LAX, HKG, AMS, FRA | Enormous | Brutal, Level 3 | Vicious — this is the endgame |
| **Large** | ~120 | MAD, ZRH, YYZ, GRU, BOM, MEL | High | Level 3, contested | Real |
| **Medium** | ~500 | LYS, BHX, HAM, PMI, AUS | Moderate | Level 2 | Mild |
| **Small** | ~1,200 | Regional cities, secondary airports | Low but cheap | Level 1, free | None |
| **Regional** | ~2,200 | Islands, remote, turboprop-only | Thin, often subsidised | None | None |

**Regional airports are a deliberate niche, not filler.** Short runways, no jet access, thin but *uncontested* demand, and sometimes public service obligation subsidies. A turboprop specialist operating where nobody else can reach is a legitimate winning strategy, and it's the strategy the starting bankroll naturally points at.

## B.4 Reachability — what you can actually fly

A route is offerable if **all** of these pass. The UI shows exactly which one failed, never a generic "unavailable."

```
1. Range        great_circle × 1.06  ≤  aircraft range at planned payload
2. Runway       required_takeoff_length(aircraft, payload, elevation, temp) ≤ longest runway
3. Wingspan     aircraft code ≤ airport max wingspan code
4. Overwater    ETOPS rating required for the routing (§10.3 research)
5. Curfew       schedule fits the airport's operating hours both ends
6. Rights       traffic rights exist for the country pair (§8.1)
7. Slot         a slot is available in your chosen time band
```

**Payload/range is a live trade, not a fixed number.** Filling every seat on a marginal sector may put you over max takeoff weight — so you fly it with seats blocked, or you tech-stop, or you buy a longer-range variant. The cabin builder (§6) reaches directly into this: a heavy premium cabin costs you range.

### What $500,000 actually reaches

The starting bankroll is deliberately small. It buys one turboprop on lease, a deposit, and a few weeks of working capital:

```
Opening balance                      $500,000
  ATR 72-600 lease deposit (2 mo)    -$170,000
  Livery paint + cabin fit           -$60,000
  Initial crew hire & training        -$45,000
  Ground handling contracts (2 ports) -$25,000
  Working capital reserve             $200,000
```

An ATR 72 at full load has roughly a **700 nm** practical radius. From Amsterdam that's a real, rich map:

| Route from AMS | Distance | Reachable at start? |
|---|---|---|
| LHR London | 199 nm | Yes |
| CDG Paris | 215 nm | Yes |
| CPH Copenhagen | 342 nm | Yes |
| DUB Dublin | 405 nm | Yes |
| VIE Vienna | 518 nm | Yes |
| WAW Warsaw | 595 nm | Yes |
| BCN Barcelona | 670 nm | Marginal — payload-limited |
| MAD Madrid | 789 nm | **No** — needs a jet |
| JFK New York | 3,157 nm | No |
| NRT Tokyo | 5,032 nm | No |

**LHR–NRT is 5,179 nm.** It sits at the far end of a progression that runs turboprop → regional jet → narrowbody → widebody → ULH, and it should take a player months of real time to earn. That gap *is* the campaign.

## B.5 Hubs

A hub is where you base aircraft, hold gates, station crew, and build an academy. Without one you have no operation.

### Cost

**Your first hub is free**, at any tier. Cost then follows tier base price, **doubling with every hub you already own**:

```
HubCost = TierBase × 2^(hubs_owned − 1)

TierBase:  Small $2M · Medium $5M · Large $10M · Flagship $25M
```

| Hub # | Small | Medium | Large | Flagship |
|---|---|---|---|---|
| 1st | **free** | **free** | **free** | **free** |
| 2nd | $2M | $5M | $10M | $25M |
| 3rd | $4M | $10M | $20M | $50M |
| 4th | $8M | $20M | $40M | $100M |
| 5th | $16M | $40M | $80M | $200M |
| 6th | $32M | $80M | $160M | $400M |
| 7th | $64M | $160M | $320M | $800M |
| 8th | $128M | $320M | $640M | $1.6B |

### The strategic tension this creates — and it's excellent

The multiplier counts **hubs owned**, not hubs of that tier. So **every cheap hub you buy makes every future flagship twice as expensive.**

```
Four flagships as hubs 2–5:                    $375M
Three small hubs first, then four flagships:   $14M + $3,000M
```

Buying $14M of convenience early costs you **$2.6 billion** later. That's a genuine, legible, painful decision — exactly what a progression curve should be. Breadth and prestige are in direct opposition, and the player can see the arithmetic before committing.

Practical ceiling is around 8–10 hubs, which is right: real global airlines run 3–6 real hubs. The curve enforces realism without a hard cap.

### The free first hub — a design decision worth stating

You can take **any** airport as your free hub, Dubai included. Nothing blocks it. It self-balances instead:

- **Annual facility fees scale with tier** — a flagship hub bleeds you monthly from day one
- **Slot scarcity is brutal at Level 3 airports** — as a new entrant at LHR you get 05:40 and 23:10, and nothing else. Your $500k turboprop flies two hostile slots a day.
- A medium hub gives you *good* slots and cheap gates immediately

The game recommends small/medium in the onboarding and shows the fee comparison, but it never blocks the choice. **Ambition should be allowed to be a mistake** — and a player who starts at a flagship and survives has a story worth telling.

### Hub facilities

Unlocked per hub, each with its own cost: crew base (§9.2) · training academy (§10.1) · maintenance line, then heavy check capability · lounge (product score) · cargo facility · self-handling station (§9.3).

## B.6 Gates & stands

**Slots and gates are different scarce resources and both matter.** A slot is *permission to move* at a time. A gate is *somewhere to park*. You can hold a slot and have nowhere to put the aircraft.

### Stand types

| Type | Cost | Turnaround | Passenger effect |
|---|---|---|---|
| **Contact gate** (jet bridge) | Highest | Baseline | Neutral to positive |
| **Remote stand** (bus boarding) | ~35% of contact | **+10–12 min** | Small satisfaction penalty; worse in bad weather |
| **Overnight parking** | Cheap | n/a | None — nobody's aboard |
| **Cargo stand** | Medium | Cargo-specific | n/a |
| **Maintenance stand** | Tied to hangar | n/a | n/a |

### Contract types — where the shared-world conflict lives

| Contract | Cost | Guarantee | Effect on rivals |
|---|---|---|---|
| **Common use** | Per-turn fee | None — first come, and you can be bumped at peak | None |
| **Preferential** | Annual lease | Priority; others use it when you don't | Mild |
| **Exclusive** | Annual lease, ~2.5× preferential | Guaranteed, always yours | **Denies it to everyone else** |

Exclusive gates at flagship airports are finite and permanently contested. Holding gates you barely use is a legitimate blocking strategy — countered by a **use-it-or-lose-it utilisation floor**, same principle as slots (§8.1).

### How many gates do you actually need?

Gate requirement is driven by **peak concurrent aircraft on the ground**, not by fleet size. Simulated across a full operating day (4 rotations/aircraft, 70-minute sectors, 40-minute hub turns):

| Based aircraft | Rolling (point-to-point) | Banked (hub-and-spoke) | Overnight positions |
|---|---|---|---|
| 1 | 1 gate | 1 gate | 1 |
| **2** | **1–2 gates** | **2–3 gates** | **2** |
| 4 | 2 | 5 | 4 |
| 8 | 3 | 11 | 8 |
| 16 | 5 | 23 | 16 |
| 30 | 9 | 42 | 30 |
| 60 | 17 | 84 | 60 |
| 120 | 32 | 171 | 120 |

```
ContactGates = ceil( P95(concurrent aircraft in turnaround) × 1.2 )
OvernightPositions = based aircraft not airborne at night
```

**The headline finding: a banked hub needs roughly five times the gates of a rolling point-to-point operation for the same fleet.** Connection banks work by putting every aircraft on the ground simultaneously — that's the entire mechanism — and gates are what that costs.

This is the best systems link in the whole document. Hub-and-spoke gives you connecting traffic and alliance feed value (§8.2, §14.3), and it charges you for it in the single most contested resource at flagship airports. Point-to-point is gate-cheap and connection-poor. **Neither dominates, and the player discovers the trade by paying for it.**

*Calibration note:* real hubs soften this by **towing aircraft to remote stands between waves** — a mechanic worth including, since it trades cheap ground equipment and tug crews for expensive contact gates. Without towing, the model slightly overstates flagship-hub gate needs.

### Worked example — your Amsterdam hub, 2 routes

**Setup:** AMS hub · 1× ATR 72-600 · AMS–LHR and AMS–CDG · 40-min hub turns

```
06:00  AMS → LHR      07:05 arr
07:40  LHR → AMS      08:45 arr    ── on stand AMS 08:45–09:25
09:25  AMS → CDG      10:35 arr
11:10  CDG → AMS      12:20 arr    ── on stand AMS 12:20–13:00
13:00  AMS → LHR      14:05 arr
14:40  LHR → AMS      15:45 arr    ── on stand AMS 15:45–16:25
16:25  AMS → CDG      17:35 arr
18:10  CDG → AMS      19:20 arr    ── overnight AMS 19:20–06:00
```

**Peak concurrent on stand: 1.**

```
AMSTERDAM — your holdings
  1 × contact gate, preferential lease      $18,000/mo
  1 × overnight parking position             $2,200/mo
  Ground handling: contracted (§9.3)
  Gate utilisation: 3 turns/day · 2.0 h occupied of 17 h  →  12%
```

**You are paying for a gate you use 12% of the time.** That's the lesson the first hub teaches, and it's the correct one: your gate is nearly idle, your aircraft is your only revenue source, and the fix is *more rotations*, not more gates. Only when a second and third aircraft start overlapping on the ground does a second gate become necessary.

**Growth path from here:**

| Fleet | Routes | Contact gates | Overnight | Note |
|---|---|---|---|---|
| 1 | 2 | 1 | 1 | 12% gate utilisation |
| 2 | 3 | 1–2 | 2 | Still one gate if you offset the schedules |
| 4 | 6 | 2 | 4 | Second gate now genuinely needed |
| 8 | 12 | 3 | 8 | Consider a first connection bank |
| 16 | 20+ | 5 rolling / 23 banked | 16 | **The hub-vs-point-to-point decision, and it's expensive either way** |

## B.7 The airport map

Zoom from the world map into any airport you operate at. A clean 2D schematic — accurate in topology, stylised in geometry, in the house design language.

**What's rendered:**

- Terminal piers and the full gate layout, real gate numbering
- **Your gates highlighted in your brand colours** — the airport visibly becomes yours as you grow
- Rival gates in muted neutrals; unleased gates in outline. **You can see exactly who holds what**, which makes gate competition legible and personal.
- Live aircraft on stand, wearing their liveries, with turnaround progress rings — fuelling, catering, bags, cleaning, boarding, each ticking through
- Remote stand apron, cargo area, maintenance hangar, de-icing pads
- Runways with live movements

**Interactions:** click a gate to see the day's rotation and utilisation · click your aircraft for the flight panel · lease/release gates directly on the map · a **utilisation heat overlay** showing which of your gates are idle and which are jammed.

**Why this matters beyond utility:** it's the second place, after the livery builder, where your airline becomes a *visible object* rather than a spreadsheet. Watching your own liveries fill a pier at Schiphol is the payoff for everything else in this document.

**Post-MVP:** apron congestion and taxi routing, gate assignment as an optimisation puzzle, seasonal weather on the apron, terminal-level passenger flow.

## B.8 Slots vs gates — the distinction, plainly

| | Slot | Gate |
|---|---|---|
| **What** | Right to depart or arrive in a time window | Physical place to park |
| **Scarcity** | Level 3 airports only | Anywhere popular |
| **Held by** | Airline, per time band, per day | Airline, per lease term |
| **Lost by** | Use-it-or-lose-it (80% rule) | Lease expiry or utilisation floor |
| **Traded** | Player-to-player marketplace (post-MVP) | Sublease to other players (post-MVP) |
| **Blocks rivals** | Yes | Yes, if exclusive |

You need **both** to fly a schedule. Acquiring one without the other is a classic new-player mistake and the UI should warn about it loudly — not prevent it.

## B.9 Data pipeline

- Airport dataset imported and version-pinned per world (§22.5)
- Great-circle distances precomputed for the ~4,000 serviceable airports — a 16M-entry symmetric matrix, ~30 MB packed. Trivially cacheable, and it means reachability checks are a lookup, not a calculation.
- Demand pools computed at world creation from catchment data, then modulated live (A.2)
- Runway performance evaluated per aircraft/payload/airport at route creation, cached per triple
- Admin-editable overrides for any field, since real data always contains errors

---

# Appendix C — Aircraft Catalogue & Factory Options

**`[MVP]` catalogue and options** — the configurator ships with the catalogue; §23 lists it in MVP scope — real aircraft, real numbers, and a manufacturer configurator where every gain is paid for somewhere else.

## C.1 Principle

Aircraft use **real designations and real published specifications**. Players who know aviation must find the numbers correct, because those players are the audience and they will check. The catalogue is authored data (§22.5), versioned per world, and era-gated by the four dates in §7.2b.

*Practical note: aircraft type designations are factual and widely used in simulation titles, but manufacturer logos, trade dress, and house liveries are trademarked. Ship type names and specs; don't ship Boeing's or Airbus's marks.*

## C.2 Base catalogue — launch set

Real published figures, two-class seating where applicable.

| Type | Seats | Range (nm) | MTOW (t) | Runway (m) | List | EIS | Notes |
|---|---|---|---|---|---|---|---|
| ATR 72-600 | 70 | 825 | 23.0 | 1,315 | $26M | 2011 | The starting aircraft |
| Dash 8-400 | 78–90 | 1,100 | 29.3 | 1,290 | $32M | 2000 | Fast turboprop |
| E190-E2 | 97–114 | 2,850 | 56.4 | 1,450 | $61M | 2018 | Thin jet routes |
| A220-300 | 130–160 | 3,350 | 70.9 | 1,890 | $91M | 2016 | Efficient small narrowbody |
| 737-800 | 162–189 | 2,935 | 79.0 | 2,100 | — | 1998 | **Used market only** — out of production |
| 737 MAX 8 | 162–178 | 3,500 | 82.2 | 2,300 | $121M | 2017 | |
| A320neo | 165–180 | 3,500 | 79.0 | 2,100 | $110M | 2016 | |
| A321neo | 180–220 | 4,000 | 97.0 | 2,200 | $129M | 2017 | |
| **A321XLR** | 180–220 | 4,700 | 101.0 | 2,500 | $142M | **Nov 2024** | Arrives ~3 weeks into the flagship world |
| 787-9 | 290 | 7,565 | 254.0 | 2,800 | $292M | 2014 | |
| A350-900 | 300–350 | 8,100 | 283.0 | 2,600 | $317M | 2015 | |
| A350-1000 | 350–410 | 8,700 | 319.0 | 2,900 | $366M | 2018 | |
| 777-300ER | 396 | 7,370 | 351.5 | 3,100 | $375M | 2004 | Production winding down |
| **777-9** | 400–425 | 7,285 | 351.5 | 3,050 | $442M | *pending* | **Prototype window** (§7.2c) |
| A380-800 | 525–615 | 8,000 | 575.0 | 3,000 | — | 2007 | Used only — production ended 2021 |
| 777F | 102 t payload | 4,970 | 347.8 | 2,800 | $352M | 2009 | Freighter |
| 747-8F | 137 t payload | 4,120 | 447.7 | 3,100 | — | 2011 | Used only — ended 2023 |
| ATR 72-600F | 9 t payload | 900 | 23.0 | 1,315 | $28M | 2020 | Feeder freighter |

**The epoch pays off immediately.** A world starting 20 October 2024 has the **A321XLR entering service three weeks in** — a real, dated, verifiable event that reshapes thin long-haul. Meanwhile the **777-9 sits in its prototype window**, and the 737 MAX 7 and MAX 10 are awaiting certification. That's a live manufacturer landscape on day one, drawn from the actual record.

## C.3 Factory options — the configurator

When ordering new, you configure the aircraft. **Every option is paid for in money, weight, space, or time — never none of them.** That constraint is the whole feature.

| Option | Gain | Cost |
|---|---|---|
| **Auxiliary centre tanks** (1–3) | +250 to +700 nm | −18% to −40% belly cargo volume · +1.5–2.5 t OEW · +$4–9M |
| **Increased MTOW** (paper upgrade) | +payload or +range at same fuel | **+landing fees at every airport** (charged per tonne) · +maintenance · +$3–7M |
| **High-density exit configuration** | +12% to +22% max certified seats | −galley and lav space · +5 min turnaround · comfort score −0.15 |
| **Lightweight cabin package** | −1.8 t OEW → +range, −burn | Thinner seats: comfort −0.10 · higher wear cost |
| **Sharklets / winglets** | −3.5% fuel burn | +$2.5M · **+wingspan → may push you to a wider gate code** |
| **Engine thrust rating** (higher) | Hot-and-high and short-field capability | +6% burn · +18% engine maintenance |
| **Engine variant** (e.g. CFM vs PW) | Different burn / maintenance / reliability profile | Splits your engineering pool — a commonality penalty |
| **ETOPS 180 / 330 package** | Direct oceanic routings | +$3–8M · requires §10.3 research and rated crew |
| **Cat IIIb autoland** | −60% low-visibility cancellations | +$2M · crew training requirement |
| **Main-deck cargo door / combi** | Convertible to freight (§12) | −22 seats · +2.1 t OEW · +$11M |
| **Crew rest module** | Legal for ULH sectors (§9.2) | −14 to −22 seats |
| **Folding wingtips** (777-9) | Code F aircraft fits a **code E gate** | +$4M · +0.9 t |
| **Rough-field kit** *(era worlds)* | Unpaved and gravel strips | +burn · +maintenance |
| **Extra fuel-efficiency package** | −2% burn | +$5M · longer delivery lead time |

### The rules that make it a real decision

1. **No free lunch.** Every option debits at least one of: seats, payload, range, burn, comfort, maintenance cost, wingspan code, or delivery date.
2. **Options extend delivery.** A heavily customised aircraft is delivered weeks later than a standard one. Ordering off-the-shelf is a legitimate speed play.
3. **Wingspan is a live constraint.** Sharklets and larger variants can push an aircraft into a wider ICAO code, and your existing gates may not take it (App. B.2 `max_wingspan_code`). **A fuel-saving option that strands you at your own hub is exactly the kind of mistake this system should let you make.**
4. **MTOW increases raise landing fees forever.** Landing fees are per tonne at every airport, every flight. A paper MTOW upgrade taken casually is a permanent cost line.
5. **Retrofit is possible but worse.** Most options can be added later at a hangar during a heavy check — more expensive, plus downtime, and some (structural, engine variant) can't be changed at all.

## C.4 Worked example — one A321neo, three ways

| | **Standard** | **Long-range** | **High-density** |
|---|---|---|---|
| Configuration | Base | +3 ACT, +MTOW, ETOPS 180 | High-density exits, lightweight cabin |
| Seats (1-class) | 200 | 200 | **244** |
| Range | 4,000 nm | **4,700 nm** | 3,800 nm |
| Belly cargo volume | 100% | **62%** | 94% |
| MTOW | 97 t | **101 t** | 97 t |
| Comfort score | 0.55 | 0.55 | **0.38** |
| Turnaround | baseline | baseline | **+5 min** |
| Price | $129M | **$146M** | $132M |
| Delivery lead | baseline | **+7 weeks** | +2 weeks |
| **Best for** | Everything, adequately | Thin transatlantic, no belly freight | Dense leisure, price war |

Three genuinely different aircraft from one type. **The long-range build trades away 38% of its cargo hold** — which, per §12.1, is exactly the revenue that makes marginal long-haul work. That tension is the point: you buy the range by giving up the freight that would have paid for it.

## C.5 Used market & resale

Custom configuration follows the airframe forever.

- A **common** configuration sells fast at a good price
- An **unusual** one is cheap to buy and hard to sell — a bargain if it fits your network, a liability if it doesn't
- Buying used means buying **someone else's decisions**, including their cabin, their engine variant and their MTOW rating
- In the player-to-player used market (post-MVP), specification becomes part of the negotiation

**This is the best reason for the whole options system to exist:** it makes every airframe an individual object with a history, rather than an interchangeable unit of capacity.

## C.6 Data model

```
AircraftType   { designation, family, manufacturer, base_spec, four_era_dates,
                 available_options[], option_conflicts[] }
Option         { id, spec_deltas{}, price, weight, lead_time_weeks,
                 retrofittable, requires_research[], conflicts_with[] }
Airframe       { type, registration, build_config[], cabin_config, livery_id,
                 hours, cycles, owner_history[], effective_spec (computed) }
```

`effective_spec` is derived from base spec plus option deltas plus cabin weight, cached per airframe, recomputed on any change. **Everything downstream — reachability (App. B.4), fuel burn, fees, demand — reads only `effective_spec`.** Nothing special-cases options, which is what keeps the system from becoming unmaintainable.

---

# Appendix D — Service & Ancillary Catalogue

**`[MVP]`** — the catalogue and payback table ship in MVP; the deepest fittings (§6.3) arrive after — the cabin builder (§6) decides what the seat *is*. This appendix decides what happens *in* it. Together they produce the `ProductScore` that Appendix A turns into passengers.

You can run a stripped-back budget carrier that charges for everything including scratch cards, or a chauffeur-and-caviar operation. Both are viable. Neither is free.

## D.1 The tier-band rule

**Tier sets the ceiling. Execution decides where you land inside it.**

This is the same pattern as the training academy (§10) — permission first, performance second — and it directly answers the design requirement that *a basic offering can never beat a luxury one, however well run*.

Service bands **do not overlap**:

| Tier | Catering example | Score band | Cost/pax (short-haul) |
|---|---|---|---|
| 0 | Nothing at all | 0.00 – 0.05 | €0 |
| 1 | Buy-on-board only | 0.10 – 0.25 | **−€4.20** (net revenue) |
| 2 | Complimentary snack & drink | 0.28 – 0.42 | €3.10 |
| 3 | Hot meal service | 0.45 – 0.62 | €8.40 |
| 4 | Multi-course, real crockery | 0.65 – 0.82 | €31.00 |
| 5 | Chef-designed, dine-on-demand | 0.85 – 1.00 | €78.00 |

A **perfectly executed Tier 2** tops out at 0.42. A **badly executed Tier 3** floors at 0.45. The hot meal still wins. Execution never jumps a band — it only decides whether you're getting full value from the money you're already spending.

### What moves you within a band

```
Execution = f( crew service skill (§10.2) · crew morale (§9.2)
             · catering vendor quality (§9.3) · crew-to-passenger ratio )
```

**The weakest input dominates.** Chef-designed catering served by an exhausted, understaffed crew lands at the bottom of Tier 5 — you paid €78 a head for 0.85 when you could have had 1.00. That's the most expensive mistake in the catalogue and it's entirely self-inflicted.

### What crew training buys

Per your brief, training does two things at once:

- **Raises execution** → you climb toward the top of your band, at no extra catering spend
- **Lowers cost** → up to **−25%** service cost per passenger at maximum training, through less waste, faster service, fewer complaints and fewer service recovery payouts

A well-trained crew makes a Tier 3 offering cost like a Tier 2 and score like a strong Tier 3. **That's the return on the academy, expressed in a line the player can see on the P&L.**

## D.2 The catalogue

Selectable per cabin class, per route group. Every line has a cost, a revenue, a satisfaction delta, and often a turnaround cost.

### Food & beverage
Catering tier (above) · alcohol policy (none / buy / complimentary / premium wine list) · special meals · welcome drink · hot towels · mid-flight snack bar · dine-on-demand timing

### Baggage & seating *(the classic ancillary levers)*
Cabin bag policy · checked bag pricing · seat selection fees · extra-legroom pricing · priority boarding

Charging for these is **highly profitable and mildly resented**. Leisure passengers accept it; business passengers penalise it more.

### Inflight entertainment & connectivity
None · BYOD streaming · seatback · 4K seatback with power · Wi-Fi (paid / free / free messaging only)

Free Wi-Fi is one of the strongest satisfaction-per-euro plays for the business segment.

### Amenities
Amenity kits · bedding tier · pyjamas · noise-cancelling headphones · slippers

### Onboard retail
Duty-free · merchandise · **scratch cards and charity raffles** · onboard auctions

Yes, really — several real carriers sell scratch cards and run raffles. Modelled as a **commercial intensity** dial: high revenue per passenger, small satisfaction penalty that scales with how hard you push it, and a reputation risk if you push it far. It is a legitimate, characterful budget-airline strategy and it should be fully supported without being optimal.

### Ground & pre-flight
Lounge access · fast-track security · chauffeur transfer · dedicated check-in · arrivals lounge · valet baggage

### Atmosphere *(cheap, effective)*
Mood lighting scheme · cabin scent · boarding music · crew greeting style · celebration service · kids' packs · pet in cabin

Atmosphere options cost almost nothing and give small satisfaction gains. **They're the highest-efficiency spend in the catalogue** and reward players who read the detail.

## D.3 Two worked configurations

**Budget short-haul** — A320, 1h15, leisure route

```
Catering            Tier 1, buy-on-board        +€4.20 /pax
Checked bags        paid                        +€9.50
Seat selection      paid                        +€3.80
Scratch cards       medium intensity            +€0.60
IFE                 none (BYOD)                  €0.00
────────────────────────────────────────────────────────
Ancillary revenue                              +€18.10 /pax
Service score                                     0.22
```

**Premium short-haul** — A320, same sector, business-heavy route

```
Catering            Tier 3, hot meal             −€8.40 /pax
Bags & seating      included                     −€13.30 forgone
Wi-Fi + streaming   free                          −€2.10
Atmosphere          lighting, welcome drink       −€0.40
────────────────────────────────────────────────────────
Net service cost                                −€24.20 /pax
Service score                                      0.52
```

A €42/passenger swing between two airlines flying the same aircraft on the same sector. **Which one is correct depends entirely on the route's segment mix** — and that's the decision the game is asking you to make.

## D.4 Does the spend pay back? — the number the UI must show

Service spending only earns its money through the `ProductScore` term in Appendix A. That is fully calculable, so the game should just tell the player.

**Example:** a package costing **€12.40/pax** that raises product score by **+0.18**, on a route with a €101 average fare:

| Segment | Utility gain | Fare premium it supports | Net per passenger |
|---|---|---|---|
| Leisure | +0.144 | €4.86 | **−€7.54** |
| VFR | +0.108 | €4.56 | **−€7.84** |
| Business | +0.396 | €36.48 | **+€24.08** |

**The identical package loses €7.54 a head on leisure and makes €24.08 a head on business.** Not because the service is better or worse, but because of who is sitting in the seat.

The service configurator shows this table live as you toggle options, computed against the actual segment mix of the routes the aircraft flies. It turns service design from a vibe into a decision — and it makes "budget or luxury?" a question with a *correct answer per route*, rather than a personality test.

## D.5 Consistency and reputation

- **Service score feeds reputation (§15) only when consistent.** Sporadic quality scores worse than steady mediocrity, because passengers price in reliability.
- Advertising a product you fail to deliver (Tier 4 catering that runs out) causes a **larger** reputation hit than never offering it. Overpromising is punished specifically.
- Service packages are assigned **per route group**, not per aircraft — so a single airframe flies a leisure config in the morning and a business config in the evening. Realistic, and it keeps the system from becoming per-flight micromanagement.

## D.6 Data model

```
ServiceItem    { id, category, tier, cost_per_pax, revenue_per_pax,
                 score_band[min,max], turnaround_delta, requires[] }
ServicePackage { name, per_class{ items[] }, commercial_intensity }
RouteAssignment{ route_group, package_id }

ProductScore = w_seat·seat + w_service·(band_position(package, execution))
             + w_ife·ife + w_ground·ground
```

Weights differ by cabin class: seat product dominates in business and first, service and price dominate in economy.

---

# Appendix E — Loyalty Programme

**Post-MVP** — a fully configurable frequent-flyer programme, and a genuine second income stream.

In reality this is not a side feature. Several airlines' loyalty programmes have been valued at more than the airline that owns them, and the cash from selling points to banks has kept carriers alive through downturns. It belongs in this game as a real business with real decisions — and, like loans (§13), as one that **leverages the airline without ever replacing it**.

## E.1 The core insight players must discover

**The bank pays for cardholder spending, not for points.**

A co-brand card deal is worth a commission on what members charge to the card. Your earn rate doesn't change that number — it only changes how many points you hand out for the same money. So:

> A generous earn rate does **not** earn you more. It grows your member base and cardholder count, and it grows your liability.

That single asymmetry is the whole design. It makes the programme a balancing act rather than a lever you simply pull.

## E.2 Configurator

Everything below is player-set, per programme.

**Identity** — programme name, currency name (player-chosen: *Skyward Miles*, *Tailfin Points*, whatever), tier names, branding pulled from your brand palette (§15). The currency is part of your airline's identity.

**Earn basis** — the first real strategic fork:

| Basis | Points per | Attracts |
|---|---|---|
| **Distance-based** | Miles flown | Leisure and long-haul bargain hunters. Cheap tickets earn heavily. |
| **Revenue-based** | Money spent | Business travellers. Rewards yield, not distance. |
| **Hybrid** | Distance × fare-class multiplier | Balanced; more complex to explain |

Distance-based programmes build huge member bases of low-yield flyers. Revenue-based programmes build small, extremely valuable ones. **This choice should visibly shape which segment your airline becomes good at.**

**Earn rate** · **tier count (2–6) and thresholds** · **award chart** (fixed points-per-seat, or dynamic pricing once researched) · **award seat inventory %** · **points expiry policy** · **partner earn/burn**

## E.3 Tier perks — configurable per tier

Each perk carries a delivery cost per use, a satisfaction effect, and a stickiness effect (how much it raises `Loyalty` in the Appendix A utility).

Priority boarding · extra checked bag · free seat selection · lounge access (own and partner) · fast-track security · upgrade eligibility · guaranteed award availability · bonus earn multiplier · dedicated support line · companion ticket · status match to poach rivals' elites · soft-landing on tier requalification

**Perk costs scale with member count, and they scale immediately.** Growing the programme grows the cost base before it grows the revenue.

## E.4 The money

**Inflows**

1. **Co-brand card commission** — the big one. Commission on cardholder spend. Requires research (E.6), a reputation threshold, and a hub in a market with a partner bank.
2. **Partner sales** — hotels, car hire, retail chains buying points to give to their own customers
3. **Direct point sales** to members topping up for an award

**Outflows**

Redemption cost (award seats displacing revenue passengers, plus fulfilment) · perk delivery · programme administration · partner acquisition

### Worked example — three ways to run the same programme

Baseline: 250,000 members, 90,000 cardholders, $14,000 average annual card spend, 1.4% commission.

| | **A · Disciplined** | **B · Generous, chart unchanged** | **C · Generous, then devalued** |
|---|---|---|---|
| Earn rate | 1.2 pts/$ | 2.4 pts/$ | 2.4 pts/$ |
| Award chart | 25,000 pts/seat | 25,000 pts/seat | **40,000 pts/seat** |
| Members / cardholders | 250k / 90k | **340k / 130k** | 340k / 130k |
| Card revenue | $18.2M | $26.1M | $26.1M |
| Points issued | 1.96 bn | 4.98 bn | 4.98 bn |
| **Award seats/yr** | 56,506 | **143,424** | 89,640 |
| Redemption cost | $4.6M | $11.6M | $7.3M |
| Perks + admin | $8.6M | $11.7M | $11.7M |
| **Net** | **+$5.1M** | **+$2.8M** | **+$7.1M** |

**Read B carefully — it's the trap.** Being generous grew the member base by 36% and card revenue by 43%, and *still* earned less than the disciplined programme, because 143,000 award seats a year are eating inventory you could have sold.

**C is the escape, and it costs something.** Devaluing the award chart restores the economics — but devaluation is visible to members, hits satisfaction, raises elite churn, and weakens your next bank negotiation. Every real airline has done it; every real airline has been shouted at for it. That ongoing tension between growing the programme and protecting it is the gameplay.

### The liability

Unredeemed points sit on your balance sheet as a **liability**, shown permanently in the finance dashboard (§14). It is the number that punishes over-issuance long after the cash has been spent. Issue freely for a year and you inherit a redemption wave you have to fly.

### The guard — loyalty supports, it never carries

```
Annual partner point sales  ≤  0.6 × trailing passenger revenue
```

Banks won't buy points members can't use. The cap scales the faucet to the airline underneath it, so no one runs a loyalty programme with three aircraft and calls it a business. Same principle as §13.1, same reason.

## E.5 Demand model integration

Each route's segment pool splits into **your members · rivals' members · unaffiliated**. Membership is earned by flying you, and decays with inactivity.

```
Loyalty(i,s) = β_loyal(s) × member_share(i, route) × tier_strength(i)

β_loyal:   Business 1.6  ·  VFR 0.7  ·  Leisure 0.4
```

Business travellers are the most loyal because they rarely pay for their own ticket and personally collect the reward — the reason revenue-based programmes and elite perks are aimed squarely at them. Leisure passengers will abandon you for €12.

The effect is real but bounded: loyalty **shifts** share, it never locks it. A rival who is dramatically cheaper or dramatically better still wins.

## E.6 Research tree — "Programme Development"

Per your brief: nodes cost research points **and** cash, and take **real time** to build. Gated by member count and reputation, not money alone — same ceiling-then-earn pattern as §10.

| Branch | T1 → T4 |
|---|---|
| **Infrastructure** | Member database → tier engine → **dynamic award pricing** → real-time personalisation |
| **Partnerships** | Retail partners → hotel & car hire → **regional co-brand card** → major multi-market card portfolio |
| **Perks & experience** | Priority services → own lounge network → upgrade engine → **guaranteed award availability** → invitation-only tier |
| **Analytics & yield** | Member segmentation → churn prediction → targeted earn promotions → **liability optimisation** |

Sample node:

```
REGIONAL CO-BRAND CARD
  requires:  Member database, Tier engine, 50,000 active members,
             reputation ≥ 0.60, hub in a market with a partner bank
  cost:      2,400 RP  +  $4.2M
  build:     6 real weeks
  unlocks:   card commission income; +18% member acquisition rate
```

The gating matters: **you cannot buy your way to a bank deal.** You have to have flown enough people, well enough, for long enough that a bank wants your members. That keeps loyalty as a mid-game reward for a functioning airline rather than an early-game shortcut past one.

## E.7 Dashboard additions (§14)

Active members and trend · tier distribution · **points issued vs redeemed** · **outstanding liability** · cost per member · revenue per member · card revenue vs redemption cost · award seat displacement as % of inventory · elite churn · member share by route · redemption satisfaction

## E.8 Data model

```
Programme  { name, currency_name, earn_basis, earn_rate, tiers[],
             award_chart, award_inventory_pct, expiry_months, partners[] }
Tier       { name, threshold, perks[], bonus_earn }
Member     { player_airline, tier, balance, lifetime_earn, last_activity }
Liability  { outstanding_points, valuation_per_point, forecast_redemption_curve }
```

---

# Appendix F — Onboarding, Tasks & Retention

**`[MVP]`** — everything else in this document is worthless if nobody reaches it. This appendix covers the first 90 minutes, the objectives that pull players through the first month, and the daily habit loop.

## F.1 What the first 90 minutes must achieve

By minute 90 the player must have:

1. An airline **with a name and a livery they designed themselves**
2. One aircraft, one route, and **a flight they watched land in real time**
3. A repeating schedule, so the airline keeps working after they close the tab
4. A rough grasp of cash runway, and one clear reason to come back tomorrow
5. **The Fleet Expansion Programme open, with a second aircraft visibly close** (F.4)

Not: an understanding of the demand model, cargo, alliances, loyalty, or the academy. **Those must be invisible at minute 1.** Progressive disclosure is the rule — a system appears only when the player has a reason to care about it.

## F.2 The pacing problem, and the trick that solves it

The 2× clock is the game's best feature and its worst tutorial obstacle: **the first flight takes real time and cannot be skipped.**

AMS–LHR in an ATR 72 is a 55-minute block — **27.7 real minutes** of nothing happening, right in the middle of onboarding.

**So make the flight time *be* the tutorial pacing.** While the first aircraft is airborne, the player is invited into the livery builder — the deepest, most enjoyable, least time-pressured system in the game. Twenty-eight minutes is roughly how long a first proper livery takes. The player looks up, and their aeroplane — *wearing the paint they just finished* — is on approach.

That is the single best moment the game has to offer, and it lands in the first hour. **Everything in the onboarding script is arranged to protect it.**

## F.3 The script

| Time | Beat | Teaches |
|---|---|---|
| **0–4** | **Cold open.** No menu. A desk, a name field, a country. "What's your airline called?" | Identity first |
| **4–9** | **Pick your free hub.** Three recommended medium airports, plus full search — flagship airports visibly available with their fee warnings | Hubs, tiers, the cost of ambition |
| **9–15** | **Lease your first aircraft.** One recommended (ATR 72-600), full catalogue browsable. The $500K balance is on screen the whole time | Leasing, cash, aircraft specs |
| **15–20** | **Livery — quick pass.** Base colour, cheatline, tail logo from the composer. Three minutes, deliberately shallow. *"You can come back to this."* | The builder exists, and it's yours |
| **20–25** | **Cabin.** Three presets — dense, standard, comfortable — with the seats-vs-comfort trade shown live | The core cabin trade-off |
| **25–31** | **First route.** Map opens; **reachable airports glow, unreachable ones are visibly greyed with the reason.** Pick LHR. See the demand pool, the competitors, set a fare with a recommendation | Reachability, demand, competition |
| **31–34** | **Crew.** Hire the minimum complement. Duty limits shown, not yet enforced hard | People are a constraint |
| **34–37** | **Ground handling.** Choose a cheap vendor or a good one at both ends — the first genuinely open cost decision | Trade-offs have no right answer |
| **37–40** | **Gate.** Lease one contact gate at your hub. **The 12% utilisation figure is shown deliberately** | Gates are expensive and yours is idle |
| **40–42** | **Departure.** Pushback. The aircraft moves on the map. | The world is live |
| **42–70** | **Airborne — free play.** *"Your aircraft is on its way. Want to finish that livery properly?"* Full builder, no timer. Map browsing, rival airlines, their liveries | The creative hook, at leisure |
| **70–75** | **Arrival.** Flight lands wearing the finished paint. First revenue, first single-flight P&L | Payoff. Money is real |
| **75–83** | **Build the rotation.** Add the return leg and a second round trip. Save it as a **repeating schedule** | The airline works while you're away |
| **83–88** | **The board.** The Fleet Expansion Programme appears, all three chains visible, second aircraft already within reach | A concrete, near-term reason to return |
| **88–90** | **Notifications.** *"Want us to tell you when your aircraft lands?"* Opt-in, honest, no pressure | Retention, consensually |

### Tutorial rules

- **Never a modal wall.** Guidance is a panel that can be dismissed and re-opened.
- **Diegetic voice.** Your Ops Controller talks to you in an ops-bulletin register — the same tone as §18.3. No mascot, no exclamation marks.
- **Cannot fail.** Every onboarding decision is reversible with a full refund inside the first 24 in-game hours.
- **Skippable entirely** for returning or experienced players, straight into a blank airline.
- **No fake time.** The first flight is genuinely 27.7 real minutes. Faking it would teach the wrong game.

## F.4 Objectives — the Fleet Expansion Programme

Framed as an **operations board**, not quests.

The single biggest risk to early retention is the **one-aircraft trap**: a solo turboprop earns roughly $48K a month (§13.4), so self-funding a second lease deposit takes weeks. That is far too long to wait for the moment an airline starts feeling like an airline.

So the first three additional aircraft are **accelerated by objectives**, in three gated chains.

### The mechanism: lessor credits, not cash handouts

Each chain's headline reward is a **Lessor Credit — one lease deposit waived**. This is deliberately *not* fungible cash:

- It can only be spent on an airframe, so it cannot distort the wider economy
- The aircraft arrives **leased**, carrying its full monthly cost from day one
- **The reward creates an obligation.** Free deposits, never free operating costs.

That last point is what makes this safe. A player who rushes to four aircraft and parks them on weak routes now carries ~$340K/month of lease drain and dies faster than if they'd never accelerated at all. The chains are built so each one **teaches the competence needed to sustain the next frame** before granting it.

### Chain 1 — Second Frame · *unlocks the moment your first flight lands*

| Objective | Reward |
|---|---|
| Complete your first revenue flight | $25,000 |
| Fly 6 sectors | $20,000 |
| Achieve 70% load factor on any flight | $25,000 |
| Save a repeating schedule | $20,000 |
| Open a second route | $30,000 |
| **Complete one profitable full day** | **Lessor Credit ×1** |

**Total: $120,000 + a waived deposit.** Reachable on day 1–2. Teaches: schedules, load factor, route selection.

### Chain 2 — Third Frame

| Objective | Reward |
|---|---|
| Carry 1,000 passengers | $30,000 |
| Three consecutive days, zero cancellations | $35,000 |
| Hold 75% load factor across a full day | $30,000 |
| Hire a purser and complete one training course | $25,000 + training slot |
| **Both aircraft above 8 block hours/day for 3 days** | **Lessor Credit ×1** |

**Total: $120,000 + a waived deposit.** Day 3–5. Teaches: reliability, utilisation, crew.

### Chain 3 — Fourth Frame

| Objective | Reward |
|---|---|
| Open a third route | $40,000 |
| OTP ≥ 85% over 7 days | $55,000 |
| Reach reputation 0.50 | $35,000 |
| Contract ground handling at every station you serve | $25,000 |
| **Positive operating profit across a full week** | **Lessor Credit ×1** + one month free gate lease |

**Total: $155,000 + a waived deposit + a free gate month.** Day 6–10. Teaches: OTP, reputation, ground ops, running an actual profit.

### Guards

1. **The programme ends at four aircraft.** The fifth is fully earned, and the board says so from the start — nobody should be waiting for a fourth credit that isn't coming.
2. **One-time per airline, never repeatable**, and not transferable between worlds.
3. **Utilisation warning before the final grant.** If your existing aircraft are below 6 block hours/day, the game says plainly: *"You aren't using the three you have. A fourth will cost you $85,000 a month."* It warns; it doesn't block.
4. **Cash totals stay fixed** — $395,000 across all three chains, one-time. Against a four-aircraft airline turning ~$3.4M/month revenue by day 10 (§13.4 × 4), that's roughly 11% of one month's revenue — meaningful but not economy-breaking, and it's irrelevant within a month.

### Why this is worth the faucet

Unassisted, a player reaches four aircraft somewhere around **week 4–6**. With the programme, **week 1–2** — a 3–4× acceleration through the least interesting stretch of the game, paid for with competence rather than time. And because every frame arrives leased, the acceleration is a *risk the player accepts*, not a gift that removes risk.

Beyond the three expansion chains, the full objectives system — campaigns, mastery tracks, rotating operations, challenges, and the reward economy — is specified in **Appendix G**.

### The rule that keeps this from breaking the economy

**Objective rewards never scale with airline size.**

$55,000 is 11% of your starting bankroll and genuinely changes your week. The same $55,000 against a mature airline's monthly profit is a rounding error. Rewards **decay in relative value automatically**, which means objectives teach and encourage early, then quietly become vanity later — exactly right.

Non-cash rewards do the heavy lifting later: research points, a free training slot, a month's free gate lease, cosmetic decals and fonts, an extra livery save slot.

## F.5 Daily check-in — compounding, capped

The game already wants a daily check-in (§2). Reward the habit that the design needs anyway.

**The Daily Operations Briefing:** what happened overnight, what needs attention, and today's reward.

### Streak multiplier

`×1.08 per consecutive day, capped at ×3.00`

| Day | Multiplier |
|---|---|
| 1 | ×1.00 |
| 3 | ×1.17 |
| 7 | ×1.59 |
| 10 | ×2.00 |
| **15** | **×2.94** |
| 20+ | ×3.00 (capped) |

Two weeks of consistency triples the reward, then it stops. **Compounding that never stops is how these systems become mandatory**, and a mandatory daily login in a game people play around their jobs is a slow way to lose them.

### Streak protection

**Two grace days per rolling 30.** Miss a third and the streak drops by five days rather than resetting to zero.

Consistent with the principle stated in §9.5: the game must never punish people for having lives. A player who plays six days a week forever should reach the cap and stay there.

### What's actually in the reward

Reward composition **shifts with airline age**, and this is the important part:

| Stage | Composition |
|---|---|
| Days 1–30 | Cash-heavy — genuinely useful against a $500K bankroll |
| Days 30–120 | Mixed — research points, training slots, fuel credits, free repaints |
| Beyond | Almost entirely **non-capital**: RP, cosmetic decals and fonts, livery slots, academy slots, a design-history unlock |

Cash floors out rather than growing, so the daily reward never becomes an income stream. In a shared persistent world, **attendance must not be a competitive advantage** — a player logging in daily should be better informed, not better funded.

**The honest framing, stated in the UI:** the real reward for checking in is that your aircraft aren't sitting idle at a gate. The bonus is a nudge, not the reason.

## F.6 The first week

| Day | Intended state | Hook |
|---|---|---|
| 1 | 1 aircraft, 1–2 routes, livery done | "It's still flying." |
| 2 | **Second aircraft** — Chain 1 complete; schedule tuned | First full-day P&L; the airline feels like a fleet |
| 3 | Second route, first competitor encounter | The waterfall chart (App. A.9) |
| 5 | **Third aircraft** — Chain 2 complete | Utilisation and crew depth start to bite |
| 7 | Weekly report, first real profit | Chain 3 in progress; second hub path visible |
| 10 | **Fourth aircraft** — Chain 3 complete, programme ends | Growth is now fully self-funded |
| 14 | Real network, first delay crisis | Crew reserves and OTP matter |
| 30 | Considering a jet | Range gating becomes the goal |

## F.7 Notifications

Opt-in, per category, off by default beyond the first: aircraft landed · route loss-making · cash runway low · crew shortfall · event announced affecting your network · competitor entered your route · maintenance due.

**No guilt mechanics.** No "your airline misses you", no decaying assets designed to punish absence. The world runs whether you watch or not, and that is the promise the whole game is built on — the notifications tell you what happened, they don't threaten you with what will.

## F.8 Metrics that decide whether this works

- % reaching the first departure (target **>75%**)
- % completing 90 minutes (target **>50%**)
- Time to first route, time to second aircraft
- D1 / D7 / D30 retention
- **% of day-1 players who open the livery builder a second time** — the single strongest predictor that the hook has landed

---

# Appendix G — The Objectives System

**`[MVP]` core board / content added continuously** — Appendix F gets a player through their first ten days. This appendix is what keeps them playing for the next six months.

## G.1 Principles

1. **Objectives describe good play; they never replace it.** Every task is something a competent airline manager would do anyway. Completing the board and running a great airline must be the same activity.
2. **No fetch quests, no dailies-for-dailies' sake.** Nothing that exists purely to be repeated. The daily loop is already handled by the check-in (F.5).
3. **Never mandatory.** A player who ignores the board entirely should still be able to win. Objectives accelerate and reward; they don't gate the game.
4. **Targets scale, rewards don't.** "Carry 50,000 passengers" scales with airline size. The $80,000 attached to it does not — so objectives fade in economic relevance exactly as intended (F.4).
5. **Cosmetic rewards are the long-term engine.** Cash stops mattering by month two. A decal pack you can't get any other way never stops mattering.

## G.2 The six layers

| Layer | Count | Cadence | Purpose |
|---|---|---|---|
| **Campaigns** | 8 chains × 8–12 stages | Weeks to months each | The authored spine — themed, narrative, big rewards |
| **Career milestones** | ~60 | One-time, permanent | Prestige. "First widebody." "First million passengers." |
| **Mastery tracks** | 7 systems × 10 tiers | Continuous | Depth per system, for players who specialise |
| **Rotating operations** | 3 active | Weekly refresh | Procedurally parameterised from your live network |
| **Seasonal & event** | Tied to §18 | Per event | Ties the world calendar to personal goals |
| **Challenges** | ~40 | Optional, hard | Prestige and the rarest cosmetics |

### Campaigns — the authored spine

Each is a themed chain with a real objective at the end. Rough scale in real time for a steadily-playing player:

| Campaign | Stages | Duration | Capstone reward |
|---|---|---|---|
| **Wings Out** *(F.4 Fleet Expansion)* | 3 chains | Days 1–10 | 3 lessor credits |
| **The Network** | 10 | ~3 weeks | Research unlock: Turnaround branch T2 |
| **Metal Up** — turboprop to jet | 9 | ~4 weeks | Delivery slot priority + livery template set |
| **The Second Base** | 12 | **~2–3 months** | **Free hub, one time only** |
| **Long Haul** — first intercontinental | 10 | ~6 weeks | ETOPS research unlock + widebody livery templates |
| **The Product** — service & cabin mastery | 8 | ~5 weeks | Premium seat product unlock + cabin material packs |
| **Freight** — belly cargo to freighters | 10 | ~6 weeks | Cargo certification research + freighter livery kit |
| **The Programme** — loyalty from zero | 9 | ~2 months | Co-brand research node discount + brand asset pack |

**Campaigns ship alongside the systems they teach.** *Wings Out*, *The Network* and *Metal Up* are MVP; *Freight*, *The Programme* and the ETOPS capstone of *Long Haul* arrive with cargo, loyalty and tier-3 research respectively. The board never shows a campaign whose systems don't exist yet.

Campaigns run **in parallel**, not in sequence. A player pushes whichever fits their strategy, which is what makes two players' first six months look genuinely different.

### Mastery tracks

Ten tiers each, targets scaling continuously, for players who go deep on one system:

`Network` · `Fleet` · `Crew` · `Service` · `Cargo` · `Design` (livery & cabin) · `Commercial` (pricing, loyalty, alliances)

The **Design track is unique**: its objectives are creative, not operational — *use 12+ layers in one livery* · *design a livery rated 4.5+ by the community* · *paint a full fleet in one consistent scheme* · *win a livery contest*. It's the only track that rewards taste rather than efficiency, and it feeds the best cosmetics in the game.

### Rotating operations

Three at a time, generated from your **actual live network** so they're always relevant:

> *"Raise load factor on AMS–VIE above 78% for 5 days"* · *"Cut turnaround time at CPH below 32 minutes"* · *"Run 14 days with no cancellations at any base"* · *"Convert 6 crew onto the A220"*

Procedural, parameterised from real data, infinitely renewable — and never busywork, because they're pointing at your own weakest numbers.

## G.3 Reward types

| Reward | Scarcity | Notes |
|---|---|---|
| **Cash** | Common | Fixed amounts. Decays in relevance by design. |
| **Research unlock** | Uncommon | Free RP, a discounted node, or an early tier unlock. Saves *weeks*, which is the real currency. |
| **Livery & design items** | Common → Legendary | The long-term engine. See G.4. |
| **Cabin & service items** | Uncommon | Seat fabrics, trim materials, mood lighting presets, tableware sets |
| **Operational perks** | Uncommon | Free gate month, training slots, crew signing bonus, delivery slot priority, a free repaint |
| **Lessor credits** | Rare | Waived lease deposits (F.4) |
| **Hub unlock** | **Once per airline, ever** | See G.5 |
| **Titles & profile** | Cosmetic | Displayed on your public airline profile |

## G.4 Livery & design unlocks — the retention engine

Cash stops mattering. **Creative capability doesn't.** This is the reward category that carries months five through twenty-four.

| Category | Examples |
|---|---|
| **Colour & finish** | Metallic · pearlescent · chrome · matte · satin · two-tone flip · gradient meshes |
| **Shape tools** | Advanced bezier · boolean ops · radial repeat · pattern fills · mirror-across-fuselage |
| **Typography** | Font families, custom kerning, arc-along-fuselage, outlined and shadowed text |
| **Decals & marks** | Themed packs, nose art, flags, heritage marks, anniversary sets |
| **Templates** | Retro scheme sets, era-authentic liveries, cargo schemes, alliance-style layouts |
| **Capacity** | Extra layer slots, extra livery save slots, design version history |
| **Special variants** | Retro-livery slot, special/one-off scheme slot, seasonal scheme slot |
| **Registration styling** | Custom registration fonts and placements |

**Rarity ladder:** Common (early objectives) → Uncommon (mastery tiers) → Rare (campaign capstones) → **Legendary** (challenges and contest wins only).

A legendary decal pack that only exists on aircraft belonging to players who won a livery contest is worth more, socially, than any amount of in-game money. **That's the endgame this game actually has** — not a number going up, but a fleet that visibly says what you've done.

### Reconciling with monetisation (§20)

There's a real tension here and it should be resolved deliberately rather than discovered later:

> **Everything functional in the design tools is earnable through play.** The store sells *convenience* (bulk save slots, extra design history) and *alternate* aesthetic sets — never a strictly better tool, and never the legendary tier.

If the best-looking aircraft in the world can be bought, the design leaderboards become meaningless and the whole creative economy collapses. Legendary items must be unbuyable, and visibly so.

## G.5 The hub unlock — once, ever

The capstone of **The Second Base** (App. G.2), a ~12-stage campaign taking two to three months of steady play. Stages cover network diversity, sustained profitability, crew depth at a second station, reputation, and finally operating a full week from a temporary base.

**Reward: one free hub, tier up to Large.**

Three rules:

1. **Once per airline, permanently.** Not once per season, not once per campaign reset. The board shows it as consumed forever afterwards.
2. **Flagship tier excluded.** A free Dubai or Heathrow would trivialise the single most contested resource in the endgame (App. B.5). Large tier is a real prize — $10M–$80M depending on when you take it — without breaking the flagship economy.
3. **It still counts toward your hub total.** Your next hub is priced as if you'd bought this one. The gift is the money, not an escape from the doubling curve.

Taken at the right moment this is worth tens of millions. Taken early and badly, it's a facility you can't fill — and the campaign deliberately runs long enough that most players will know the difference by the time they finish it.

## G.6 Content budget — where "months" actually comes from

| Layer | Authored units | Effort | Player-hours |
|---|---|---|---|
| Campaigns | 8 × ~10 stages = 80 | High — hand-designed | ~120 h |
| Career milestones | 60 | Low — mostly thresholds | passive |
| Mastery tracks | 7 × 10 = 70 | Medium | ~90 h |
| Rotating operations | 12 templates → infinite | Low, one-time | continuous |
| Seasonal & event | ~6/year | Medium, recurring | ~25 h/yr |
| Challenges | 40 | Medium | ~60 h |

**~250 authored objectives plus procedural rotation** ≈ **six to nine months** for a steady player, and the rotating and seasonal layers never run out after that.

The honest note: campaigns are the expensive part and the part players remember. Rotating objectives are cheap and infinite but nobody's loyalty is won by them. **Budget the authoring effort accordingly** — one great campaign beats fifty generated tasks.

## G.7 The board

Filter by layer, reward type, or effort · pin three to track on the main dashboard · **progress updates live from the sim** — no claiming, no collecting · completed objectives archive into a career history on your public profile · clear "consumed forever" marking on one-time rewards.

**One anti-pattern to avoid explicitly:** no objective should ever reward *bad* airline management. No "cancel 5 flights", no "fly a route at a loss". Every single task must be something a good operator would want to do anyway — that's principle 1, and it's the difference between an objectives system that teaches the game and one that fights it.

---

# Appendix H — Visual Design & Art Direction

**`[MVP]`** — how the game looks, and the single biggest presentation decision in it: **the world is 3D, and the player chooses whether to see it that way.**

## H.1 Design position

Modern, restrained, information-dense. The reference points are contemporary operations software — flight-tracking tools, dispatch displays, financial terminals — not the saturated cartoon language of most management games.

The reason is the audience. People who care about airlines care about *instruments*. The interface should feel like professional equipment that happens to be beautiful, and the colour should come from **the player's own liveries**, not from the chrome around them.

> **The rule the whole art direction hangs on:** the UI is neutral so the aircraft aren't. Your brand is the only loud thing on screen.

## H.2 The world — flat or globe, player's choice

One world, one dataset, two projections. **Switchable at any moment**, with an animated transition, and remembered per device.

| | **Flat map** | **3D globe** |
|---|---|---|
| Projection | Equirectangular / web Mercator | True sphere |
| Best for | Dense networks, planning, comparison, mobile | Long-haul, immersion, watching, screenshots |
| Great circles | Curved, wrap at the antimeridian | Naturally correct |
| Performance | Cheapest | Higher; auto-degrades |
| Default | **Mobile and low-power devices** | **Desktop first run** |

**Why both, rather than picking one.** A globe is the honest representation — great circles are straight lines on it, polar routings finally make sense, and the day/night terminator sweeping across it is the single best expression of a world that never stops. But a globe is *bad at planning*: half your network is behind the horizon, and comparing twelve European routes on a sphere is worse than on a flat map.

So: **globe to watch, flat to work.** Both must be first-class, and neither may hide information the other shows.

### Shared behaviour

Same camera grammar (drag, pinch/scroll zoom, double-tap focus), same layer toggles, same selection model, same tooltips. Zoom is continuous through four bands: **world → region → terminal area → airport map** (App. B.7), where the airport view is always a stylised 2D schematic regardless of projection — an apron is a floor plan, not a landscape.

### The globe specifically

- Subtle atmospheric limb, terminator with soft twilight band, city lights on the night side
- Land treated as flat cartography with elevation only hinted — this is a network map on a sphere, **not a terrain flight simulator**
- Cloud layer from the weather system, off by default
- Auto-rotate to follow a selected aircraft; "fly to" easing between airports
- Graceful degradation: reduced atmosphere, fewer route lines, sprite-only aircraft on weak hardware, and an automatic offer to switch to flat if frame rate stays low

## H.3 Live routes — the signature view

Route lines are the thing that makes a network *look* like a network, and they carry real information.

| Encoding | Meaning |
|---|---|
| **Colour** | Whose it is — your brand colour, alliance colour, rivals in neutral grey |
| **Thickness** | Weekly frequency |
| **Opacity** | Load factor — busy routes glow, weak ones fade |
| **Animation** | A slow directional shimmer along the line, in the direction of travel |
| **Dashed** | Seasonal or suspended |
| **Red pulse** | Disrupted — closure, cancellation, event |

**Layers, independently toggleable:** my network · alliance · rivals · all traffic · profitability heat · demand heat · slot pressure · cargo lanes (separate colour ramp, since cargo lanes are directional and belong on their own layer).

At world zoom, thousands of lines become an unreadable hairball, so: **aggregate below a threshold.** Bundle by corridor, fade minor routes, and keep individual lines only for the selected airline. Zooming in un-bundles them.

**Aircraft** are top-down livery sprites — your actual paint, rendered server-side from the livery document (§5, §21 open question 1) and cached. At high zoom they resolve to the full top-down template; at low zoom they simplify to a coloured mark carrying the livery's dominant colour. **Watching your own scheme move across the globe is the payoff for the livery builder**, and it must survive at every zoom level.

## H.4 Interface system

**Layout** — persistent left rail (world, fleet, network, finance, crew, design, board), a context panel on the right that never covers the world, and a bottom status strip: cash, cash runway, aircraft airborne, alerts. The world is always visible behind the UI; panels are translucent and dismissible.

**Type** — one modern grotesque for the interface, a tabular monospace for figures so columns align and numbers don't jitter as they tick. Aviation data is read in columns; it must behave like it.

**Colour** — a near-neutral base (deep slate in dark, warm off-white in light), one accent for interactive elements, and a fixed semantic set for status: on-time, delayed, cancelled, profitable, loss-making. **Status colour is always paired with a shape or label**, never carried by hue alone.

**Charts** — one consistent visual language across every dashboard (§14), light and dark, benchmarked and drillable. Every chart is an entry point, not a picture.

**Motion** — purposeful only. Aircraft move continuously because they're actually moving. Numbers tick when they change. Everything else is a 150–200 ms ease. No decorative animation anywhere; in a game people leave open for hours, motion is a cost.

**Both themes are first-class.** Dark is the default — this is a screen people leave open.

## H.5 The three creative surfaces

The livery builder, cabin builder and airport map are where the art direction earns its keep. All three follow the same rule: **the tool disappears, the object doesn't.**

- **Livery builder** — full-bleed aircraft on a neutral backdrop, tools in a collapsible rail, no chrome touching the aircraft. Instant preview across the family and a one-click "on the ramp at your hub" render, because that render is what gets shared.
- **Cabin builder** — clean architectural floorplan, seats as precise geometry, live constraint readouts that highlight in place rather than in a dialog.
- **Airport map** — stylised 2D schematic, topologically accurate, geometrically simplified. Your gates in your brand colour, rivals in neutral, live turnaround progress rings.

## H.6 Mobile

Mobile is a first-class client, not a cut-down one — the check-in session (§2) mostly happens there.

- **Full parity:** world (flat by default), all dashboards, schedules, fares, board, alerts, digest
- **Adapted:** livery and cabin builders — usable for viewing, colour changes, applying a saved scheme, and light edits, with the deep vector tooling honestly signposted as better on a large screen. Pretending otherwise would make the onboarding hook (App. F.2) fail on the device most players first arrive on.
- Thumb-reachable primary actions, bottom sheets rather than modals, and the flat map as default

## H.7 Accessibility

Not a late pass. WCAG AA contrast throughout · full keyboard navigation · screen-reader labels on every data element (the dashboards are tables underneath, which helps) · respects reduced-motion, including stilling the route shimmer · text scaling to 200% without breaking layout · colour-blind-safe palettes with shape redundancy · **the flat map itself is an accessibility feature**, since the globe is harder to parse for some players.

## H.8 Audio

Restrained and functional. Ambient ops-room tone, distinct alert sounds by severity, a satisfying confirmation on departure and arrival, subtle feedback in the builders. **Everything independently mutable, and the game must be completely playable silent** — most sessions will be.

## H.9 Technical approach

- **Globe and map:** WebGL, one renderer with two projection modes so layer code is written once
- **Aircraft sprites:** server-rendered from livery JSON, cached per airframe at three zoom resolutions
- **Route lines:** instanced geometry with GPU-side bundling
- **UI:** DOM/CSS over the canvas — accessible, themeable, and cheap
- **Budget:** 60 fps desktop at world zoom with 5,000 visible aircraft; 30 fps mobile flat map. Aggregation thresholds are tuned to hold these, not hoped at.
