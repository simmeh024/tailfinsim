# The training academy

§10's progression layer starts with a building. This document is the current contract for
M9-01 — the facility, its five levels, the modules inside it, what construction costs and how
it changes what an airline may train — including the parts of §10.1 deliberately **not** built
and why.

Design reference: `docs/tailfin-design-doc.md` §10.1. Where this document and the design doc
disagree about current behaviour, this one describes what the code does.

---

## The rule everything else hangs off

> **Academy level gates the ceiling. It does not grant the boost.**

§10 states it twice and CLAUDE.md repeats it, because it is what makes §10 a progression
system rather than a shop. Levelling the facility unlocks _which tiers of boost are
researchable at all_; the research tree is M9-05 and the boosts are M9-06, and neither is
reachable by paying for a building.

Nothing in `packages/sim/src/academy` returns a multiplier, a coefficient or a percentage.
A level yields three things and all three are permissions: a **rank ceiling**, a **research
tier ceiling** and a **slot count**. `levels.test.ts` asserts that structurally — it reads the
level definitions and fails if any numeric field appears beyond `level` and `researchTier`, so
a future `fuelBurnBonus` fails the build rather than a review.

---

## Where it is built, and the design-doc conflict that had to be settled

§10.1 opens: _"Built at a crew base. One academy per base; a base without one can only hire
pre-qualified crew at market rates."_ M9-01's issue repeats it. §21's facility list says
instead that a training academy is _"unlocked per hub"_, and **M7-04 built that** — a
`hub_facility` row with kind `training_academy`, an opening cost of 0.40 × the hub tier base
and an annual fee of 0.06 × it.

The two statements disagree. This follows **§10.1**: the section M9-01 cites, and the specific
one. The `hub_facility` row is untouched and **gates nothing here** — making it a prerequisite
would invent a rule neither section states and would deny an academy to every airline whose
crew base is not at a hub. The conflict is recorded on the issue rather than resolved silently.

One academy per crew base, enforced by `academy_crew_base_key` rather than by a check the
writer performs.

---

## The ladder

| Lvl | Name                   | Flight deck up to    | Cabin up to           | Research tier | Slots |
| --- | ---------------------- | -------------------- | --------------------- | ------------- | ----- |
| 1   | Training Room          | —                    | Cabin Crew            | 1             | 4     |
| 2   | Training Centre        | First Officer        | Senior Cabin Crew     | 1             | 10    |
| 3   | Flight Academy         | Senior First Officer | Purser                | 2             | 20    |
| 4   | Full-Flight Sim Centre | Captain              | Cabin Service Manager | 3             | 36    |
| 5   | Centre of Excellence   | Training Captain     | Cabin Service Manager | 4             | 60    |

Two rank ceilings rather than one, because §10.1's _"Trainable up to"_ column carries both
ladders in the same cell — level 2 reads _"Senior Cabin Crew, FO"_. Folding them into a single
rank would mean picking one ladder's progression and inventing the other's.

Two cells needed a decision, and both are reasoned in `packages/shared/src/academy.ts`:

- **No flight deck at level 1.** _"Basic CBT, induction"_ is not where a first officer is made.
- **Cabin Service Manager at level 4.** §10.1's column stops at Purser and never names the top
  cabin rank; level 4 is where widebodies arrive, and `cabinServiceManagerFromSeats` is 250, so
  the level that unlocks widebody types is the level that trains the crew they legally require.
  Anywhere else and a player could buy a widebody they were forbidden to crew.

`cadet` is never a ceiling. §10.1 puts the cadet programme at level 5, which is a _source_ of
cadets rather than a rank you convert someone up to; that is M9-04's.

**Level 0 is a building site, not a level.** A row is written when the player commissions level
1, with `level = 0` and `pending_level = 1`. Nothing is permitted at 0 — not a rank, not a
research tier, not a slot — so there is no state in which the money has been taken and the
capability has arrived early.

