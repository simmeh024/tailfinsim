import { MAX_ZOOM, MIN_ZOOM } from './camera';

import type { LngLat } from './terminator';

/**
 * §H.2's four zoom bands, and the hand-off into the airport map (M7-07).
 *
 * > *"Zoom is continuous through four bands: **world → region → terminal area →
 * > airport map** (App. B.7), where the airport view is always a stylised 2D
 * > schematic regardless of projection — an apron is a floor plan, not a
 * > landscape."*
 *
 * The first three are ranges of the one camera both projections share; the
 * fourth is not a camera at all. Past the inner edge of the terminal area the
 * world hands over to `AirportMapView`, a DOM schematic drawn over the canvas,
 * and that is what makes the last band projection-independent: nothing about it
 * is deck.gl's, so it is the same floor plan whether the player was on the
 * globe or the flat map a moment before.
 *
 * Everything here is pure — the camera and the airports in, a decision out — so
 * it can be tested without a WebGL context, and so the renderer has nothing to
 * decide for itself.
 *
 * ## Where the edges are, and why
 *
 * In Web Mercator zoom, where a 1,200-pixel-wide stage spans `360 × 1200 /
 * (512 × 2^z)` degrees of longitude:
 *
 * | Band          | Zoom          | A 1,200 px stage spans  | Agrees with                                 |
 * | ------------- | ------------- | ----------------------- | ------------------------------------------- |
 * | world         | below 3.5     | a continent or more     | rival routes bundle into corridors below it |
 * | region        | 3.5 – 8       | a country to a state    | every airport tier is drawn from 5.5        |
 * | terminal area | 8 – 11.5      | ~200 km down to ~20 km  | a TMA, around one city's airports           |
 * | airport map   | from 11.5     | one aerodrome           | the hand-off                                |
 *
 * The world/region edge is `corridorGridForZoom`'s un-bundle zoom on purpose:
 * the whole-world view is the one that bundles. The camera's own ceiling,
 * `MAX_ZOOM`, stays at 12 — the half-level between the hand-off and the ceiling
 * is where the camera finishes its approach while the schematic grows over it.
 */

export type ZoomBand = 'world' | 'region' | 'terminal' | 'airport';

/** The lower edge of each band after `world`, in camera zoom. */
export const REGION_FROM_ZOOM = 3.5;
export const TERMINAL_FROM_ZOOM = 8;
/** Zooming in past this, over an airport the player operates at, opens its airport map. */
export const AIRPORT_HANDOFF_ZOOM = 11.5;

/**
 * Where leaving the airport map puts the camera: the middle of the terminal
 * area, centred on the airport just left.
 *
 * Inside the band rather than at its edge, so the very next scroll tick does not
 * re-enter the schematic the player has just closed — leaving has to feel like
 * a step back, not a flicker.
 */
export const TERMINAL_EXIT_ZOOM = 10;

/**
 * How close to the middle of the stage an airport must be to count as the one
 * the camera is centred on, in screen pixels at the zoom being entered.
 *
 * At the hand-off zoom a pixel is about 30 m on the ground at the equator, so
 * this is a disc a few kilometres across: an aerodrome and its approaches, and
 * never the neighbouring city's airport.
 */
export const HANDOFF_RADIUS_PX = 160;

/** Which band a camera zoom is in. */
export function bandForZoom(zoom: number): ZoomBand {
  if (zoom >= AIRPORT_HANDOFF_ZOOM) return 'airport';
  if (zoom >= TERMINAL_FROM_ZOOM) return 'terminal';
  if (zoom >= REGION_FROM_ZOOM) return 'region';
  return 'world';
}

/** The bands in order, with their camera ranges, for anything that wants to draw a ladder. */
export const ZOOM_BANDS: readonly { band: ZoomBand; from: number; to: number }[] = [
  { band: 'world', from: MIN_ZOOM, to: REGION_FROM_ZOOM },
  { band: 'region', from: REGION_FROM_ZOOM, to: TERMINAL_FROM_ZOOM },
  { band: 'terminal', from: TERMINAL_FROM_ZOOM, to: AIRPORT_HANDOFF_ZOOM },
  { band: 'airport', from: AIRPORT_HANDOFF_ZOOM, to: MAX_ZOOM },
];

/**
 * The airports a player **operates at**: App. B.7's *"zoom from the world map
 * into any airport you operate at"*.
 *
 * Their hubs, and both ends of every route they hold. That is also every
 * airport where the client lets them lease a stand — the Network page's Gates
 * view lists route endpoints and nothing else — so a station where they hold
 * stands is in this set by construction. The one case it misses is a stand still
 * held after its last route was closed; that airport can still be opened from
 * its detail panel, which takes any airport at all.
 *
 * Only these hand off by zooming. Zooming into somebody else's field shows the
 * world at its closest, which is honest: the map is about the player's network,
 * and an apron they have no stand on is a curiosity they can still open
 * deliberately.
 */
export function operatedAirportIcaos(
  hubs: readonly { icao: string }[],
  routes: readonly { originIcao: string; destinationIcao: string }[],
): Set<string> {
  const codes = new Set<string>();
  for (const hub of hubs) codes.add(hub.icao);
  for (const route of routes) {
    codes.add(route.originIcao);
    codes.add(route.destinationIcao);
  }
  return codes;
}

