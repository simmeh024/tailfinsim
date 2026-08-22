# ADR-0005: Separate a world's epoch from its launch date, so it can be reset

- **Status:** Accepted
- **Date:** 2026-08-17
- **Amended:** 2026-08-22 — clarified that the current clock is derived while domain records
  may persist game-time instants; the original wording predated `world_event.fire_at`.
- **Deciders:** @simmeh024
- **Constrains:** M0-06 (core schema), M1-05 (world clock), M1-09 (world creation), M11-02 (admin world management)

## Context

The flagship world's in-game calendar starts at **20 October 2024** and advances at 2×
wall-clock (design doc §3.1b):

```
InGameDate = Epoch + speed × (real time elapsed since world launch)
```

Dev and production share a codebase and will both run worlds. Dev's world will be started,
advanced, broken and restarted many times before launch. Production's world must open at
exactly the epoch, with no accumulated drift from testing — and it must be possible to
reset it back to the epoch on the day we go live, cleanly.

The obvious-but-wrong model is a single `current_date` column advanced by the tick loop.
That makes "reset to the epoch" a data migration, makes the clock a mutable value two
processes can disagree about, and makes a missed tick permanently lose in-game time.

## Decision

A world stores **two** timestamps, and never a current date:

| Column             | Meaning                                                                           | Mutable?                                 |
| ------------------ | --------------------------------------------------------------------------------- | ---------------------------------------- |
| `epoch`            | Where the in-game calendar begins — `2024-10-20T00:00:00Z` for the flagship world | No, once players exist                   |
| `launched_at`      | The real instant the clock started running                                        | Only by an admin reset                   |
| `speed_multiplier` | 2 for the flagship world                                                          | Gated behind the two-person rule (§22.2) |

In-game time is then **derived, never stored**:

```
inGameDate(world, now) = world.epoch + world.speed_multiplier × (now − world.launched_at)
```

This is already the shape of `inGameDate()` in `packages/sim`, and it stays a pure function
of its inputs — which is invariant 2 in CONTRIBUTING.md, and what M13-01's replay harness
depends on.

**An admin reset is therefore:** set `launched_at = now()`, leave `epoch` alone, and truncate
world state. The calendar returns to 20 October 2024 by definition rather than by
recalculation. No arithmetic, nothing to get wrong, and no possibility of a partially-reset
clock.

### The go-live reset

Production is reset immediately before launch: `launched_at = now()`, world state cleared,
epoch untouched. Any testing done on the production world before that point is erased by
the same operation that starts the real one.

### Guard rails

Reset is destructive, so per §22.1 and §22.7 it requires:

- `WorldAdmin` role or above;
- the **two-person rule** — one admin requests, another approves — on any world with a
  status of `open`;
- a mandatory reason recorded in the immutable audit log;
- an automatic pre-reset backup (`deploy/backup.sh`) whose success is a precondition, not a
  nicety;
- refusal outright if the world has any player who is not flagged as a test account, unless
  explicitly force-confirmed.

That last one exists because the reset that matters is the one nobody meant to run.

## Consequences

### What this makes easier

- Reset is a two-column update, not a migration.
- Offline progression is free: the clock is computed on read, so a server that was down for
  an hour returns to the correct in-game time rather than having lost an hour of ticks.
- The tick loop becomes responsible only for _events_ (arrivals, maintenance due, slot
  expiry) rather than for advancing time. §21 already asks for exactly this.
- Historical-era worlds (§22.2 presets) are the same code with a different `epoch`.

### What this makes harder

- Every in-game timestamp must be computed through the world, so no code may reach for
  `Date.now()` and call it game time. Lint already forbids `Date.now()` inside
  `packages/sim`; server code needs review discipline.
- `speed_multiplier` changing mid-world retroactively rewrites the calendar, since elapsed
  real time is multiplied by whatever the current value is. §22.2 already gates this behind
  a loud warning; the honest fix if it is ever really needed is a piecewise segment table,
  which is deliberately **not** built now. (M1A-03 built the change itself — see the
  addendum below for what it does and does not fix.)

### What we accept

That the world's **current** in-game time is never a mutable stored clock column. Domain
records may and do persist game-time instants such as `world_event.fire_at` and scheduled
flight timestamps; reports query those facts directly. A report that starts from a real-time
observation must convert through the world's clock mapping, in exchange for a current clock
that cannot drift while the server is offline.

## Alternatives considered

| Option                                                    | Why not                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A stored `current_in_game_date` advanced by the tick loop | Reset becomes a migration; a missed tick loses in-game time permanently; two processes can disagree about what time it is. |
| Reset by moving `epoch` forward                           | Conflates "where the calendar starts" with "when this run began", and breaks era presets.                                  |
| Delete and recreate the world                             | Loses the world's identity, config version and audit history. §22.2 requires archived worlds stay browsable forever.       |

## Addendum, 2026-08-18: changing the speed of a running world (M1A-03)

The "revisit when" below arrived, and this records what was built rather than leaving the
decision as it was written.

**What was built.** A speed change re-anchors `launch_date` so that the in-game date at the
instant of the change is unchanged:

```
launch_date′ = now − (inGameDate(world, now) − epoch) / new_speed
```

`epoch` is untouched, so a reset still returns the calendar to it by definition. The
arithmetic is `reanchorForSpeed` in `packages/sim`, and it is pure like everything else
there.

