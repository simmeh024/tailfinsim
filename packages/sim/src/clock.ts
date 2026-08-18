/**
 * The world clock (M1-05, design doc §3.1 and §3.1b).
 *
 * The single most important primitive in the project: every other system reads
 * game time from here, so if this is wrong everything downstream is wrong in a
 * way that is very hard to see.
 *
 *     gameTime = epoch + speed × (realNow − launchDate)
 *
 * ## Pure, and it never reads a clock
 *
 * `realNow` is always a parameter. Nothing here calls `Date.now()`. That is
 * CONTRIBUTING invariant 2 and it is what makes M13-01's deterministic replay
 * possible at all — a function that reads the wall clock cannot be replayed, and
 * a simulation you cannot replay is one you cannot debug.
 *
 * ## No time skip, by design
 *
 * §3.1: "the sim never pauses". There is deliberately no way to jump the clock
 * forward, and no `advance()` here to tempt anyone. An admin reset moves
 * `launchDate` to now, which returns the calendar to the epoch by definition
 * rather than by recalculating anything (ADR-0005).
 */

/** The world's clock parameters. A subset of the `world` row, so the sim needs no database types. */
export interface WorldClock {
  /** Where the in-game calendar begins. `2024-10-20T00:00:00Z` for the flagship world. */
  epoch: Date;
  /** The real instant this world's clock started running. */
  launchDate: Date;
  /** 2 for the flagship world — game time runs at twice wall-clock. */
  speedMultiplier: number;
}

function assertSpeed(speedMultiplier: number): void {
  if (!Number.isFinite(speedMultiplier) || speedMultiplier <= 0) {
    // A zero or negative multiplier would freeze or reverse the world. §22.2
    // gates changing it at all; this is the floor beneath that gate.
    throw new Error(`World speed multiplier must be positive, got ${String(speedMultiplier)}`);
  }
}

function assertUsable(clock: WorldClock): void {
  assertSpeed(clock.speedMultiplier);
  if (Number.isNaN(clock.epoch.getTime()) || Number.isNaN(clock.launchDate.getTime())) {
    throw new Error('World clock has an invalid epoch or launch date');
  }
}

/**
 * Game time for a given real instant.
 *
 * `realNow` before `launchDate` yields a game time before the epoch. That is
 * arithmetic rather than an error: it means someone asked about a moment before
 * the world existed, and clamping would hide the question.
 */
export function gameTime(clock: WorldClock, realNow: Date): Date {
  assertUsable(clock);
  const realElapsedMs = realNow.getTime() - clock.launchDate.getTime();
  return new Date(clock.epoch.getTime() + clock.speedMultiplier * realElapsedMs);
}

/** How much real time has to pass for `gameMs` of game time to elapse. */
export function gameToRealMs(clock: WorldClock, gameMs: number): number {
  assertUsable(clock);
  return gameMs / clock.speedMultiplier;
}

/** How much game time passes in `realMs` of real time. */
export function realToGameMs(clock: WorldClock, realMs: number): number {
  assertUsable(clock);
  return realMs * clock.speedMultiplier;
}

/**
 * The real instant at which the world's clock reaches `target`.
 *
 * The inverse of `gameTime`, and the reason the event queue can schedule in game
 * time and sleep in real time (M1-06).
 */
export function realTimeAtGameTime(clock: WorldClock, target: Date): Date {
  assertUsable(clock);
  const gameElapsedMs = target.getTime() - clock.epoch.getTime();
  return new Date(clock.launchDate.getTime() + gameElapsedMs / clock.speedMultiplier);
}

/**
 * When game time catches up with real time, if it ever does.
 *
 * §3.1b starts the flagship world in the past and runs it at 2×, so the calendar
 * closes the gap and eventually overtakes the present. The acceptance criterion
 * states the property: with an epoch of 2024-10-20, game time meets real time
 * after (launch − epoch) of real elapsed time, because at speed 2 every real day
 * buys two game days and the second one is spent closing the gap.
 *
 * Returns `null` at speed ≤ 1 with an epoch in the past, where the gap never
 * closes — the honest answer to "when does it converge?" is "it does not".
 */
