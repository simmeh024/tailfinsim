import { describe, expect, it } from 'vitest';

import {
  msUntilRefresh,
  nextRefreshAt,
  rosterDayIndex,
  rotatingExecutiveRoster,
  ROSTER_REFRESH_MS,
  ROSTER_SIZE,
} from './csuite-rotation';

/**
 * The rotating C-Suite market (§9.1 follow-up, Phase 3).
 *
 * The selection is a pure function of a day index, so it must be stable within a
 * window, differ between windows, and never mutate or lose the input. The clock
 * arithmetic is checked at a window boundary because that is where an off-by-one
 * would show as a countdown that never resets.
 */

const pool = Array.from({ length: 24 }, (_, i) => ({ id: `c-${i.toString()}` }));

describe('rotatingExecutiveRoster', () => {
  it('returns ROSTER_SIZE distinct candidates from the pool', () => {
    const roster = rotatingExecutiveRoster(pool, 100, ROSTER_SIZE);
    expect(roster).toHaveLength(ROSTER_SIZE);
    expect(new Set(roster.map((c) => c.id)).size).toBe(ROSTER_SIZE);
    for (const c of roster) expect(pool).toContainEqual(c);
  });

  it('is stable within a window and changes between windows', () => {
    expect(rotatingExecutiveRoster(pool, 100).map((c) => c.id)).toEqual(
      rotatingExecutiveRoster(pool, 100).map((c) => c.id),
    );
    expect(rotatingExecutiveRoster(pool, 100).map((c) => c.id)).not.toEqual(
      rotatingExecutiveRoster(pool, 101).map((c) => c.id),
    );
  });

  it('does not mutate the input', () => {
    const before = pool.map((c) => c.id);
    rotatingExecutiveRoster(pool, 7);
    expect(pool.map((c) => c.id)).toEqual(before);
  });

  it('draws from the whole pool, not just the first ten', () => {
    // Union of a handful of windows should reach beyond the first ROSTER_SIZE ids.
    const seen = new Set<string>();
    for (let day = 0; day < 12; day += 1) {
      for (const c of rotatingExecutiveRoster(pool, day)) seen.add(c.id);
    }
    expect(seen.size).toBeGreaterThan(ROSTER_SIZE);
  });
});

describe('the refresh clock', () => {
  it('buckets time into 24-hour windows', () => {
    const t = 100 * ROSTER_REFRESH_MS + 5_000;
    expect(rosterDayIndex(t)).toBe(100);
    expect(nextRefreshAt(t)).toBe(101 * ROSTER_REFRESH_MS);
    expect(msUntilRefresh(t)).toBe(ROSTER_REFRESH_MS - 5_000);
  });

  it('never reports a negative countdown', () => {
    const boundary = 50 * ROSTER_REFRESH_MS;
    expect(msUntilRefresh(boundary)).toBe(ROSTER_REFRESH_MS);
    expect(msUntilRefresh(boundary - 1)).toBe(1);
  });
});
