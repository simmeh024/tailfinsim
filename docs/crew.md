# Crew

Design doc §9.2. Built by [M5-01](https://github.com/simmeh024/tailfinsim/issues/50).

This is the contract for the crew subsystem: what it models, what it deliberately does not, and
where the boundaries are. It grows as the milestone lands; the model came first because
everything else is a way of storing or showing it.

---

## Pools, never people

**There is no crew member row.** A pool is a _number of heads at a rank, rated on a family, at a
base_, and that is the acceptance criterion rather than an implementation shortcut:

> The player interacts with pool sizes and policies, never with individual rosters.

The issue is blunt about why: _"if they have to hand-roster 400 flight attendants, the feature
has failed."_ The cheapest way never to build hand-rostering is to have nothing to roster.

Individual hours, proficiency and XP are **M9**, explicitly out of scope here. Nothing in
`packages/sim/src/crew` should grow a person.

## The two ladders

|             |                                                                           |
| ----------- | ------------------------------------------------------------------------- |
| Flight deck | Cadet → First Officer → Senior First Officer → Captain → Training Captain |
| Cabin       | Cabin Crew → Senior Cabin Crew → Purser → Cabin Service Manager           |

A required rank is a **floor, not an exact demand**: a Training Captain may fly as a Captain, a
Senior First Officer as a First Officer. `coversRank` is the single place that decides it, so a
rule change lands in one function rather than in every caller that compares two ranks. The one
thing it never allows is cover _across_ ladders — a Captain does not serve the cabin, whatever
the seniority indices happen to be.

## A complement is computed from seats fitted

```
cabin crew   = max(minimum, ceil(seatsFitted / seatsPerCabinCrew))
flight deck  = 2, doubled to two full sets at or beyond reliefCrewFromBlockMinutes
```

`seatsPerCabinCrew` is **50**, and it is quoted rather than authored: ICAO Annex 6 and EASA
CAT.OP.MPA.170 both require one attendant per fifty passenger seats _installed_. §9.2 says
cabin crew are "scaled to seat count by regulation", and this is the regulation.

Two consequences worth stating, because both are load-bearing:

- **Seats fitted, not seats sold.** A flight carrying nine passengers on a 180-seat aeroplane
  still carries four cabin crew. `requiredComplement` takes no passenger count at all, which is
  the strongest available form of that guarantee — the rule cannot accidentally start reading
  one.
- **Densifying a cabin costs crew.** §7.2's high-density configuration earns more fares _and_
  buys a crew member at every fiftieth seat. That is the trade, and it should stay visible.

Relief crew are a second **set** — another Captain _and_ another First Officer — not one extra
pilot. Relief crew have to be able to operate the aeroplane while the operating crew rest.

The cabin's leaders are counted **within** the requirement, not added on top: a 300-seat cabin
needs six, one of whom is the Cabin Service Manager and one the Purser. Adding them on top
would put eight down the back, and the regulation does not say that.

## Fragmentation is arithmetic, not a penalty

There is **no commonality malus coefficient**, and there should not be one. A crew member rated
on the A320neo family simply is not in the 737 MAX pool, so an airline flying both needs two
sets of Captains to cover the same departures. The shortfall falls out of the counting.
Inventing a multiplier on top would charge twice for one effect and hide where it came from.

`fragmentation()` exists only to **show** what the arithmetic already did, because §9.2's
complaint is that a mixed fleet _"quietly wrecks your utilisation"_ — and quiet is the part an
interface has to fix. `strandedHeads` is the crew that cannot be pooled: not wasted, since they
fly their own aeroplanes, but not available to the largest family either.

## Filling a complement takes the juniormost adequate head

`checkComplement` is greedy from the most junior rank that covers the slot upward. Reaching for
the Training Captain first would leave a Captain idle and report a shortfall of Training
Captains on the next flight that wanted one — a shortage the arithmetic invented rather than
found.

It reports **every** unmet rank rather than the first. "Hire two Captains and a Purser" is an
answer; "hire a Captain", three times in a row as the player fixes them one at a time, is not.

## Balance lives in the economy config

`crew` is a section of `EconomyConfig`, **defaulted** — for the reason `SHIPPED_NPC_BALANCE`
records, a required new section makes every payload written before it unparseable, and a world
pinned to that version cannot price a flight or found an airline. `packages/sim` holds no crew
literal; `DEFAULT_CREW` is a slice of the shipped payload and `balance-source.test.ts` asserts
it by identity, not by value.

The regulation numbers are real. Everything else — salaries, hiring and conversion costs, base
overheads — is authored, because §9.2 is prose and App. A has no crew table. They are anchored
on the shape of the mechanic: a Captain costs several times a new cabin crew member, a
conversion costs a fortnight of availability, and a base overhead punishes opening one per
destination.

## Where it plugs in

`validateRotation` has carried a `crewLegal` input since M2-07, with a comment saying crew
legality is M5's to fill. That seam is now filled from the other side: **`createSchedule`
computes it from the airline's real pools** when the caller does not assert it.

The check lives beside `airframeUnavailability` and for the same reason — the pools are rows,
and the rotation rules are pure — but it is reported as `crew_illegal`, a `RotationProblem`,
because to the player that is exactly what it is: the schedule cannot run, for a reason about
the crew rather than the aeroplane.

Two details worth knowing:

- **The longest leg decides.** Relief crew are a function of block time, so a rotation's
  requirement is set by its longest sector. Checking each leg separately would ask the same
  question repeatedly and answer it most permissively on the shortest.
- **`crewLegal: true` is an assertion, and skips the read.** It exists for callers that have
  already answered the question, and for the fleet and maintenance suites, whose airlines were
  never going to have crew pools and which are not about crew. Leaving it undefined — what
  production does — means the database decides.

The refusal names the ranks and the numbers, which is the whole reason `checkComplement`
reports every shortfall rather than the first: _"short 1 captain, 1 first officer"_ is
actionable in one reading.

### An airline with no crew cannot schedule

That is the intended consequence, not an oversight. A new airline must open a base and hire
before it can put a flight on the books, which is §9.2's structure arriving as a gate rather
than as a page of numbers.

Note that **nothing departs yet**: `FLIGHT_DEPART` has no handler (SCALE-05), so the moment a
flight comes into existence is `createSchedule`, and that is where the acceptance criterion's
"before departure" can honestly be enforced today. There is also no HTTP scheduling API yet, so
in production this rule currently guards a path only tests reach — it is ready for the API
rather than waiting on it.

## What the complement check does not know

Nothing about **duty, rest or positioning**. The question it answers is narrow: does the
airline hold enough crew, at the right ranks, rated on this aeroplane's family, to staff its
longest leg. An airline that passes can still be building a rotation no real crew could fly —
and M5-02 is what says so. The field is named `crewLegal` rather than `crewExists` precisely so
that duty limits tighten it rather than needing a second one.

---

# Duty, rest and fatigue (M5-02)

§9.2's flagship crew mechanic. The complement check above asks _do these crew exist_; this asks
_may they legally fly_, and they stay separate checks because the answers mean different things
to the player — one is a hiring problem and the other is a rostering one.

## Three verdicts, and why two is not enough

`legal` · `tight` · `illegal`.

M5-02 asks for legality _"checked at schedule-save time as a warning and at departure as a hard
rule"_, and a boolean can express neither half of that. The middle verdict is the mechanic: a
rotation with forty minutes of slack is legal, flyable, and one weather delay from cancelling,
and a player who is not told that meets the mechanic for the first time as a cancellation with
no explanation attached.

- **At schedule-save**: a warning. `SaveResult.warning` carries the severity, the leg and a
  sentence. It never refuses — airlines roster to the line, and a game that quietly declined to
  let the player do it would remove the decision rather than model it.
- **At departure**: absolute. `dispatchCrew` refuses, and the flight delays or cancels.

## The rules, and where the numbers come from

EASA ORO.FTL, quoted rather than authored for the same reason `seatsPerCabinCrew` is 50: flight
time limitations are public, they are what every European operator actually rosters against,
and a player who knows the real rule should find the game agrees with them.

| Rule                                    | Shipped value                                     | Source              |
| --------------------------------------- | ------------------------------------------------- | ------------------- |
| Max flight duty period, 1–2 sectors     | 13h00                                             | ORO.FTL.205 Table 2 |
| Reduction per sector beyond the second  | −30 min, floor 9h00                               | same table          |
| Window of circadian low                 | 02:00–05:59 **local**, −2h00                      | ORO.FTL.105         |
| Minimum rest at base / away             | 12h00 / 10h00, never less than the preceding duty | ORO.FTL.235         |
| Cumulative duty, 7 / 14 / 28 days       | 60h / 110h / 190h                                 | ORO.FTL.210         |
| Block time, 28 days                     | 100h                                              | ORO.FTL.210         |
| "Approaching" the limit                 | 60 min                                            | this game's         |
| Timeout delay before cancelling instead | 180 min                                           | this game's         |

They live in `EconomyConfig.crew.duty`, not in `packages/sim` — M3-11's rule has no exception
for numbers that came from a regulator, and duty limits are exactly the dial a world would
retune. The section is **defaulted**, because a required new section makes every payload
written before it unparseable.

The one liberty taken is _shape_: the real maximum-FDP table is a grid of start time against
sector count, and this is that grid as a base, a per-sector reduction and a floor. It
reproduces the 06:00–13:29 row exactly and approximates the early-start rows through one
reduction rather than six.

## The documented failure case

§9.2 describes one specific failure and `duty.test.ts` builds exactly it — four tight sectors
out of Schiphol, then a 90-minute weather delay on leg two:

|                      | as planned        | delayed                 |
| -------------------- | ----------------- | ----------------------- |
| duty periods         | 1                 | 1                       |
| sectors              | 4                 | 4                       |
| FDP ceiling          | 12h00             | 12h00                   |
| flight duty at leg 4 | 11h15             | **12h45**               |
| leg 4                | `tight`, 45m left | **`illegal`, 45m over** |
| legs 1–3             | legal             | legal                   |

Nothing random and nothing fitted. The ceiling does not move — the same four sectors, the same
06:00 report — while the day gets longer underneath it. And the aeroplane flies three of its
four sectors and strands itself at the fourth, which is what makes the mechanic instructive
rather than punitive: a model that failed the whole rotation would teach the player nothing
about _where_ the plan broke.

## A duty period is a row, and still nobody has a name

M5-01's invariant survives. The regulation does not constrain _people_ either — it constrains
**a duty**, which is a span of time with a report and an off-duty and some flying in the
middle. So `crew_duty_period` is that span: one crew set, one airframe, a head count and a rank
breakdown drawn from the pools as counts and returned as counts.

It hangs off the **airframe**, because that is what physically carries the crew from one sector
to the next. A period stays open across turnarounds, is extended sector by sector, and ends
either when the crew time out or when nothing was dispatched before they could have gone home.

`crew_pool` grew two columns to match:

- `on_duty` — inside a period, or serving the rest after one. Separate from `unavailable`
  because a crew member in a classroom is gone for a fortnight and one who is resting is back
  tonight, and those are different answers to the player's question.
- `reserve` — a **designation, not a separate pool**. Reserves are ordinary crew held back from
  the roster; they draw the same salary and can cover anything the rest of the pool could.

## What happens when the crew run out

In order: a **reserve set** if the airline is paying for one; a **delay** if the rested crew
are back within `crewTimeoutMaxDelayMinutes`; a **cancellation** otherwise, because a crew that
needs eleven hours is not a delay.

All three record `crew_timeout` in `flight.disruption_cause` — a column M2-08 needed and never
had. It modelled `DisruptionCause` in `packages/sim` and `flight` stored only the outcome, so
until M5-02 the reason was computed and thrown away.

## `FLIGHT_DEPART` finally has a handler

It has been queued since M2 and parked as `unsupported` ever since. M5-02 needed a departure to
be hard at, so `flight/depart.ts` is a **dispatch gate**: it asks whether the aeroplane may push
back, and if it may, releases it to the `FLIGHT_ARRIVE` handler that has existed since M2-06.

It deliberately does not board, push back, taxi or tick phases — §21 computes flight state on
read — and it does not roll for weather or technical failure. A departure gate that also
decides the weather is two mechanisms in one place.

A delayed flight is retried by scheduling a **second** `FLIGHT_DEPART`, keyed by the instant it
is due. Reusing `departureKey` would make the retry a silent no-op and the flight would sit
delayed for ever with nothing scheduled to look at it again.

## Duty is also a worker story, with the sharpest edge yet

Two sweeps run per world per tick, on the world's **game** clock: `standDownIdleCrew` ends the
day for a set nothing dispatched, and `returnRestedCrew` puts the heads back once the rest is
served. `crewStoodDown`, `crewRested` and `crewErrors` are the counters.

**Production has no worker.** So on a production world every aeroplane would fly exactly one
duty period and then stop for ever, with its crew permanently `on_duty` and the pool unable to
staff anything else. That is not a subtle degradation — it is a fleet that flies once. It reads
as a broken game rather than a missing process, which is the same trap as `ticks: 0, errors: 0`.

Both sweeps are scoped to one world. They were not, in the first draft: called from inside the
per-world loop while querying globally, they would each run once per world over the same rows
and measure one world's rest against another world's clock.

## Conversions finish on the worker, or not at all

A conversion completes on the worker's tick, against the world's **game** clock — a fortnight
of training is a span in the world's calendar, so a world at 4× returns its crew twice as fast
in real time as one at 2×. §7.2's real weeks on factory deliveries are the one deliberate
exception in the fleet; training is not one.

**Production has no worker.** A production world would therefore put crew into a conversion and
never take them out: visibly `unavailable` on the Crew page, counted against the airline, and
never coming back. That reads as a broken feature rather than a missing process, which is the
same trap as `ticks: 0, errors: 0` and as the used market's empty inventory.
`crewConversionsCompleted` and `crewErrors` are the counters that tell the two apart.

The sweep is idempotent: it claims each row with an `in_training` filter before touching a
pool, so a re-run or a second worker racing a handover completes nothing twice.

## Fleet cover: what the crew are measured against

The page needs a denominator, and M5-01 has exactly one honest candidate: for every airframe
the airline owns, the legal complement for its seat count on a **short sector**, summed by
family and rank.

It is a **floor**, and every surface that shows it says so. A single aeroplane flying a day of
rotations needs several crews; working out how many is duty and rest, which §9.2 defers. A
number that quietly pretended to be a rostering answer would be worse than no number at all.

Two details:

- **A short sector deliberately.** Relief crew depend on block time, so a long one would inflate
  the floor with a requirement most flights do not have.
- **Airline-wide, not per base.** There is no positioning model, so demand cannot be attributed
  to a base without inventing §9.2's hotelling and deadheading.

`metRequired` is `sum(min(available, required))` **per row**, never total against total. Crew
are not fungible: a surplus of A320neo cabin crew does nothing for a shortage of 737 MAX
captains, and dividing the totals let the readiness ring read _100% covered_ directly above the
words "not enough crew to launch your whole fleet". That was seen in a sandbox, not caught by a
test, and there is now a test.

## The page

`/crew`. Two of the acceptance criteria are visible there rather than in the server, and the
page is built around them.

**Fragmentation leads.** §9.2's complaint is that a mixed fleet _"quietly wrecks your
utilisation"_, so the quiet is the bug: the cost of commonality is the first thing on the page,
in numbers — _"Of 7 available crew, the largest family can call on 4 — 3 cannot fly it"_ —
rather than something a player infers by adding two tables together. It also says, in as many
words, that this is **not a penalty**, because a figure that reads as a fine invites "how do I
avoid the fine?" when the answer is "fly one family".

**Crew in training are shown, not netted off.** `On strength`, `In training` and `Available`
are three columns. Subtracting the middle one would hide the entire point of a conversion
taking a fortnight.

**Nothing on the page is a person.** Every column is a count, a rank or a family, and
`CrewPage.test.tsx` asserts exactly that list of headers plus the absence of any rendered
identifier. The guard is on the _columns_ rather than on the prose — an earlier version grepped
the page for the word "roster" and failed on the page's own copy, which correctly says a
conversion costs fourteen days off the roster.

Every figure is the server's. `available` arrives computed rather than subtracted in the
browser, because the rule for what counts as available is the server's and duty and rest will
make it more than "not in a classroom" — and `packages/web` may not import `@tailfin/sim` at
all (§21).

**Families are a picker, never free text.** The first version had a text box, and a pool rated
on a family literally called `test` is still sitting in the dev database because of it. A
rating that matches no aeroplane can never be used and no amount of money can undo it, so the
world's catalogue families travel with the crew payload.

**Cash carries no currency symbol.** The currency is unnamed until M8-02 and every other
surface shows it bare; a `$` here would be inventing the answer to an open question.

### The three action cards

Fields, then what it costs, then the button — in that order in the DOM, which is both the
better reading order and the only arrangement that lines the three buttons up. The cards hold
different numbers of fields, so the button is pinned to the foot with `margin-top: auto` and
nothing sits below it to push it back.

The form is a **flex column** for that reason. A grid does not work: an auto margin on a grid
item resolves inside its own row rather than against the whole form, and the buttons stayed at
three different heights.

Controls follow `.founding__field` — a small-caps eyebrow label over a bordered control, and an
accent-filled primary button — rather than a second set of form styles invented for this page.
The controls reset `font`, `letter-spacing` and `text-transform`, because otherwise they
inherit the label's eyebrow styling and render their values in small caps.

### The rank banner

One image per rank, and it follows the rank picker. It sits **below** the four figures: the
numbers are what somebody came for, and a picture above them pushes the answer under the fold. It is the only place the page shows a
person, and that is allowed: it illustrates the rank being hired, not a member of staff who
exists.

The artwork carries its own headline and body copy **baked into the pixels**, which decides two
things. It is never cropped — `object-fit: cover` ate the first letter of every line and rendered
_"ommand the aircraft"_ — and the `alt` carries the rank and its one-line description, because
text inside a picture is text a screen reader cannot reach.

**The v2 set is 2048 × 409 for all nine ranks**, so the box is exactly the artwork's shape and
nothing is letterboxed. The first set was not: 880 wide and between 126 and 217 tall, nine
different ratios in one slot, which forced the box to the tallest and left eight of the nine
sitting in a band of empty surface — the alternative being a page that jumped on every rotation.
`object-fit: contain` survives from that compromise on purpose, as the guarantee that a future
set which does not fit is letterboxed rather than cropped.

`CREW_BANNER_ASPECT` is the single place the ratio is written down, and a test asserts the
stylesheet agrees with it. Artwork and box drifting apart is the kind of thing nobody notices
until a rotation looks wrong, by which point the cause is three files from the symptom.

The nine supplied PNGs are 8.7 MB together; re-encoded to webp at quality 82 and two widths
(1024 for a 1× display, 2048 for a 2×) the whole set is **890 KB**. They are separate emitted
files, so a visit downloads one banner plus one warmed for the next rotation, never nine.
Quality 82 rather than lower because text is what webp gives up first, and lettering gone soft
is the one artefact a reader will notice.

`crewBanner` is a `Record<CrewRank, …>`, so adding a rank without artwork is a type error rather
than a broken image nobody notices.

## Payday, and why reserves are a decision

§9.2 says reserve crew _"cost money and do nothing most days — until they save your on-time
performance. Deliberately a hard call."_ Both halves are needed, and the second is not
dressing: a standby crew that is free is not a hard call, it is an obvious one.

So crew are billed monthly, on the world's game clock, by the worker:

| cause                | what it pays for                                       |
| -------------------- | ------------------------------------------------------ |
| `crew_payroll`       | every head on strength, at its rank's salary           |
| `crew_base_overhead` | each open base, whether or not anybody is posted there |
| `crew_positioning`   | hotels for a crew set that stopped away from base      |

Two movements rather than one, because _"why did I pay this"_ has two answers — the people and
the buildings — and §14.1 forbids a figure a player cannot interrogate.

A **reserve costs exactly what a line crew member costs**, because a reserve is a designation
and not a separate pool. Designating one changes the roster and not the bill, which is the
whole trade.

### Idempotent by reference, with no bookkeeping table

The reference is `<cause>:<airlineId>:<YYYY-MM>` in the world's own calendar, and AIR-06
already refuses a second movement with the same cause and reference. So payroll is attempted on
**every tick** and bills once, and no "last billed" column exists — which matters more than it
saves, because ADR-0005 would require resetting such a column on a world reset and forgetting
would leave a fresh world believing it had already paid. It also self-heals: the month just
ended is retried for as long as the next month lasts.

### Insolvency is not modelled, and payroll can cause it

Every other spend in the game is player-initiated and refuses when the money is not there.
Payroll cannot refuse — the crew worked — so **an airline that cannot make payroll goes
negative, and nothing yet acts on that**. §11's bankruptcy is not built. The gap is deliberate
and the alternative is worse: payroll that silently skipped would make "run out of money" the
cheapest strategy in the game.

---

# Morale, pay bands and attrition (M5-03)

§9.2's wellbeing layer, and its whole promise is one sentence: _"cost-cutting on
crew is a viable strategy with a delayed, visible bill."_ Three words, three
requirements that pull against each other.

## Viable

Paying badly has to save real money, or it is a trap with a warning sign rather
than a decision. Each base carries a **pay band** and a **hotel tier**, and both
multiply real bills:

| policy                                   | cost                         | morale             |
| ---------------------------------------- | ---------------------------- | ------------------ |
| pay `lean` / `market` / `generous`       | ×0.85 / ×1 / ×1.2 payroll    | 0.25 / 0.65 / 1.00 |
| hotels `budget` / `standard` / `premium` | ×0.6 / ×1 / ×1.8 positioning | 0.20 / 0.65 / 1.00 |

A well-run base on lean pay still scores 0.63 — liveable. A pay band that floored
morale by itself would make the other three inputs decorative.

**Bands, not a slider.** A continuous multiplier invites hunting for the exact
figure that buys the most morale per unit of cash, which is homework rather than
a choice.

## Delayed

Morale is a **stored state that eases toward a target**, not a formula over the
inputs. That gap is the mechanic.

| after     | gap closed |
| --------- | ---------- |
| 1 week    | 12%        |
| 5.4 weeks | 50%        |
| 13 weeks  | 81%        |

At the flagship world's 2× clock the half-life is under three real weeks: long
enough to bank the saving and stop thinking about it, short enough that the
player is still recognisably the person who made the decision.

Drift compounds, so two half-weeks equal one week — a tick that ran twice as
often must not sour a base twice as fast.

## Visible

The four factors are itemised on the Crew page, each with a bar and a sentence,
and the weighted values **sum to the target exactly**. A mood the player cannot
argue with is a bug: a base losing crew with nothing explaining why reads as the
game being arbitrary, and a player who concludes that stops making the decision.

## The four inputs

Two are chosen and two are measured, both from the duty periods M5-02 writes,
over 28 days of game time.

- **Pay band** and **hotel tier** — the player's.
- **Roster stability** — the spread of _report times_. There is no roster object
  and this does not pretend there is. Circular mean, because 23:00 and 01:00 are
  two hours apart and a night operation is not the least stable thing in the game.
- **Rest ratio** — rest hours against **duty** hours. Not rest served against
  rest required, which is structurally 1: the dispatcher refuses to grant short
  rest in the first place, so that reading could never be anything else. This
  measures wear, not compliance — a base flying thirteen-hour days on twelve-hour
  rests scores badly even though every rest was legal.

Both measurements return **neutral, not zero**, with no duty periods to judge. A
base that has not flown yet has not mistreated anybody.

## What the bill is

**Attrition** removes heads permanently; **sickness** takes them out for a few
game days. Both deterministic — rate × headcount — because §14.1 forbids a figure
a player cannot interrogate, and _"why did I lose two captains"_ is much harder
to argue with when the answer is a die.

`crew_pool.sick` is a fourth bucket beside training, duty and standby, because
the fixes differ: a classroom is a fortnight and you wait, a duty is a night, and
sickness is a _symptom_ whose fix is upstream of the roster entirely.

## `crew_base.morale` is nullable, and that is load-bearing

**Null means never reviewed**, not zero. A base opened a minute ago reads as the
economy config's `startingMorale`; a base reading 0 has been run into the ground.

Defaulting it in the schema would also have put a balance literal in a migration,
unmovable by a retune. Same shape as `airframe.maintenance_state`, and the same
warning: do not tidy it into a zero.

## Worker, and the usual edge

`reviewCrewMorale` runs per world per tick and skips a base reviewed inside the
week — the tick calls it every second and the review _rolls the bill_, so without
that guard a week of attrition would land sixty times a minute. It claims its row
on `morale_reviewed_at`, so two workers racing produce one winner.

**Production has no worker**, so there morale would sit at its starting value for
ever: no drift, no sickness, no attrition, and the delayed bill would never
arrive. `moraleReviews`, `crewResignations` and `crewSickened` are the counters.

## Service execution is exposed, not consumed

`serviceExecution(morale)` returns the multiplier §9.2 promises as an input to
the product score — and **nothing multiplies it into anything**. App. D.1's rule
that _the weakest input dominates_ is a decision about four inputs together and
belongs to M8-04, which is open. Consuming it here would be taking M8-04's
decision for it.

Industrial action is explicitly out of scope.

## Not built yet

**Morale** and the **service-quality link** into §6.4 are described in §9.2 and are not built.

**Deadheading is modelled and not billed.** `positioningFor` reports the deadhead seats a
displaced crew needs and `deadheadCostPerHeadMinor` prices them; only the hotel half is
charged, because nothing yet _puts_ crew on a flight as passengers. Hotels are the cost §9.2
names and the one a player creates by accident.

## The page shows it

The pool table gained two columns and the page gained a board:

- **On duty** is separate from **In training**, because the two have different fixes. A crew
  member in a classroom is gone for a fortnight and you wait; one who is resting is back
  tonight, and you hire or you keep a reserve. One column would make them look like one problem.
- **Standby** is the reserve designation, set from the fourth action card. A level, not a
  change — two tabs both sending "+2" would produce four reserves and neither screen could
  explain it, so `PUT /api/crew/reserves` takes the number the player wants.
- **On duty**, the board, answers _where are my crew_, which before M5-02 the game could not
  answer at all. Still no person on it: a row is a **set**, a head count on one aeroplane.
  A set stopped away from base is marked `hotel` in words rather than in colour (App. H.7).