export function convergenceInstant(clock: WorldClock): Date | null {
  assertUsable(clock);

  // Solve epoch + s(t − launch) = t for t.
  //   t = (epoch − s·launch) / (1 − s)
  if (clock.speedMultiplier === 1) return null;

  const epochMs = clock.epoch.getTime();
  const launchMs = clock.launchDate.getTime();
  const s = clock.speedMultiplier;
  const t = (epochMs - s * launchMs) / (1 - s);

  // Convergence in the past is not convergence ahead of us.
  return t >= launchMs ? new Date(t) : null;
}

/**
 * The clock a world should have after a speed change, with the calendar left
 * standing where it is (M1A-03, §22.2).
 *
 * ## Why this is not simply `speedMultiplier = newSpeed`
 *
 * Game time is `epoch + speed × (now − launchDate)`, so the multiplier is
 * applied to *all* the real time that has already elapsed. Changing it alone
 * makes the world lurch: a world 30 real days old at 2× sits 60 game days past
 * its epoch, and moving to 3× would jump it to 90 — thirty game days of history
 * that never happened, arriving in an instant.
 *
 * So `launchDate` is re-anchored to whatever instant makes the *current* game
 * time come out unchanged under the new speed:
 *
 *     launchDate′ = at − (gameTime(clock, at) − epoch) / newSpeed
 *
 * `epoch` is never touched. It is what the world *is*, and a reset returns to it
 * (ADR-0005).
 *
 * ## What this does not fix
 *
 * The calendar is still derived from a single speed, so **the past is rewritten**.
 * After the change, asking what the in-game date was last Tuesday gives a
 * different answer than it would have before, because the new multiplier is
 * applied to that older stretch of real time too. Only the present instant is
 * preserved, and changing the speed back does not restore the old mapping.
 *
 * ADR-0005 names the honest fix — a piecewise table of `(from, to, speed)`
 * segments — and deliberately does not build it. Nothing stores an in-game
 * timestamp today (§21 computes them all on read), so nothing is currently
 * *wrong* as a result; the day something does, that table has to exist.
 *
 * ## Millisecond honesty, and which way it leans
 *
 * `launchDate′` is a whole number of milliseconds and the division above rarely
 * lands on one, so the game time that comes back can be a few milliseconds off
 * the one going in. That residue cannot be removed — `epoch` may not move, and
 * milliseconds are the resolution — but its **direction can be chosen**, and it
 * is worth choosing.
 *
 * `launchDate′` is rounded **up**, which makes the new game time land at or
 * fractionally *before* the old one, never after. The gap is under `newSpeed`
 * milliseconds from this rounding, plus under one more from `gameTime` truncating
 * its own multiplication — small, bounded, and in one direction only, which is
 * what makes it safe rather than merely tiny. So changing the speed can never
 * make a scheduled event fire
 * early: the queue drains everything with `fire_at <= gameTime(now)` (M1-06), and
 * a calendar that cannot jump forward cannot sweep an event across that line.
 * The cost is that an event due at the exact instant of the change may wait one
 * more drain, which is a few milliseconds in a world whose events are minutes
 * apart. Early is a violation of what an event *means*; late is a Tuesday.
 */
export function reanchorForSpeed(
  clock: WorldClock,
  newSpeedMultiplier: number,
  at: Date,
): WorldClock {
  // Validates `clock` on the way past, so a broken clock is refused before it
  // becomes a broken clock with a new speed.
  const stayAt = gameTime(clock, at);
  assertSpeed(newSpeedMultiplier);

  const gameElapsedMs = stayAt.getTime() - clock.epoch.getTime();
  return {
    epoch: clock.epoch,
    // Up, not nearest: a later launch means less elapsed real time, so the
    // calendar lands at or a hair behind where it was and never ahead of it.
    launchDate: new Date(Math.ceil(at.getTime() - gameElapsedMs / newSpeedMultiplier)),
    speedMultiplier: newSpeedMultiplier,
  };
}

/** Convenience for the flagship world's parameters (§3.1b). */
export const FLAGSHIP_EPOCH = new Date('2024-10-20T00:00:00.000Z');
export const FLAGSHIP_SPEED = 2;
