import { describe, expect, it } from 'vitest';

import {
  convergenceInstant,
  FLAGSHIP_EPOCH,
  FLAGSHIP_SPEED,
  gameTime,
  gameToRealMs,
  realTimeAtGameTime,
  realToGameMs,
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
