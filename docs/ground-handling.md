# Ground handling (M5-06)

§9.3's ground layer: at every airport a service line is walk-up, contracted to a vendor, or
handled by the airline's own people. A vendor trades on five numbers —
_price · reliability · speed · quality · capacity_ — and this document covers what each of
them does, what a contract costs to sign and to break, and the two operational facts that are
invisible in the diff.

Built as six sequential pull requests. The first five gave the section its behaviour; the
sixth gave it its **money**, which is what turned the trade from a description into a decision.

---

## The trade did not exist until price did

For five PRs a grade changed a turn's speed and its reliability and **not its cost**. The
settlement charged `groundHandlingPerTurnMinor + seats × groundHandlingPerSeatMinor` whatever
the airline had signed, so the budget handler was slower and clumsier for exactly the same
money. It was strictly worse. Nobody would ever have signed one, and §9.3's central sentence —
_"cheap ramp handlers = slower turns and more mishandled bags"_ — described a cost with no
saving attached.

`handlingPriceFactor` is the multiplier that fixes it, and the five ways to get an aeroplane
away now price in this order:

| arrangement     | turn price | reliability         | why anyone picks it                    |
| --------------- | ---------- | ------------------- | -------------------------------------- |
| your own people | 0.15×      | staffing-dependent  | fixed monthly cost instead of per turn |
| budget vendor   | 0.70×      | 0.85                | cheapest way to hold a contract        |
| standard vendor | 1.00×      | 0.95                | the reference                          |
| **walk-up**     | 1.35×      | 0.85 (budget-grade) | nothing — this is the state you escape |
| premium vendor  | 1.50×      | 0.99                | best service in the market             |

Two rows carry the design. **Walk-up is dearer than standard**, which is what makes signing
anything worth doing — and a budget contract nearly halves it while _matching_ walk-up's
reliability, so the cheap handler is a real choice rather than a trap. **Premium is dearer than
walk-up**: it is not a discount for committing, it is the best service in the market and costs
the most of anything a vendor sells.

The price scales the **ramp and baggage** turn. That is the line the shipped cost table
describes and the line the disruption roll already reads. The other five service lines are
contracted and modelled and have no priced consumer yet — the same state `quality` is in, and
stated here rather than hidden.

### Speed reaches the plan, not the settlement

`turnaroundResolver` prices each station a rotation lands at when the schedule is authored, so
§9.3's _"cheap ramp handlers = slower turns"_ shows up as a longer
`schedule_leg.turnaround_minutes` and pushes every later departure in the rotation out. The turn
happens where the aeroplane **lands**, so it is the destination's handler that decides it.

It is fixed at authoring time, which is what that column already is: the plan crew legality is
checked against and the plan the player is reading. Signing a better handler does not
retroactively shorten a rotation written before it — re-saving does. Resolving it at
materialisation instead would make a saved rotation's timings move underneath the player
without them touching it, which is a larger decision than this.

The other inputs `computeTurnaround` takes are still stand-ins, and deliberately: a contact
stand (there is no gate allocation to ask), no congestion (§3.3 is unmodelled), no §10.4 boosts,
and a **zero seat term** — `DEFAULT_TURNAROUND_MINUTES` is quoted at no published reference
cabin, so comparing a real seat count against it would be inventing a balance number rather
than wiring one. §7.1's per-type turnaround baseline is where that changes.

### Where the numbers live

Split by CONTRIBUTING invariant 3, and the split is the same one `ground/vendor.ts` has stated
since PR1:

- **`packages/sim`** owns what a grade _is_ — reliability, speed, quality, the relative
  `priceIndex`, the term length, the warning window, and what self-handling achieves at a given
  staffing. Balance of the same kind as the turnaround and disruption models.
- **`EconomyConfig.ground`** owns the **money** — the walk-up premium, the break fee, the
  volume commitment, the shortfall fee, the ramp salary and the self-handled turn rate.
  Retunable through the admin API and an audited re-pin, and defaulted so every `v1` payload
  written before it still parses.

`priceIndex` is the one number that crosses, and it crosses as a multiplier rather than as an
amount.

---

## A contract has a term, a commitment and a break fee

Signing fixes four things and stores all four, so the contract is judged at the end against
what was **agreed** rather than against whatever the economy says by then:

| column              | meaning                                                 |
| ------------------- | ------------------------------------------------------- |
| `term_start`        | game time the term began                                |
| `term_end`          | game time it ends — the worker lapses the contract here |
| `volume_commitment` | departures the term commits to (grade × term length)    |
| `penalty_minor`     | what breaking the **whole** term would cost             |

