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

## Not built yet

Duty, rest and fatigue (§9.2 calls them the flagship crew mechanic), positioning and
hotelling, reserve crew, morale, and the service-quality link into §6.4 are all described in
§9.2 and are **not** M5-01. M5-01 is the model they will all need: bases, pools, ranks, type
ratings and the legal complement.
