import { airportCodes } from './hover';

import type { WorldAirport } from './layers';
import type { WorldMapTrafficRoute } from './map-api';

/**
 * What is on the map, as a list (WORLD-08).
 *
 * ## Why a list exists at all
 *
 * Airports and aeroplanes were reachable only through deck.gl's `onClick`. A
 * keyboard could pan and zoom the map — deck's controller has `keyboard: true` —
 * and could not select a single thing on it. There was no focusable
 * representation of any of the four thousand airports, and nothing announced
 * when one was chosen.
 *
 * A canvas cannot be made focusable object by object, so the equivalent is a
 * list beside it: the same things, in the same order the map declutters them,
 * each one selectable. It is the same answer UX-03 gave the planner timeline —
 * and, like that one, it turns out to be quicker than the pointer for anyone who
 * knows what they are looking for.
 *
 * ## Bounded by what is actually drawn
 *
 * "Everything" is four thousand rows. The map already declutters by zoom
 * (`airportLevelForZoom`), so the list starts from the same set — and narrows it
 * again to the camera's own bounds when deck.gl will say what they are, which
 * makes "what is on the map" literal rather than approximate.
 */

/** As many rows as are useful to walk with an arrow key. */
export const PLACE_LIMIT = 60;

export interface PlaceRow {
  /** Unique within the list, and the DOM id it is given. */
  id: string;
  kind: 'airport' | 'flight';
  label: string;
  detail: string;
  /** The thing itself, handed back on selection. */
  airport?: WorldAirport;
  flight?: WorldMapTrafficRoute;
}

/** [west, south, east, north] — deck.gl's own order. */
export type Bounds = [number, number, number, number];

const TIER_ORDER: Record<string, number> = {
  flagship: 0,
  large: 1,
  medium: 2,
  small: 3,
  regional: 4,
};

function tierRank(tier: string): number {
  return TIER_ORDER[tier] ?? 5;
}

/**
 * Whether a point is inside the camera's bounds.
 *
 * Longitude is compared on the circle rather than as a number, because a camera
 * over the Pacific has a western edge greater than its eastern one — and a plain
 * `west <= lng <= east` there excludes everything on screen and includes
 * everything off it, which is exactly backwards.
 */
export function within([lng, lat]: readonly [number, number], bounds: Bounds): boolean {
  const [west, south, east, north] = bounds;
  if (lat < south || lat > north) return false;
  return west <= east ? lng >= west && lng <= east : lng >= west || lng <= east;
}

export function airportRows(
  airports: readonly WorldAirport[],
  bounds: Bounds | null,
  limit = PLACE_LIMIT,
): PlaceRow[] {
  const inView = bounds === null ? airports : airports.filter((a) => within(a.position, bounds));
  return [...inView]
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((airport) => ({
      id: `airport:${airport.icao}`,
      kind: 'airport' as const,
      label: airport.name,
      detail: airportCodes(airport),
      airport,
    }));
}

/**
 * The flights currently drawn, as rows.
 *
 * Only the ones drawn: the ownership toggles decide what is on the map, and a
 * list offering to select something invisible is a worse answer than a short
 * list. The player's own say so rather than repeating their airline name back.
 */
export function flightRows(
  traffic: readonly WorldMapTrafficRoute[],
  limit = PLACE_LIMIT,
): PlaceRow[] {
  return [...traffic]
    .sort(
      (a, b) =>
        Number(b.own) - Number(a.own) ||
        a.airlineName.localeCompare(b.airlineName) ||
        a.originIcao.localeCompare(b.originIcao),
    )
    .slice(0, limit)
    .map((flight) => ({
      id: `flight:${flight.id}`,
      kind: 'flight' as const,
      label: flight.own ? 'Your flight' : flight.airlineName,
      detail: `${flight.originIcao} → ${flight.destinationIcao}`,
      flight,
    }));
}

/**
 * The next row an arrow key should land on.
 *
 * Clamped rather than wrapped, for the reason UX-03 gave the timeline: wrapping
 * turns "I am at the end" into a silent jump to the other end, and the reader
 * has no way to tell that from the list having scrolled.
 */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(length - 1, Math.max(0, current + delta));
}
