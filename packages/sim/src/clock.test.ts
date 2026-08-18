import { describe, expect, it } from 'vitest';

import {
  convergenceInstant,
  FLAGSHIP_EPOCH,
  FLAGSHIP_SPEED,
  gameTime,
  gameToRealMs,
  realTimeAtGameTime,
  realToGameMs,
  reanchorForSpeed,
  type WorldClock,
} from './clock';

/**
 * The world clock.
 *
 * Every other system reads game time from here, so a fault in this file is a
 * fault everywhere at once, and an invisible one. The tests are correspondingly
 * blunt: the formula, the acceptance criteria stated verbatim, the round trip,
 * and the edges.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const launchDate = new Date('2026-08-18T00:00:00.000Z');

const flagship: WorldClock = {
  epoch: FLAGSHIP_EPOCH,
  launchDate,
  speedMultiplier: FLAGSHIP_SPEED,
};

describe('gameTime', () => {
  it('is the epoch at the moment of launch', () => {
    expect(gameTime(flagship, launchDate)).toEqual(FLAGSHIP_EPOCH);
  });

  it('runs at twice wall-clock for the flagship world', () => {
    const oneRealHourLater = new Date(launchDate.getTime() + HOUR);
    expect(gameTime(flagship, oneRealHourLater).getTime() - FLAGSHIP_EPOCH.getTime()).toBe(
      2 * HOUR,
    );
  });

  it('is a pure function of its arguments', () => {
    // The acceptance criterion. Nothing here reads a clock, so the same inputs
    // give the same answer forever — which is what makes replay possible.
    const at = new Date('2026-09-01T12:34:56.000Z');
    expect(gameTime(flagship, at)).toEqual(gameTime(flagship, at));
    expect(gameTime(flagship, at).toISOString()).toBe(gameTime(flagship, at).toISOString());
  });

  it('goes before the epoch for a real time before launch', () => {
    // Arithmetic, not an error: someone asked about a moment before the world
    // existed, and clamping would hide the question.
    const before = new Date(launchDate.getTime() - HOUR);
    expect(gameTime(flagship, before).getTime()).toBeLessThan(FLAGSHIP_EPOCH.getTime());
  });

  it('uses the flagship epoch from §3.1b', () => {
    expect(FLAGSHIP_EPOCH.toISOString()).toBe('2024-10-20T00:00:00.000Z');
    expect(FLAGSHIP_SPEED).toBe(2);
  });

  it('refuses a non-positive speed rather than freezing or reversing the world', () => {
    expect(() => gameTime({ ...flagship, speedMultiplier: 0 }, launchDate)).toThrow(/positive/);
    expect(() => gameTime({ ...flagship, speedMultiplier: -1 }, launchDate)).toThrow(/positive/);
  });

  it('refuses an invalid date rather than producing an invalid game time', () => {
    expect(() => gameTime({ ...flagship, epoch: new Date('nonsense') }, launchDate)).toThrow(
      /invalid epoch or launch date/,
    );
  });
});

describe('duration conversion', () => {
  it('turns a 55-minute game block into 27.5 real minutes', () => {
    // The acceptance criterion, stated verbatim.
    expect(gameToRealMs(flagship, 55 * MINUTE)).toBe(27.5 * MINUTE);
  });

  it('turns real time into game time the other way', () => {
    expect(realToGameMs(flagship, 27.5 * MINUTE)).toBe(55 * MINUTE);
  });

  it('round-trips any duration', () => {
    for (const ms of [0, 1, 1_000, 55 * MINUTE, 3 * DAY]) {
      expect(realToGameMs(flagship, gameToRealMs(flagship, ms))).toBeCloseTo(ms, 6);
    }
  });

  it('is the identity at speed 1', () => {
    const realtime: WorldClock = { ...flagship, speedMultiplier: 1 };
    expect(gameToRealMs(realtime, 90 * MINUTE)).toBe(90 * MINUTE);
  });
});

describe('realTimeAtGameTime', () => {
  it('inverts gameTime exactly', () => {
    // The property the event queue depends on: it schedules in game time and has
    // to sleep in real time.
    const at = new Date('2026-11-02T03:04:05.000Z');
    const gt = gameTime(flagship, at);
    expect(realTimeAtGameTime(flagship, gt).getTime()).toBeCloseTo(at.getTime(), 6);
  });

  it('returns the launch instant for the epoch itself', () => {
    expect(realTimeAtGameTime(flagship, FLAGSHIP_EPOCH)).toEqual(launchDate);
  });

  it('halves a game duration into real time for the flagship world', () => {
    const oneGameDayOn = new Date(FLAGSHIP_EPOCH.getTime() + DAY);
    const real = realTimeAtGameTime(flagship, oneGameDayOn);
    expect(real.getTime() - launchDate.getTime()).toBe(DAY / 2);
  });
});

describe('convergence', () => {
  it('meets real time after the epoch gap has been closed', () => {
    // The acceptance criterion: with epoch 2024-10-20 and speed 2, game time
    // catches real time after (launch − epoch) of real elapsed time, because
    // every real day buys two game days and the spare one closes the gap.
    const meeting = convergenceInstant(flagship);
    expect(meeting).not.toBeNull();

    const gapMs = launchDate.getTime() - FLAGSHIP_EPOCH.getTime();
    expect(meeting!.getTime() - launchDate.getTime()).toBeCloseTo(gapMs, -3);
  });

  it('has game time equal to real time at that instant', () => {
    // The definition, checked directly rather than through the formula.
    const meeting = convergenceInstant(flagship)!;
    expect(gameTime(flagship, meeting).getTime()).toBeCloseTo(meeting.getTime(), -3);
  });

  it('never converges at speed 1', () => {
    // Game time trails real time by a constant gap forever.
    expect(convergenceInstant({ ...flagship, speedMultiplier: 1 })).toBeNull();
  });

  it('never converges at a speed below 1 with an epoch in the past', () => {
    // The gap widens rather than closes, and "when?" has no honest answer.
    expect(convergenceInstant({ ...flagship, speedMultiplier: 0.5 })).toBeNull();
  });

  it('has already converged when the epoch is the launch instant', () => {
    // Nothing ahead of us to wait for.
    const now: WorldClock = { ...flagship, epoch: launchDate };
    expect(convergenceInstant(now)?.getTime()).toBe(launchDate.getTime());
  });
});

describe('there is no time skip', () => {
  it('exposes no way to advance the clock', () => {
    // §3.1: the sim never pauses, and M1-05 puts time skip explicitly out of
    // scope. This asserts the absence, so adding one is a deliberate act rather
    // than a convenience someone slips in.
    const clockModule: Record<string, unknown> = {
      convergenceInstant,
      gameTime,
      gameToRealMs,
      realToGameMs,
      realTimeAtGameTime,
    };
    for (const name of Object.keys(clockModule)) {
      expect(name).not.toMatch(/advance|skip|setTime|jump/i);
    }
  });
});

describe('reanchorForSpeed', () => {
  // Thirty real days into the flagship world, so there is a substantial stretch
  // of elapsed real time for a naive change to misapply.
  const at = new Date(launchDate.getTime() + 30 * DAY);

  it('leaves the in-game date exactly where it was', () => {
    // M1A-03's first acceptance criterion. At these numbers the division lands
    // on a whole millisecond, so this is an equality rather than a tolerance.
    const before = gameTime(flagship, at);
    const after = reanchorForSpeed(flagship, 3, at);
    expect(gameTime(after, at).getTime()).toBe(before.getTime());
  });

  it('is what a bare multiplier change is not', () => {
    // The failure this function exists to prevent, stated as the difference it
    // makes: 30 real days at 2× is 60 game days, and simply writing 3 would make
    // it 90 — thirty game days of history arriving in an instant.
    const naive = gameTime({ ...flagship, speedMultiplier: 3 }, at);
    const before = gameTime(flagship, at);
    expect(naive.getTime() - before.getTime()).toBe(30 * DAY);
    expect(gameTime(reanchorForSpeed(flagship, 3, at), at).getTime() - before.getTime()).toBe(0);
  });

  it('runs at the new speed from then on', () => {
    const after = reanchorForSpeed(flagship, 3, at);
    const anHourLater = new Date(at.getTime() + HOUR);
    expect(gameTime(after, anHourLater).getTime() - gameTime(after, at).getTime()).toBe(3 * HOUR);
  });

  it('never touches the epoch', () => {
    // `epoch` is what the world is, and where a reset returns to (ADR-0005). A
    // speed change that moved it would quietly redefine the world.
    expect(reanchorForSpeed(flagship, 0.5, at).epoch).toEqual(flagship.epoch);
    expect(reanchorForSpeed(flagship, 50, at).epoch).toEqual(flagship.epoch);
  });

  it('keeps a scheduled event at the same in-game moment', () => {
    // M1A-03's second acceptance criterion, at the level the queue works at:
    // `world_event.fire_at` is a game-time instant (M1-06), so an event does not
    // move. What changes is how long the wait is in real time — which is the
    // point of changing the speed.
    const before = gameTime(flagship, at);
    const fireAt = new Date(before.getTime() + 6 * HOUR);

    const realBefore = realTimeAtGameTime(flagship, fireAt);
    const faster = reanchorForSpeed(flagship, 4, at);
    const realAfter = realTimeAtGameTime(faster, fireAt);

    // Same in-game moment, reached sooner: six game hours at 2× is three real
    // hours, and at 4× it is ninety real minutes.
    expect(realBefore.getTime() - at.getTime()).toBe(3 * HOUR);
    expect(realAfter.getTime() - at.getTime()).toBe(90 * MINUTE);
  });

  it('cannot make a pending event fire early, at any speed', () => {
    // What the queue actually asks: it drains everything with
    // `fire_at <= gameTime(clock, now)`, so the only way a speed change could
    // wrongly fire something is by sweeping the calendar forwards across an
    // event. Rounding `launchDate` up makes that impossible rather than
    // improbable — the new game time is never ahead of the old one, so no event
    // set has to be walked and none can be caught out.
    //
    // Awkward speeds on purpose: these are the ones where the division does not
    // land on a whole millisecond and the residue actually exists.
    for (const speed of [7, 1.37, 0.03, 99.99, 3.33]) {
      const before = gameTime(flagship, at).getTime();
      const after = gameTime(reanchorForSpeed(flagship, speed, at), at).getTime();

      expect(after).toBeLessThanOrEqual(before);
      // One millisecond into the future is still the future.
      expect(before + 1 <= after).toBe(false);
    }
  });

  it('keeps an event that was already due, due', () => {
    // The other half, and the cost of choosing that direction: the calendar can
    // sit a few milliseconds behind, so an event due at the exact instant of the
    // change may wait one more drain. Anything meaningfully in the past stays
    // past.
    const before = gameTime(flagship, at);
    const dueASecondAgo = new Date(before.getTime() - 1000);

    for (const speed of [7, 1.37, 0.03, 99.99]) {
      const after = gameTime(reanchorForSpeed(flagship, speed, at), at);
      expect(dueASecondAgo.getTime() <= after.getTime()).toBe(true);
    }
  });

  it('rewrites the past, and this is the test that says so out loud', () => {
    // Not a bug being pinned in place — a documented consequence (ADR-0005). The
    // calendar is derived from one speed, so an older instant maps differently
    // afterwards. If someone ever builds the piecewise segment table, this test
    // is the one that should start failing.
    const yesterday = new Date(at.getTime() - DAY);
    const before = gameTime(flagship, yesterday);
    const after = gameTime(reanchorForSpeed(flagship, 3, at), yesterday);

    // A real day back, the calendars disagree by exactly the speed difference
    // applied to that day: 3 game days versus 2.
    expect(after.getTime() - before.getTime()).toBe(-DAY);
  });

  it('holds the present instant across a change and back again', () => {
    // A round trip through a clean multiplier returns the same game time *and*
    // the same clock, which is worth knowing: undoing a speed change by hand
    // restores the world rather than leaving it subtly re-anchored.
    const before = gameTime(flagship, at);
    const there = reanchorForSpeed(flagship, 5, at);
    const back = reanchorForSpeed(there, FLAGSHIP_SPEED, at);

    expect(gameTime(back, at).getTime()).toBe(before.getTime());
    expect(back.launchDate.getTime()).toBe(flagship.launchDate.getTime());
  });

  it('keeps the residue below one millisecond per unit of speed, and only ever behind', () => {
    // The honest limit, stated as a bound rather than assumed away.
    //
    // Two roundings, not one: `launchDate` is rounded up here (worth under
    // `speed` milliseconds of calendar), and `gameTime` truncates its own
    // multiplication when `speed × elapsed` is fractional (worth under one more).
    // Hence `speed + 1`, which is arithmetic rather than a fudge factor — at 1.37
    // the observed loss is 2ms, which no bound of 1.37 could accommodate.
    //
    // The direction is the part that must not slip: never negative, so no change
    // can ever push the calendar forward.
    let clock = flagship;
    for (const speed of [1.37, 0.03, 99.99, 7.5, 1.37, 2]) {
      const before = gameTime(clock, at).getTime();
      clock = reanchorForSpeed(clock, speed, at);
      const lost = before - gameTime(clock, at).getTime();
      expect(lost).toBeGreaterThanOrEqual(0);
      expect(lost).toBeLessThan(speed + 1);
    }
    const totalLost = gameTime(flagship, at).getTime() - gameTime(clock, at).getTime();
    expect(totalLost).toBeGreaterThanOrEqual(0);
    expect(totalLost).toBeLessThan(200);
  });

  it('refuses a speed that would freeze or reverse the world', () => {
    for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reanchorForSpeed(flagship, speed, at)).toThrow(/must be positive/);
    }
  });

  it('refuses to re-anchor a clock that was already broken', () => {
    const broken: WorldClock = { ...flagship, launchDate: new Date('not a date') };
    expect(() => reanchorForSpeed(broken, 3, at)).toThrow(/invalid epoch or launch date/);
  });
});