### `term_start` is not `signed_at`

`signed_at` defaults to `now()` and is therefore **wall clock**; `term_end` is the world's own
calendar. Pro-rating anything across a term needs both ends on the same clock, and mixing them
made a 90-day term look decades long. Hence a separate column. A row with `term_start` null was
signed before terms were priced: it still lapses at its `term_end`, and it costs nothing to
leave and nothing at expiry, because nobody agreed anything with it.

### Breaking one early

§9.3: _"Breaking one early costs a penalty."_ The stored full-term figure, pro-rated to the
part of the term **not served** — so leaving on the last day is nearly free and leaving on the
first costs the lot. Two things about it are deliberate:

- **A grade switch pays it too.** Switching _is_ breaking a contract early, and if it were free
  nobody would ever terminate: sign premium, switch to budget, walk away owing nothing. Taking
  a line back off a vendor onto your own people pays it as well, for the same reason.
- **It is refused when the airline cannot pay.** Every other player-initiated spend in the game
  refuses rather than going negative, and so does this. An airline with no cash is locked into
  its handler — a consequence of being broke rather than an inconsistency.

### The volume commitment

A budget handler asks for nothing; it will take anyone's bags and has no reputation to protect.
A premium handler at a scarce slot wants the volume that justifies holding the slot for you —
two departures a day in the shipped balance — which is what makes signing premium at a station
you barely serve the mistake it should be.

The shortfall is billed **at the end of the term**, on departures committed and not flown, and
counts only flights that actually left the stand: a cancelled or never-dispatched flight was
never handled, so crediting it would pay the airline for work the vendor did not do. An early
exit pays a **pro-rated** shortfall alongside the penalty, which closes the obvious dodge —
sign premium, fly nothing, terminate the day before the term ends and owe nothing at all.

Unlike the penalty, the shortfall **cannot be refused**: the vendor held the capacity and is
owed for holding it, so an airline that cannot pay goes negative. That is the same position
crew payroll takes and for the same reason — a bill that silently skips would make "sign
premium everywhere and never fly" free.

Because a shortfall lands when nothing can be done about it, `GET /api/ground/contracts` carries
a **live** figure that falls as the airline flies. That is the more expensive of the two alerts
§9.3 asks for.

---

## Self-handling needs a station and a headcount

§9.3: _"self-handling as an alternative requiring a station and headcount"_. Both halves are
enforced.

The **station** is a hub. An airline that has not bought its way into an airport has no ground
operation there to staff, and App. B.5 doubles the price of every hub you already own — so a
network of self-handled outstations is not something a player can quietly accumulate.

The **headcount** is what makes it a decision rather than an upgrade. A station needs
`requiredHeadcountByTier` heads to be handled properly; the ratio of heads employed to heads
needed interpolates between two profiles:

- fully staffed lands **just short of a premium contractor** — a specialist runs ramps for a
  living and you do not, so the reason to self-handle is the cost curve, never a better number
  than money can buy;
- unstaffed lands **well below budget**, which is what makes understaffing a decision with a
  consequence rather than a free saving.

Over-hiring buys nothing: the ratio is capped at 1. §10.4's rule that an edge must be one a
smarter plan can beat applies to the ramp too.

### The requirement is the station's, not the schedule's

A ground operation at a flagship needs shifts, equipment drivers and a duty manager whatever
you fly through it, and the turnaround windows, gate procedures and de-icing season belong to
the airport rather than to you. Scaling the requirement to the airline's own departure count is
the obvious next refinement and is deliberately **not** this milestone's: it would move every
time a schedule was edited, and the player would be re-staffing rather than deciding.

### The trade is fixed cost against per-turn cost

Payroll does not shrink when the schedule does. In the shipped balance a fully staffed large
station is 28 heads at $1,500 a month — $42,000 — against $735 a turn from a standard vendor for
a 180-seat narrowbody. So self-handling starts paying at about **two departures a day** and is a
bad trade below one. That crossover _is_ the mechanic, and it is the number to retune if it
lands in the wrong place.

Understaffing saves money on the payroll and **not** on the turn: the per-turn rate is flat.
Folding staffing into it would pay a player twice for one cut, and the consequence of the cut is
supposed to be a worse handler rather than a cheaper one.

### The bill accrues; it is not a monthly snapshot

`billed_through_at` on each operation is how far its payroll has been settled, and the accrual
is closed at three moments: the **month boundary**, so the ordinary bill still arrives monthly;
**whenever the headcount changes**; and **when the operation closes**, so a station used for
half a month pays for half a month.

