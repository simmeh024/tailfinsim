import { useEffect, useRef, useState } from 'react';

import { fetchWorldMap, type WorldMapData } from './map-api';

/**
 * The player's overlay, kept current while the page is open (WORLD-06).
 *
 * ## What it was
 *
 * One `fetch` in a mount effect. No interval, no refetch, no visibility
 * listener. So a World page left open on a 2× world showed the world as it was
 * when the tab opened: NPC carriers opened routes in their weekly review,
 * schedules materialised into flights, the player's own routes changed in
 * another tab, and none of it appeared until you navigated away and back.
 *
 * ## The clock is the precedent
 *
 * `useWorldClock` already reasons about exactly this and lands on a periodic
 * resync, for the case that matters rather than for freshness in general: an
 * open tab that would otherwise never hear about a change. This is the same
 * shape at a shorter interval, because a route appearing is more frequent and
 * more visible than a speed change.
 *
 * ## Three things it does not do
 *
 * **It does not poll a hidden tab.** A backgrounded tab spends nothing, and
 * catches up the moment it is looked at — which is also when a stale map would
 * first be noticed.
 *
 * **It does not blank the map on a failed refresh.** `fetchWorldMap` answers
 * `null` for *unknown* and an empty overlay only for the real answers (no
 * session, no airline), so a dropped request keeps the last good overlay. The
 * alternative is a network that vanishes for a minute whenever a request is
 * lost.
 *
 * **It does not hand back a new object for an unchanged world.** The identity
 * is what the renderer's memos key on, so a fresh array every minute would
 * rebuild every layer on a map where nothing had happened.
 */

/**
 * How often, in real milliseconds.
 *
 * Wall clock rather than game time, deliberately: this is about how stale the
 * *screen* is, and a reader's patience does not run at world speed. A minute is
 * short enough that a route opened on another page appears while you are still
 * looking for it, and long enough to be nothing next to the read budget.
 */
export const OVERLAY_REFRESH_MS = 60_000;

function hidden(): boolean {
  return globalThis.document?.visibilityState === 'hidden';
}

/**
 * Nothing drawn yet.
 *
 * Its own literal rather than `map-api`'s, and that is deliberate: a test that
 * mocks `./map-api` replaces the whole module, and a hook importing a *value*
 * from it would then start with `undefined` and crash on the first render. The
 * two zeroes are independent, not one shared constant.
 */
const NOTHING_YET: WorldMapData = { hubs: [], routes: [], traffic: [] };

export function useWorldOverlay(): WorldMapData {
  const [map, setMap] = useState<WorldMapData>(NOTHING_YET);
  /** The last payload, as text, so an unchanged world keeps its object identity. */
  const seen = useRef<string | null>(null);

  useEffect(() => {
    let live = true;

    const load = async (): Promise<void> => {
      const data = await fetchWorldMap();
      if (!live || data === null) return;
      const next = JSON.stringify(data);
      if (next === seen.current) return;
      seen.current = next;
      setMap(data);
    };

    void load();

    const timer = globalThis.setInterval(() => {
      if (!hidden()) void load();
    }, OVERLAY_REFRESH_MS);

    const onVisibilityChange = (): void => {
      if (!hidden()) void load();
    };
    globalThis.document?.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      live = false;
      globalThis.clearInterval(timer);
      globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return map;
}