The table is **design** and lives in `@tailfin/shared`'s `ACADEMY_LEVELS`. The prices, weeks,
upkeep and slot counts are **balance** and live in `EconomyConfig.academy`, pinned per world.
That is the same split §22.3 and §22.5 draw between a fare change and an aerodynamics change:
moving Captain from level 4 to level 3 is a redesign, making a Flight Academy dearer is a
retune, and a `cash_movement` can always say which of the two explained its amount.

---

## Which clock construction runs on

**The world's** — and §10.1 says _"real weeks"_, so this needs saying plainly.

[ADR-0026](adr/0026-in-world-spans-are-game-time.md) names academy construction among the
unbuilt spans it settles:

> unless a span is genuinely a real-world quantity in the way an exchange rate is, it is
> measured on the world's clock, and the burden is on the exception to argue for itself.

A building at a crew base, staffed and teaching this world's crew, cannot make that argument.
TIME-01's finding about factory orders applies unchanged: a wall clock here would make a world
at 4× specifically and only worse at building academies, while every other span it waits
through ran four times as fast.

**The acceptance criterion that sentence exists to serve is kept in full, and kept
structurally.** _"Build time cannot be shortened with money"_ holds because **no lever
exists**: no rush cost, no balance multiplier, no endpoint, no field a payment could reach.
`buildCompletesAt(gameStartedAt, weeks)` takes two arguments and there is nowhere to put a
third. The rule is held by absence rather than by a check somebody could later relax.

So `academy.construction_started_at`, `academy.construction_ready_at`,
`academy_module.started_at`, `ready_at` and `installed_at` are all **game** instants, like
`crew_conversion.completes_at`. `created_at` stays real, like every `created_at`. One clock per
table, so there is never a question about which a column is in.

---

## What it costs

| Level | Capital | Build (game weeks) | Monthly upkeep |
| ----- | ------- | ------------------ | -------------- |
| 1     | $20K    | 4                  | $1.5K          |
| 2     | $50K    | 8                  | $3.5K          |
| 3     | $140K   | 16                 | $8K            |
| 4     | $400K   | 28                 | $20K           |
| 5     | $1.1M   | 40                 | $45K           |

Scaled against three numbers already in the economy: a crew base costs $30K to open and $5K a
month, a narrowbody A-check is $18K, and an outsourced conversion is $2K a head. A Training
Room is about two-thirds of the base it stands on — a decision rather than a formality — and
level 5's upkeep is a few A-checks a month, an unmistakable drain on a small airline and a
rounding error on a large one. That is §10.1's _"a level 5 academy at a base with 12 aircraft
is a money pit; at a 90-aircraft hub it's the best investment in the game"_ made into numbers.

A founding airline holds $500K, so it can afford a Training Room on day one and cannot reach
level 4 without having earned it. That is intentional and the database tests fund an airline
through a movement rather than lowering the price.

Capital is charged when construction **starts**, as one `academy_construction` movement
referenced `<academyId>:level:<n>` or `<moduleId>:module`. Upkeep is `academy_upkeep`. Both
carry the `crew` ledger category — an academy is a crew cost, and §14.1's rule is that a figure
must be _interrogable_ rather than that every cause needs a category of its own; the `cause`
separates them when a player asks which.

---

## Modules

| Module                       | From level | Capital | Build | Upkeep | Read today |
| ---------------------------- | ---------- | ------- | ----- | ------ | ---------- |
| CBT Suite                    | 1          | $6K     | 2     | $400   | **yes**    |
| Cabin Service Mock-up        | 1          | $24K    | 6     | $1.2K  | **yes**    |
| Emergency & Wet Drill        | 2          | $32K    | 8     | $1.8K  | no         |
| Fixed-Base Sim               | 3          | $90K    | 12    | $4.5K  | **yes**    |
| Full-Flight Sim (per family) | 4          | $300K   | 20    | $12K   | **yes**    |
| Ground Ops Bay               | 2          | $40K    | 10    | $2K    | no         |
| Dispatch & Performance Lab   | 3          | $50K    | 10    | $2.5K  | no         |