The middle one is the load-bearing one. The first version billed the previous month against
whoever was on the books when the sweep happened to run, and staffing is free and instant to
change - so running 40 heads all month, dropping to 1 on the last day and restaffing afterwards
billed **one head for the whole month**, repeatably and with no operational downtime. That made
self-handling free, and a free ground operation is not a trade against a vendor: it is strictly
better than one at every station. Making the reduction itself settle the period the larger staff
worked is what closes it.

Crew payroll reads the headcount at billing time and is safe doing so only because hiring costs
money per head and is capped by `weeklyHiringCapacity`. Ground handling has neither guard, which
is why it needs the watermark.

A monthly salary accrues at `salary / (365/12)` a day, so a year comes to exactly twelve
salaries - a flat 30-day month would quietly charge 12.17 of them, and real month lengths would
make February cheaper than March for no reason a player could act on.

### It is a separate table, and that was a rollback decision

A self-handled line has **no vendor grade**. Putting one in `ground_contract` would have meant
either a null in a column the previous release reads as non-null — breaking its
`/api/ground/:icao` response for exactly the airlines that had adopted the feature — or storing
a grade that is a lie. CLAUDE.md's expand rule is that the previous release keeps working
against the result, and a table it has never heard of satisfies that completely.

The cost is that exclusivity now spans two tables, and no constraint can say _"a vendor and your
own people may not both work this line"_. Every writer therefore takes
`pg_advisory_xact_lock(hashtext(world:icao:line))` and closes the other kind inside it. That lock
is deliberately coarser than the `world:icao:line:grade` key it replaced — a line-level lock
still serialises everyone contending for any grade's last slot, so the capacity limit stays
exact, and it is the only key both writers can agree on.

---

## What the Worker owns, and what production therefore does not have

Two of the three money paths are the Worker's, and **production has no worker**. Both failures
read as generosity rather than as a missing process, which is the trap CLAUDE.md records about
every other M4/M5 mechanic.

| sweep                   | clock                  | without a worker                                                                                                       |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `expireGroundContracts` | the world's game time  | a term never ends: the slot never frees, and no shortfall is ever billed                                               |
| `runGroundPayroll`      | the world's game month | the accrual never closes at a month boundary, so self-handling is **free** but for what a restaff or a closure settles |

The payroll one is the sharper of the two: an unbilled ground operation beats every vendor at
every station, so a production world would have a dominant strategy rather than a trade.

The counters that tell those apart from a quiet world:

- `groundContractsExpired` — the sweep is running;
- `groundVolumeShortfalls` / `groundVolumeShortfallMinor` — the commitment is _biting_. A world
  with terms lapsing and no shortfalls is one where every airline flew what it promised, which
  is a real and different state from one where nothing is being measured;
- `groundPayrollBilled` — heads are being paid. Zero on every tick but the first of a game
  month, and zero for ever without a worker;
- `groundErrors` — a sweep that threw.

The early-termination penalty, by contrast, is **not** a worker story: it is charged in the
request that breaks the contract, so it works on every node.

---

## The API

| route                                  | does                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| `GET /api/ground/contracts`            | every arrangement, with expiry and live shortfall alerts  |
| `GET /api/ground/:icao`                | one station's vendors, its self-handling offer, and yours |
| `POST /api/ground/:icao/contracts`     | sign a grade — breaks whatever was working the line       |
| `POST /api/ground/:icao/self-handling` | open, or restaff, an operation of your own                |
| `DELETE /api/ground/contracts/:id`     | break a vendor contract early, paying for it              |
| `DELETE /api/ground/self-handling/:id` | close an operation of your own — no penalty, no term      |

Owner-scoped throughout: the airline is resolved from the session and never accepted from the
client, and a cross-owner id receives the endpoint's identical 404 (ADR-0020). Every write needs
`requireActiveAirline`, because each one either commits the airline to a term or moves its cash.

---

## What is not built

**No web UI.** All six PRs were server and sim. The station view carries everything a page would
need — all five vendor numbers, the self-handling offer with its reason and required headcount,
the live penalty and shortfall — and nothing renders it yet.

**Catering is not tiered per cabin class.** §9.3 calls it _"a first-class choice"_ that links
into the cabin builder, and the `catering` service line exists as a contract with no priced or
rated consumer. That is a cabin-builder change more than a ground one.

**Self-handling is not a service you sell to other players**, and vendor
relationship/reputation, exclusive contracts and seasonal de-icing crises are all explicitly
post-MVP in §9.3.

**A negotiated fuel supplier discount** against the `fuelling` line is not modelled; see
[`fuel-pricing.md`](fuel-pricing.md) for why the station's own price is deliberately kept
separate from what an airline manages to knock off it.
