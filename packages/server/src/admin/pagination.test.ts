import { describe, expect, it } from 'vitest';

import { PLAYER_PAGE_LIMIT, boundedCount } from './players';

/**
 * The pagination clamp, and the `NaN` it used to let through.
 *
 * **No database, on purpose.** `players.test.ts` is gated on `DATABASE_URL` and
 * skips without one, so the assertion that matters most here would have been
 * invisible on a local run. CLAUDE.md records that trap in as many words: *"a
 * green local run means very little for server work."* These are arithmetic
 * assertions and they run everywhere.
 *
 * ## The bug this pins
 *
 * `/api/admin/players?limit=abc` produced `Number('abc')` → `NaN`, and the
 * obvious clamp does not stop it: `Math.trunc(NaN)` is `NaN`, `Math.max(NaN, 1)`
 * is `NaN`, and `Math.min(NaN, 200)` is `NaN`. So `NaN` reached `.limit()` and
 * Postgres was asked for `limit 'NaN'` — a 500 for a malformed query string.
 *
 * The route now refuses such a value with 400 before it gets here. This is the
 * second line of defence, so a future caller cannot reintroduce it.
 */
describe('boundedCount', () => {
  const MAX = 200;

  it('rejects NaN by falling back, rather than propagating it', () => {
    // The regression. Every other case below already worked.
    expect(boundedCount(Number.NaN, PLAYER_PAGE_LIMIT, MAX)).toBe(PLAYER_PAGE_LIMIT);
    expect(Number.isNaN(boundedCount(Number.NaN, PLAYER_PAGE_LIMIT, MAX))).toBe(false);
  });

  it('treats both infinities as unusable, not as the ceiling', () => {
    // `Infinity` clamped correctly on its own, but "not a usable number" having
    // two different answers is how the NaN case survived review.
    expect(boundedCount(Number.POSITIVE_INFINITY, PLAYER_PAGE_LIMIT, MAX)).toBe(PLAYER_PAGE_LIMIT);
    expect(boundedCount(Number.NEGATIVE_INFINITY, PLAYER_PAGE_LIMIT, MAX)).toBe(PLAYER_PAGE_LIMIT);
  });

  it('applies the default when nothing was asked for', () => {
    expect(boundedCount(undefined, PLAYER_PAGE_LIMIT, MAX)).toBe(PLAYER_PAGE_LIMIT);
  });

  it('clamps to the ceiling, so a stray request cannot ask for everything', () => {
    expect(boundedCount(999_999, PLAYER_PAGE_LIMIT, MAX)).toBe(MAX);
    expect(boundedCount(MAX, PLAYER_PAGE_LIMIT, MAX)).toBe(MAX);
  });

  it('clamps to the floor, including for a negative', () => {
    expect(boundedCount(-5, PLAYER_PAGE_LIMIT, MAX)).toBe(1);
    expect(boundedCount(0, PLAYER_PAGE_LIMIT, MAX)).toBe(1);
  });

  it('honours a zero floor, which is what an offset needs', () => {
    expect(boundedCount(-5, 0, Number.MAX_SAFE_INTEGER, 0)).toBe(0);
    expect(boundedCount(0, 0, Number.MAX_SAFE_INTEGER, 0)).toBe(0);
  });

  it('truncates a fraction rather than rounding it', () => {
    expect(boundedCount(12.7, PLAYER_PAGE_LIMIT, MAX)).toBe(12);
  });

  it('passes an ordinary page size through untouched', () => {
    expect(boundedCount(25, PLAYER_PAGE_LIMIT, MAX)).toBe(25);
  });
});
