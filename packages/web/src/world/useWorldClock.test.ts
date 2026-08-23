import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SYNC_INTERVAL_MS, useWorldClock } from './useWorldClock';

/**
 * The browser-side world clock.
 *
 * What matters is that it runs at the **world's** speed between syncs, and that
 * it does so without consulting the browser's absolute clock — a machine set
 * wrong must still show the world's time, which is the whole reason the server
 * sends `serverTime` alongside `inGameTime`.
 */

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as Response),
    ),
  );
}

const CLOCK = {
  worldId: '00000000-0000-4000-8000-000000000001',
  serverTime: '2026-08-23T12:00:00.000Z',
  inGameTime: '2024-10-20T06:00:00.000Z',
  speedMultiplier: 2,
};

describe('useWorldClock', () => {
  beforeEach(() => {
    /*
     * `performance` has to be faked explicitly, and leaving it out makes this
     * suite quietly meaningless rather than failing loudly in an obvious way.
     *
     * Vitest's default `toFake` list covers the timers and `Date`, but not
     * `performance.now()` — which is the *only* source the hook reads, precisely
     * because it is monotonic. Advancing ten minutes of fake time therefore moved
     * every timer while the clock itself stood still, and the first version of
     * this test measured 80ms of game time elapsing instead of twenty minutes.
     */
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports the world time and speed once synced', async () => {
    respondWith(CLOCK);
    const { result } = renderHook(() => useWorldClock());

    await waitFor(() => {
      expect(result.current.inGameTime).not.toBeNull();
    });
    expect(result.current.speedMultiplier).toBe(2);
    // Within a second of the anchor: no real time has meaningfully passed.
    const drift = Math.abs(
      (result.current.inGameTime?.getTime() ?? 0) - Date.parse(CLOCK.inGameTime),
    );
    expect(drift).toBeLessThan(1000);
  });

  it('advances at the world s speed, not real time', async () => {
    respondWith(CLOCK);
    const { result } = renderHook(() => useWorldClock());
    await waitFor(() => {
      expect(result.current.inGameTime).not.toBeNull();
    });
    const started = result.current.inGameTime?.getTime() ?? 0;

    /*
     * Five real minutes — deliberately **inside** `SYNC_INTERVAL_MS`.
     *
     * Advancing a full ten fires the resync, and because the stub always answers
     * with the same canned `inGameTime` the hook correctly re-anchors to it and
     * the clock appears not to have moved at all. That is the hook working, and
     * it cost a debugging round to see: the measurement has to sit between two
     * syncs, which is exactly the interval the interpolation exists for.
     */
    await act(async () => {
      vi.advanceTimersByTime(300_000);
      await Promise.resolve();
    });

    const elapsedGameMs = (result.current.inGameTime?.getTime() ?? 0) - started;
    /*
     * Ten in-game minutes, because the world runs at 2x. The tolerance covers the
     * half-round-trip correction and the one-second render tick; the assertion
     * that matters is that this is nowhere near the five real minutes a wall
     * clock would have produced.
     */
    expect(elapsedGameMs).toBeGreaterThan(590_000);
    expect(elapsedGameMs).toBeLessThan(610_000);
  });

  it('reports nothing for a player with no world, rather than throwing', async () => {
    // 409 is what the airline boundary answers before anyone has founded.
    respondWith({ code: 'active_world_required', message: 'no' }, 409);
    const { result } = renderHook(() => useWorldClock());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.inGameTime).toBeNull();
    expect(result.current.speedMultiplier).toBeNull();
  });

  it('survives a failed sync instead of rejecting', async () => {
    /*
     * The clock is decoration over a map that renders without it, so a dropped
     * request must cost the chip and nothing else. Left unhandled this is a
     * rejection from a timer, which surfaces as a page-level error for something
     * nobody needed — and it showed up as exactly that in the suite before the
     * `catch` went in.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const { result } = renderHook(() => useWorldClock());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.inGameTime).toBeNull();
  });

  it('re-syncs, so an admin speed change reaches an open tab', async () => {
    respondWith(CLOCK);
    renderHook(() => useWorldClock());
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      vi.advanceTimersByTime(SYNC_INTERVAL_MS + 1000);
      await Promise.resolve();
    });
    // Without this a tab left open keeps running the old multiplier for ever;
    // `reanchorForSpeed` on the server changes both epoch anchor and speed.
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
