import { describe, expect, it } from 'vitest';

import { inGameDate } from './index.js';

describe('inGameDate', () => {
  const HOUR_MS = 60 * 60 * 1000;

  it('returns the epoch itself when no real time has elapsed', () => {
    expect(inGameDate(0).toISOString()).toBe('2024-10-20T00:00:00.000Z');
  });

  it('advances two in-game hours per real hour at the flagship 2x speed', () => {
    // Design doc §3.1: a 12h flight takes 6h of real time.
    expect(inGameDate(6 * HOUR_MS).toISOString()).toBe('2024-10-20T12:00:00.000Z');
  });

  it('gives one in-game day per twelve real hours', () => {
    // Design doc §3.1: two in-game days per real day.
    expect(inGameDate(12 * HOUR_MS).toISOString()).toBe('2024-10-21T00:00:00.000Z');
  });

  it('honours a world-specific epoch and speed', () => {
    // The 1950s "Piston & Prop" preset from §22.2, run at 1x.
    expect(inGameDate(24 * HOUR_MS, '1950-01-01T00:00:00.000Z', 1).toISOString()).toBe(
      '1950-01-02T00:00:00.000Z',
    );
  });

  it('is a pure function — the same input always gives the same output', () => {
    // The invariant the replay harness (M13-01) depends on.
    expect(inGameDate(1234567).getTime()).toBe(inGameDate(1234567).getTime());
  });
});
