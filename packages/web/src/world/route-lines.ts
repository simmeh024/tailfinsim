import { canonical, flatPath, trackPath } from './flight';

import type { WorldRoute } from './layers';
import type { RgbaColor } from './palette';
import type { LngLat } from './terminator';

/**
 * The player's own route lines, encoded the way App. H.3 asks (world map pass).
 *
 * > | Encoding | Meaning |
 * > |---|---|
 * > | **Thickness** | Weekly frequency |
 * > | **Opacity** | Load factor — busy routes glow, weak ones fade |
 * > | **Dashed** | Seasonal or suspended |
 *
 * M7-03 drew every route at one width and one opacity and deferred all three,
 * because `/api/world/map` carried none of the numbers. It carries them now, so
 * this turns them into geometry. Colour is still the altitude ramp — the
 * FlightRadar reading M7-03 chose over §H.3's *"your brand colour"*; see
 * `docs/world-renderer.md`.
 *
 * Pure, so the encodings are tested without a GPU, and memoised by the caller.
 */

/** One drawn line: a city pair the player flies, or one dash of a suspended one. */
export interface RouteLine {
  /** The unordered city pair, with `#n` for the dashes of a suspended pair. */
  id: string;
  /** Every route behind the line — usually an out-and-back's two legs. */
  routeIds: string[];
  /** `[lng, lat, …]`, already normalised; see the route layer in `layers.ts`. */
  path: Float64Array;
  /** One colour per vertex of `path`: the altitude ramp at the line's opacity. */
  colors: RgbaColor[];
  /** Pixels, from the weekly frequency. */
  width: number;
  suspended: boolean;
}

/** A line whose frequency is not known — a client ahead of its server, or a test. */
export const UNKNOWN_ROUTE_WIDTH = 3;
/** A pair nothing is scheduled on: present, and as thin as a line gets. */
export const MIN_ROUTE_WIDTH = 2;
export const MAX_ROUTE_WIDTH = 7;

/**
 * §H.3's thickness, from departures a week.
 *
 * Logarithmic, because frequency spans two orders of magnitude and a linear
 * scale would make every long-haul route a hairline beside one shuttle. Roughly:
 * nothing scheduled 2 px, twice a week 3.3, daily 4.3, twice daily 5.5, four
 * times daily 6.9, and the ceiling beyond that.
 */
export function routeWidthForFrequency(weekly: number | undefined): number {
  if (weekly === undefined || !Number.isFinite(weekly)) return UNKNOWN_ROUTE_WIDTH;
  const width = MIN_ROUTE_WIDTH + 1.25 * Math.log2(1 + Math.max(0, weekly) / 2);
  return Math.min(MAX_ROUTE_WIDTH, width);
}

/**
 * The faintest a flown route is drawn, at a load factor of zero.
 *
 * A floor rather than zero because a route the player is losing money on is the
 * one they most need to find: "weak ones fade", not "weak ones disappear".
 */
export const ROUTE_OPACITY_FLOOR = 0.4;

/**
 * §H.3's opacity, from the load factor.
 *
 * Unknown — nothing has settled on the route yet, which is every route on a node
 * with no worker — is drawn at full strength, exactly as the line was before it
 * carried any encoding: a route the world has not flown yet has not been shown
 * to be weak.
 */
export function routeOpacityForLoad(loadFactor: number | null | undefined): number {
  if (loadFactor === undefined || loadFactor === null || !Number.isFinite(loadFactor)) return 1;
  const clamped = Math.min(1, Math.max(0, loadFactor));
  return ROUTE_OPACITY_FLOOR + (1 - ROUTE_OPACITY_FLOOR) * clamped;
}

/** Whether anything is scheduled to fly a route — which is what the shimmer shows. */
export function routeIsFlown(route: WorldRoute): boolean {
  return route.active !== false && route.weeklyFrequency !== 0;
}

/**
 * Dash and gap, in segments of a 64-segment track; scaled for the 32 of reduced
 * quality. A dash is a fixed share of the leg rather than of the screen, so a
 * suspended long-haul and a suspended shuttle both read as dashed at the zoom
 * they are looked at.
 */
const DASH_SEGMENTS_PER_64 = 3;
const GAP_SEGMENTS_PER_64 = 2;

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The lines to draw for the player's routes, one per city pair.
 *
 * A pair, not a route: an out-and-back is two routes on one track (see
 * `TrackKey` in `flight.ts`), and two translucent lines on top of each other
 * would composite to a brighter one, so opacity would stop meaning load factor
 * exactly where the network is busiest. The pair takes the busier direction's
 * frequency — "daily" is how a service is described, whichever way you count —
 * the mean of the directions' load factors that are known, and is suspended only
 * when every direction is.
 */
export function routeLines(
  routes: readonly WorldRoute[],
  segments: number,
  ramp: readonly RgbaColor[],
): RouteLine[] {
  const pairs = new Map<string, { source: LngLat; target: LngLat; members: WorldRoute[] }>();
  for (const route of routes) {
    const { key, reversed } = canonical(route.source, route.target);
    let pair = pairs.get(key);
    if (pair === undefined) {
      pair = reversed
        ? { source: route.target, target: route.source, members: [] }
        : { source: route.source, target: route.target, members: [] };
      pairs.set(key, pair);
    }
    pair.members.push(route);
  }

  const lines: RouteLine[] = [];
  for (const [key, { source, target, members }] of pairs) {
    const frequencies = members.flatMap((m) =>
      m.weeklyFrequency === undefined ? [] : [m.weeklyFrequency],
    );
    const loads = members.flatMap((m) => (typeof m.loadFactor === 'number' ? [m.loadFactor] : []));
    const suspended = members.every((m) => m.active === false);
    const width = routeWidthForFrequency(
      frequencies.length === 0 ? undefined : Math.max(...frequencies),
    );
    const opacity = routeOpacityForLoad(loads.length === 0 ? null : mean(loads));
    const path = flatPath(trackPath(source, target, '', segments));
    const colors = ramp.map(([r, g, b, a]): RgbaColor => [r, g, b, Math.round(a * opacity)]);
    const routeIds = members.map((m) => m.id);

    if (!suspended) {
      lines.push({ id: key, routeIds, path, colors, width, suspended });
      continue;
    }

    const points = path.length / 2;
    const dash = Math.max(1, Math.round((segments * DASH_SEGMENTS_PER_64) / 64));
    const gap = Math.max(1, Math.round((segments * GAP_SEGMENTS_PER_64) / 64));
    for (let start = 0, n = 0; start < points - 1; start += dash + gap, n += 1) {
      const end = Math.min(points - 1, start + dash);
      lines.push({
        id: `${key}#${String(n)}`,
        routeIds,
        path: path.slice(start * 2, (end + 1) * 2),
        colors: colors.slice(start, end + 1),
        width,
        suspended,
      });
    }
  }
  return lines;
}