_"Modules determine **what** you can train; academy level determines **how far**."_

`from level` is drawn from §10.1's own _"Unlocks"_ column — fixed-base sims at level 3,
full-motion at level 4 — so a module cannot be bought ahead of the building that houses it.

**The full-flight sim is the only per-family module**, because a simulator is one aeroplane's
cockpit and the rest are rooms. Uniqueness is two _partial_ indexes rather than one constraint:
NULLs are distinct to a unique index, so a single `(academy_id, kind, family)` unique would
happily allow six CBT suites.

**Three modules are priced, buildable and inert**, and the interface says so — `readToday` is a
field on the wire, not a comment. Emergency drill is recurrent safety training, the ground ops
bay is §9.3's self-handling school and the dispatch lab is §14's performance work, and each
belongs to a milestone that is not this one. Building one costs real money for a capability
that does not exist yet, so a player has to be able to find that out before paying. A test pins
the set, so a later milestone that wires one up and forgets the flag fails rather than going on
telling players it does nothing.

---

## What the academy actually changes today: conversion

§10.1 states one module effect outright:

> _"A Full-Flight Sim for a family you own converts crew in-house at a fraction of the cost of
> outsourcing."_

Read carefully, that says the academy makes conversion **cheaper**, not **possible** — and
§10.1's other half says the same from the other side: _"a base without one can only hire
pre-qualified crew at market rates"_ is a price, not a refusal.

So **the academy is a discount and a ceiling, never a gate.** `POST /api/crew/conversions` is
unchanged in shape and a base with no academy converts crew exactly as M5-01 shipped it, at
`crew.conversion.costPerHeadMinor`. This reading is deliberate and it is the conservative one:
making the academy a gate would silently strip a capability from every airline in every
existing world on the deploy that shipped it — the release before it would keep working against
the schema and stop working against the game, which is the failure the expand rule exists to
prevent, arrived at through behaviour instead of DDL.

A course is trained in-house when **all** of these hold, and is bought in at the market rate
otherwise:

1. the base has an academy, commissioned to level ≥ 1;
2. the level permits the rank;
3. a **CBT Suite** is operational — §10.1 puts CBT at level 1 as the first thing an academy is
   for, and a building without it has no curriculum;
4. the ladder module for the crew's line is operational — a **Full-Flight Sim for the target
   family** (best rate) or a **Fixed-Base Sim** for the flight deck, a **Cabin Service Mock-up**
   for the cabin;
5. there are enough free training slots for the whole course.

| Provider                        | Rate vs. outsourcing |
| ------------------------------- | -------------------- |
| Full-Flight Sim (target family) | 0.25                 |
| Fixed-Base Sim                  | 0.55                 |
| Cabin Service Mock-up           | 0.45                 |

A full-flight sim for _another_ family teaches nothing about this one, so the family is matched
rather than the kind alone — fleet commonality pays a second time inside the academy.

The refusal reason is a closed set (`no_academy`, `not_commissioned`, `rank_above_ceiling`,
`no_cbt_suite`, `no_module`, `slots_full`), because the interface has to put it beside the
control that would fix it and _build a CBT suite_ and _wait for a slot_ are different buttons.
The slot check runs **last** on purpose, so an academy that could never teach this course says
so rather than sending somebody away to wait for nothing.

---

## Training slots

_"Each academy has finite training slots. Crew in training are unavailable to fly."_

Slots hold **crew, not courses**: a conversion of ten heads occupies ten of them. The ledger is
a query, not a counter — `sum(heads)` over the `in_training` rows whose `academy_id` is this
academy. That is deliberate: a counter column would have to be reset on a world reset
(ADR-0005), and forgetting would leave a fresh world believing its academy was full. It is the
same argument the used market makes for having no "last generated" column.

`crew_conversion.academy_id` therefore carries one fact and not two: a course is in-house
exactly when an academy carried it. A boolean beside it could disagree. **Null on every row
written before M9-01**, which reads correctly as what those courses were — bought in, because
there were no academies.

