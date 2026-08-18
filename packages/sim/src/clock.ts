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

function assertUsable(clock: WorldClock): void {
  if (!Number.isFinite(clock.speedMultiplier) || clock.speedMultiplier <= 0) {
    // A zero or negative multiplier would freeze or reverse the world. §22.2
    // gates changing it at all; this is the floor beneath that gate.
    throw new Error(
      `World speed multiplier must be positive, got ${String(clock.speedMultiplier)}`,
    );
  }
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

/** Convenience for the flagship world's parameters (§3.1b). */
export const FLAGSHIP_EPOCH = new Date('2024-10-20T00:00:00.000Z');
export const FLAGSHIP_SPEED = 2;
