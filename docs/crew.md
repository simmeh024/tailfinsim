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

## What the legality check does not know

Nothing about **duty, rest or positioning**. §9.2 calls those the flagship crew mechanic and
they are not M5-01, so the question answered is narrower: does the airline hold enough crew, at
the right ranks, rated on this aeroplane's family, to staff its longest leg. An airline that
passes can still be building a rotation no real crew could fly. The field is named `crewLegal`
rather than `crewExists` precisely so that duty limits tighten it rather than needing a second
one.

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
things. It is never cropped — `object-fit: cover` ate the first letter of every line and
rendered _"ommand the aircraft"_ — so the height follows each image's own aspect ratio and moves
a little between ranks. And the `alt` carries the rank and its one-line description, because
text inside a picture is text a screen reader cannot reach.

The nine supplied PNGs were 1.82 MB together; re-encoded to webp at two widths they are
**229 KB**, matching the fleet assets' convention. They are separate emitted files, so a visit
downloads one banner rather than nine. `crewBanner` is a `Record<CrewRank, …>`, so adding a rank
without artwork is a type error rather than a broken image nobody notices.

## Not built yet

Duty, rest and fatigue (§9.2 calls them the flagship crew mechanic), positioning and
hotelling, reserve crew, morale, and the service-quality link into §6.4 are all described in
§9.2 and are **not** M5-01. M5-01 is the model they will all need: bases, pools, ranks, type
ratings and the legal complement.