**Scheduled events need nothing.** `world_event.fire_at` is a game-time instant (M1-06), so
an event keeps its in-game moment with no rewrite at all — what changes is how long the wait
is in real time. The queue drains on `fire_at <= inGameDate(now)`, so preserving the in-game
date preserves due-ness for every event at once. `launch_date′` is rounded **up**, which
makes the calendar land at or fractionally behind where it was rather than ahead, so a speed
change cannot sweep the clock past a pending event and fire it early. The residue is under
`new_speed` milliseconds, in one direction, and is reported in the API response rather than
being quietly absorbed.

**What was not built, and is still owed.** The piecewise-segment model. The past calendar is
still derived from a single speed, so after a change, an older real instant maps to a
different in-game date than it did before, and changing the speed back does not restore the
old mapping. Persisted game-time facts such as `world_event.fire_at` keep their intended
calendar instant and are not rewritten. The danger is historical code that stores only a
real timestamp and later recomputes what game date it represented: after a speed change that
answer is no longer stable. Such a feature must persist the game-time occurrence when it
happens or add the segment table first. The console's confirmation states this cost rather
than hiding it.

**§22.2's two-person rule is also still owed.** The table above says a speed change is gated
behind one admin requesting and another approving. What exists is a single-admin
confirmation, plus the request stating the speed it believed and the server refusing a
mismatch — which stops two admins overwriting each other silently, but does not stop one
admin acting alone. There is one administrator today, so the full rule cannot be exercised
at all; it needs a request/approve flow of its own.

## Addendum, 2026-08-19: what a reset destroys, and the lifecycle around it (M1A-04)

The original decision said a reset is "`launched_at = now()`, leave `epoch` alone, and truncate
world state". **Truncate what** was left unanswered, and that is the whole of the risk. This
settles it.

### What a reset does to each thing

|                                                     |                       | Why                                                                                                                                                                                                   |
| --------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world.launch_date`                                 | **set to now**        | The calendar returns to the epoch by definition.                                                                                                                                                      |
| `world.status`                                      | **back to `staging`** | A world that has just lost its airlines is not one people should still be joining. Opening it again is a separate, deliberate act.                                                                    |
| `airline`                                           | **deleted**           | An airline holds cash it earned and a network it flew on a timeline that no longer happened. Keeping it would be keeping a claim on history that has been erased.                                     |
| `world_event`                                       | **deleted**           | `fire_at` is a game-time instant on the old timeline. Rescheduling onto the new one would be guessing at intent, and the guess would be invisible when it was wrong.                                  |
| `player`                                            | **kept**              | An airline is a player's presence in _one world_, not the account. Signing in afterwards works and finds no airline. §22.10's anonymise-not-delete rule is about erasing a person, which this is not. |
| `admin_audit`                                       | **kept**              | Append-only, enforced by trigger. A reset is a thing that happened and the log of it survives the thing it describes.                                                                                 |
| `airport`, `runway`, `catchment`, `dataset_version` | **untouched**         | Global reference data (M1-01), not world state. Re-importing 86,000 airports to rewind a clock would be absurd.                                                                                       |

`airline.player_id` is `ON DELETE RESTRICT` precisely so deleting airlines has to be a
deliberate statement rather than a side effect of deleting something else.

### The transition graph

```
staging ──→ open ──→ locked ──→ archived
   │          ↑         │           │
   │          └─────────┘           ×  (terminal)
   └────────────────────────────────┘
```

Two absences are the decisions:

- **`open` cannot go straight to `archived`.** Archiving is permanent and read-only, and doing
  it to a world with players in flight should be two deliberate acts. Lock it, then archive it.
- **`archived` goes nowhere, and cannot be reset.** §22.2 keeps archived worlds browsable for
  ever — "players should never lose their airline's history". A record that can start moving
  again is not a record.

Locking stops play but **not the clock**. Game time is derived from `launch_date` (above), so
there is nothing to pause; an aircraft in the air is still in the air when the world reopens,
further along. Pausing the clock would mean storing accumulated time, which is the model this
ADR exists to avoid.

### The guard rails, honestly

The original "Guard rails" section listed five requirements for a reset. Three are built, and
the other two are not:

| Guard rail                                             | Status                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorldAdmin` role or above                             | **Built** — `requireAdmin` on every route. Finer roles are M11-01.                                                                                                                                                                                                                                                                                                                       |
| A mandatory reason in the immutable audit log          | **Built** — refused without one.                                                                                                                                                                                                                                                                                                                                                         |
| The world's name typed to confirm                      | **Built** — checked inside the transaction against the locked row, so a confirmation read against one world cannot be applied to another.                                                                                                                                                                                                                                                |
| The **two-person rule** on an `open` world             | **Not built.** Deferred by the owner on 2026-08-19: there is one administrator, so one admin requesting and another approving cannot be exercised at all. What stands in for it is the typed name, the mandatory reason, and `expectedStatus` — a world opened to players while the confirmation sat on screen is refused rather than quietly reset. Revisit when a second admin exists. |
| An automatic pre-reset backup as a precondition        | **Not built.** Nightly off-box backups exist (OPS-03) and the console shows their freshness, but the reset does not take one of its own first.                                                                                                                                                                                                                                           |
| Refusal if any player is not flagged as a test account | **Not implementable as written.** There is no test-account flag on `player`, and inventing one to satisfy this would be a schema change made for a checklist. The confirmation instead states the exact number of airlines that will be destroyed, and says plainly when the world is open.                                                                                              |

Written down rather than quietly skipped: a guard rail that exists only in an ADR is worse
than one that was never written, because everyone assumes it is there.

## Revisit when

Anything persists an in-game timestamp, at which point the piecewise-segment model has to be
built rather than approximated — a speed change would otherwise leave stored dates meaning
something different from the dates computed around them.
