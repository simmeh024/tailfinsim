import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchWorldClock } from './clock-api';

/**
 * The world's clock, running in the browser between syncs.
 *
 * ## Why it interpolates rather than polls
 *
 * A clock that only moved when a request came back would tick in whatever
 * interval the poll used, and at 2× a five-second poll is ten in-game seconds of
 * visible jump. So the server is asked for the time occasionally and the browser
 * runs the clock in between, at the world's own speed. Between syncs this is
 * exactly the same arithmetic the server does:
 *
 *     inGameTime + speedMultiplier × (realNow − serverTime)
 *
 * ## Why `serverTime` is subtracted rather than the fetch instant
 *
 * The response carries the server's own real time, so the difference above is
 * measured between two server-side quantities plus the local elapsed time — the
 * browser's absolute clock never enters it. A machine set five minutes fast
 * therefore shows the same world time as one set correctly, which is the whole
 * reason §21 has the server send the time at all.
 *
 * The local elapsed part is measured with `performance.now()`, a monotonic
 * source, so the clock does not lurch when the operating system corrects
 * `Date.now()` underneath it — or run backwards across a daylight-saving change.
 *
 * ## Drift
 *
 * Re-synced every {@link SYNC_INTERVAL_MS}. Nothing here needs the precision:
 * the display shows minutes and the terminator moves a quarter of a degree a
 * minute, so a second of accumulated skew is invisible. The resync exists for
 * the case that matters — an **admin speed change**, which re-anchors the world
 * and would otherwise leave every open tab running the old multiplier for as
 * long as it stayed open.
 */

/** Ten minutes. Long enough to cost nothing, short enough to catch a speed change. */
export const SYNC_INTERVAL_MS = 600_000;

export interface WorldClockReading {
  /** In-game time now, or `null` before the first sync and for a player with no world. */
  inGameTime: Date | null;
  /** The world's speed, or `null` when unknown. `2` on the flagship world. */
  speedMultiplier: number | null;
}

interface Anchor {
  inGameMs: number;
  speedMultiplier: number;
  /** `performance.now()` at the moment the response was applied. */
  monotonicAtSync: number;
  /** Real elapsed ms between the server producing the reading and us applying it. */
  transitMs: number;
}

export function useWorldClock(): WorldClockReading {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [, setTick] = useState(0);
  const cancelled = useRef(false);

  const sync = useCallback(async () => {
    const sentAt = performance.now();

    /*
     * A failed sync is survivable and must stay silent.
     *
     * The clock is decoration over a map that renders perfectly well without it,
     * so a dropped request should cost the chip and nothing else — and it must
     * not reject, because an unhandled rejection from a timer is a page-level
     * error for something nobody needed. Any existing anchor is kept and keeps
     * running; the next interval tries again.
     */
    let clock;
    try {
      clock = await fetchWorldClock();
    } catch {
      return;
    }
    if (cancelled.current || clock === null) return;

    const receivedAt = performance.now();
    setAnchor({
      inGameMs: Date.parse(clock.inGameTime),
      speedMultiplier: clock.speedMultiplier,
      monotonicAtSync: receivedAt,
      /*
       * Half the round trip, as the usual estimate of one-way latency. It is
       * worth the line rather than being ignored: at 2× on a slow connection the
       * response is already a few hundred in-game milliseconds stale by the time
       * it arrives, and the correction costs nothing.
       */
      transitMs: (receivedAt - sentAt) / 2,
    });
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void sync();
    const timer = globalThis.setInterval(() => void sync(), SYNC_INTERVAL_MS);
    return () => {
      cancelled.current = true;
      globalThis.clearInterval(timer);
    };
  }, [sync]);

  // One re-render a second, which is what a clock showing minutes needs to change
  // on time without being visibly late. It does not cost a layer rebuild: the
  // renderer buckets this to the in-game minute before the day/night field sees
  // it, so deck.gl only hears from it when the minute actually changes.
  useEffect(() => {
    if (anchor === null) return;
    const timer = globalThis.setInterval(() => setTick((n) => n + 1), 1000);
    return () => globalThis.clearInterval(timer);
  }, [anchor]);

  if (anchor === null) return { inGameTime: null, speedMultiplier: null };

  const realElapsedMs = performance.now() - anchor.monotonicAtSync + anchor.transitMs;
  return {
    inGameTime: new Date(anchor.inGameMs + anchor.speedMultiplier * realElapsedMs),
    speedMultiplier: anchor.speedMultiplier,
  };
}