/** Web Mercator y, in degrees, so it can share a scale with longitude. */
function mercatorY(latitude: number): number {
  const clamped = Math.max(-85, Math.min(85, latitude));
  const phi = (clamped * Math.PI) / 180;
  return (Math.log(Math.tan(Math.PI / 4 + phi / 2)) * 180) / Math.PI;
}

/**
 * Screen pixels between two points at a camera zoom, in Web Mercator.
 *
 * The same measure for both projections, deliberately. On the globe a point
 * away from the equator sits a little *closer* to the centre than Mercator says,
 * so the hand-off is if anything more generous there and never stricter — and
 * the decision stays a function of the camera, not of how it is drawn, which is
 * what "works identically in flat and globe" has to mean.
 *
 * Longitude is wrapped, so an airport just across the antimeridian from the
 * camera is measured the short way round.
 */
export function screenDistancePx(a: LngLat, b: LngLat, zoom: number): number {
  const pixelsPerDegree = (512 * 2 ** zoom) / 360;
  const dLng = ((((a[0] - b[0]) % 360) + 540) % 360) - 180;
  const dx = dLng * pixelsPerDegree;
  const dy = (mercatorY(a[1]) - mercatorY(b[1])) * pixelsPerDegree;
  return Math.hypot(dx, dy);
}

export interface HandoffAirport {
  icao: string;
  position: LngLat;
}

export interface HandoffInput<T extends HandoffAirport> {
  /** The camera before this change. */
  previousZoom: number;
  /** The camera after it: where the stage is centred, and how far in. */
  centre: LngLat;
  zoom: number;
  /**
   * True when the controller reports a zoom gesture. It lets a scroll at the
   * camera's ceiling, where the zoom cannot rise any further, still mean
   * "further in" — and only that: a gesture whose zoom fell is a zoom out.
   */
  zoomGesture?: boolean;
  /** The airport under the pointer, if any. It wins over the centre. */
  hovered?: T | null;
  /** Every airport that could be centred on. */
  airports: readonly T[];
  /** The codes that may hand off: see `operatedAirportIcaos`. */
  operated: ReadonlySet<string>;
}

/**
 * Should this camera change open an airport map, and which one?
 *
 * Three conditions, all required:
 *
 *  1. **It is a zoom in.** The zoom rose, or the controller says the gesture was
 *     a zoom. Panning at close range, inertia, a fly-out and the camera a link
 *     or a memory restored at zoom 12 never hand off — opening a schematic
 *     because somebody *arrived* close in would take the world away from a
 *     player who had not asked to leave it.
 *  2. **It reaches the airport band** (`AIRPORT_HANDOFF_ZOOM`).
 *  3. **An airport the player operates at is the subject**: the one under the
 *     pointer — scroll-zoom keeps the point under the cursor fixed, so that is
 *     where the player is aiming — or else the operated airport nearest the
 *     centre of the stage, within `HANDOFF_RADIUS_PX`.
 *
 * Null otherwise, and the camera simply carries on to its ceiling.
 */
export function handoffTarget<T extends HandoffAirport>(input: HandoffInput<T>): T | null {
  /*
   * A gesture counts only when the zoom did not fall: a pinch or scroll *out*
   * is a zoom gesture too, and leaving the close-in band must never open the
   * schematic the player is backing away from.
   */
  const zoomingIn =
    input.zoom > input.previousZoom ||
    (input.zoomGesture === true && input.zoom >= input.previousZoom);
  if (!zoomingIn || input.zoom < AIRPORT_HANDOFF_ZOOM) return null;

  if (input.hovered && input.operated.has(input.hovered.icao)) return input.hovered;

  let best: T | null = null;
  let bestDistance = HANDOFF_RADIUS_PX;
  for (const airport of input.airports) {
    if (!input.operated.has(airport.icao)) continue;
    const distance = screenDistancePx(airport.position, input.centre, input.zoom);
    if (distance <= bestDistance) {
      best = airport;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * An airport code from a link — `/world?airport=EGLL` opens its airport map.
 *
 * Distinct from `?at=`, which flies the world camera to an airport and selects
 * it: one is "show me where Heathrow is", the other is "show me Heathrow's
 * apron". The same plausibility check as `icaoFromSearch`, so a hostile value
 * never reaches a fetch.
 */
export function airportMapFromSearch(params: URLSearchParams): string | null {
  const raw = params.get('airport');
  if (raw === null) return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(code) ? code : null;
}

/** The hint the band indicator shows, or null where saying anything would be noise. */
export function bandHint(band: ZoomBand, operatedCount: number): string | null {
  switch (band) {
    case 'world':
    case 'region':
      return null;
    case 'terminal':
      return operatedCount > 0
        ? 'Terminal area · zoom in on one of your airports for its airport map'
        : 'Terminal area';
    case 'airport':
      return operatedCount > 0
        ? 'Close in · centre one of your airports to open its airport map'
        : 'Close in';
  }
}