A course is never **split** between in-house and bought-in places. Four free slots and a course
of six sends all six to the market, at one price: splitting would put two prices on one
`crew_conversion` row and give the player a number they could check against neither rate.

The availability half of §10.1's tension is M5-01's and unchanged — heads in a classroom sit in
`crew_pool.unavailable` and cannot be rostered, whichever way the course was bought.

---

## This is a worker story

Two sweeps, both per world on the world's game clock, in the tick beside the hub fee:

- `completeDueAcademyBuilds` commissions levels and installs modules whose build is due.
- `runAcademyUpkeep` bills the month that has closed.

Builds are commissioned **before** upkeep is billed, and the order matters: a level
commissioned this tick should be charged from the month it opened, and billing first would give
it a free month. The reverse costs nothing, because upkeep bills the month that has _closed_.

**Production has no worker** ([OPS-12](https://github.com/simmeh024/tailfinsim/issues/191)), so
on a production world an academy is charged its capital, **never finishes, never teaches and
never charges rent**. A permanent building site — which reads as a slow build rather than as a
missing process, the same trap as the empty used market and the fleet page that never moves.
`academyBuildsCompleted`, `academyUpkeepPaid`, `academyUpkeepMinor` and `academyErrors` are the
counters, and the pair matters: builds finishing with no upkeep ever billed is a world whose
academies all opened this month, while both at zero on a world that has founded one is a worker
that is not running.

Upkeep is idempotent by `academy_upkeep:<airlineId>:<YYYY-MM>` — AIR-06's replay identity, the
pattern `runCrewPayroll` established. It is attempted every tick and bills once, needs no "last
billed" column, and self-heals across a month boundary the worker was down for. The
already-billed references are read first, because AIR-06's guard asserts a replay carries the
**same facts** and an academy commissioned mid-month changes the amount between two ticks.

`foldAcademyUpkeep` and `academyUpkeepLines` are exported so M8-08's cash runway projects the
same bill the sweep charges, rather than keeping a second copy of the arithmetic that would
drift the first time a level was commissioned.

---

## The API

| Route                             | What it does                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/academies`              | Every academy, every site without one, the families, and what each next build costs |
| `POST /api/academies`             | Found one at a crew base and start level 1                                          |
| `POST /api/academies/:id/levels`  | Start the next level                                                                |
| `POST /api/academies/:id/modules` | Build a module                                                                      |

Owner-scoped by resolution and never by a check afterwards: the airline comes from the session,
no handler accepts an `airlineId`, and every query is scoped by it. Another player's academy is
not in the result set, so operating on one is not a state a request can express — a foreign,
absent or malformed id all receive the identical `404 academy_absent` (ADR-0020). Refusals that
describe known state are `409` with a code from the closed `AcademyRefusal` set.

Each mutation returns the **whole** state, for the reason the crew endpoints do: founding an
academy or starting a build changes cash, the ceiling and what may be built next at once, and a
client that had to refetch would show a stale purse for a frame.

---

## What M9-01 deliberately did not build

- **The research tree.** `researchTier` is a ceiling the response carries and nothing reads.
  M9-05 owns the tree; M9-01 exists to make the ceiling real without it.
- **Any boost.** M9-06.
- **Selling sim slots to other players.** §10.1 marks it post-MVP; MARKET-01 owns the contract
  primitive it would need.
- **A web page.** The API is complete and there is no client consumer yet. CLAUDE.md's own
  warning applies — a closed issue is not evidence a player can reach a feature — so this is
  named here rather than assumed. SURFACE-01 owns making that a CI gate.
- **Demolition or downgrade.** §10.1 gives a capital cost, a duration and an upkeep and no way
  back, the same as `hub_facility`. A `closed_at` nobody can reach would be a mechanic sitting
  in the schema looking load-bearing.
- **Crew promotion.** The rank ceiling says what an academy _may_ train; nothing yet promotes a
  head from First Officer to Captain. That is M9-02's XP and M9-03's skill trees, and the
  ceiling is what they will read.
