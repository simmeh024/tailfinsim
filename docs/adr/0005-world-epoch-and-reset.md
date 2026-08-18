# ADR-0005: Separate a world's epoch from its launch date, so it can be reset

- **Status:** Accepted
- **Date:** 2026-08-17
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

That in-game time is never available as a stored column to query against directly. Reports
that want "flights in October 2024" must convert to the real-time window and query that —
slightly more work at the query layer, in exchange for a clock that cannot drift.

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
old mapping. Nothing stores an in-game timestamp today — §21 computes them all on read — so
nothing is currently _wrong_ as a result. The day anything does persist an in-game date, the
segment table has to exist first. The console's confirmation states this in as many words,
so it is a known cost rather than a surprise.

**§22.2's two-person rule is also still owed.** The table above says a speed change is gated
behind one admin requesting and another approving. What exists is a single-admin
confirmation, plus the request stating the speed it believed and the server refusing a
mismatch — which stops two admins overwriting each other silently, but does not stop one
admin acting alone. There is one administrator today, so the full rule cannot be exercised
at all; it needs a request/approve flow of its own.

## Revisit when

Anything persists an in-game timestamp, at which point the piecewise-segment model has to be
built rather than approximated — a speed change would otherwise leave stored dates meaning
something different from the dates computed around them.
