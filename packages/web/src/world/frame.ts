import type { LngLat } from './terminator';
import type { MapViewState } from '@deck.gl/core';

/**
 * Framing the camera on the player's own network (WORLD-04).
 *
 * ## The problem
 *
 * `INITIAL_VIEW_STATE` was longitude 8, latitude 24 — the western Sahara — at a
 * whole-globe zoom, for everybody, on every visit. A player whose entire network
 * is in North America landed on West Africa and dragged, every time.
 *
 * ## The maths, briefly
 *
 * Web Mercator: at zoom `z` the whole world is `512 · 2^z` pixels wide and
 * covers 360°, so a viewport `W` pixels wide shows `360 · W / (512 · 2^z)`
 * degrees. Fitting a span `S` therefore wants `z = log2(360 · W / (512 · S))`.
 * Latitude is the same idea against the Mercator projection of the latitudes
 * rather than the latitudes themselves, because a degree near the pole is worth
 * far more pixels than one at the equator. The camera takes whichever of the two
 * is tighter.
 *
 * The globe view is not Mercator, but it is close enough for *framing* — this
 * chooses where to look, and the two projections agree about that at any zoom a
 * network is legible at.
 *
 * ## The antimeridian
 *
 * A network with a leg to Auckland and a leg to Los Angeles has longitudes near
 * both +180 and −180. Taking the plain minimum and maximum makes that look like
 * a span of nearly the whole planet and frames the Atlantic — the empty half.
 * So the span is the smallest arc containing every point: sort the longitudes,
 * find the largest gap between neighbours *around the circle*, and the answer is
 * everything else.
 */

/** Mercator's usable latitude range; beyond it the projection runs away. */
const MAX_LATITUDE = 85;
/** deck.gl's tile size, and the constant in the zoom equation above. */
const WORLD_PIXELS = 512;

/**
 * The stage, when nobody has measured it.
 *
 * The fit runs as soon as the overlay arrives, which can be before deck.gl has
 * reported a viewport — and a camera that waited would leave the player looking
 * at the Sahara for exactly as long as it took. A desktop-shaped default is
 * wrong by a little; the old behaviour was wrong by a hemisphere.
 */
const REFERENCE_VIEWPORT = { width: 1200, height: 800 };

/**
 * Breathing room around the network, as a fraction of the fitted span.
 *
 * Without it the outermost airport sits exactly on the edge of the canvas, half
 * of its dot cut off, and the HUD's own controls cover the corners.
 */
const PADDING = 1.4;

/** A lone hub has no span to fit, so it gets a city-sized view instead. */
const SINGLE_POINT_ZOOM = 5;

export interface Viewport {
  width: number;
  height: number;
}

function mercatorY(latitude: number): number {
  const clamped = Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, latitude));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

/**
 * Longitude normalised to (−180, 180].
 *
 * Returned unchanged when it is already in range. The modular arithmetic below
 * is exact in principle and not in floating point — it turned 8.5622 into
 * 8.562199999999962 — and a camera longitude that does not match the hub it was
 * computed from is the kind of drift that makes a later equality check lie.
 */
function wrap(longitude: number): number {
  if (longitude > -180 && longitude <= 180) return longitude;
  const x = (((longitude + 180) % 360) + 360) % 360;
  return x - 180;
}

interface Arc {
  centre: number;
  span: number;
}

/**
 * The smallest arc of longitude containing every point.
 *
 * The largest gap between neighbours is the part of the circle the network does
 * *not* occupy, so the arc is its complement.
 */
function longitudeArc(longitudes: number[]): Arc {
  const sorted = [...longitudes].map(wrap).sort((a, b) => a - b);
  if (sorted.length === 1) return { centre: sorted[0]!, span: 0 };

  let gapStart = sorted[sorted.length - 1]!;
  let gap = sorted[0]! + 360 - gapStart;
  for (let i = 1; i < sorted.length; i += 1) {
    const between = sorted[i]! - sorted[i - 1]!;
    if (between > gap) {
      gap = between;
      gapStart = sorted[i - 1]!;
    }
  }

  const span = 360 - gap;
  // The arc starts where the gap ends and runs the other way round the circle.
  return { centre: wrap(gapStart + gap + span / 2), span };
}

/**
 * A camera that frames every given point, or `null` when there are none.
 *
 * `null` rather than a default, because "this player has no network yet" is a
 * decision for the caller: a new player should still meet the whole world.
 */
export function frameOf(points: readonly LngLat[], viewport?: Viewport): MapViewState | null {
  if (points.length === 0) return null;

  const { width, height } = viewport ?? REFERENCE_VIEWPORT;
  const safeWidth = width > 0 ? width : REFERENCE_VIEWPORT.width;
  const safeHeight = height > 0 ? height : REFERENCE_VIEWPORT.height;

  const arc = longitudeArc(points.map((p) => p[0]));
  const latitudes = points.map((p) => p[1]);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);

  const lonSpan = arc.span * PADDING;
  const latSpan = (mercatorY(north) - mercatorY(south)) * PADDING;

  const zoomForLongitude =
    lonSpan > 0 ? Math.log2((360 * safeWidth) / (WORLD_PIXELS * lonSpan)) : Infinity;
  // The Mercator y range spans 2π across the whole world.
  const zoomForLatitude =
    latSpan > 0 ? Math.log2((2 * Math.PI * safeHeight) / (WORLD_PIXELS * latSpan)) : Infinity;

  const zoom = Math.min(zoomForLongitude, zoomForLatitude);

  return {
    longitude: arc.centre,
    latitude: (south + north) / 2,
    zoom: Number.isFinite(zoom) ? zoom : SINGLE_POINT_ZOOM,
    pitch: 0,
    bearing: 0,
  };
}

/** Every point a player's network puts on the map: their hubs and both ends of each route. */
export function networkPoints(
  hubs: readonly { position: LngLat }[],
  routes: readonly { source: LngLat; target: LngLat }[],
): LngLat[] {
  return [
    ...hubs.map((hub) => hub.position),
    ...routes.flatMap((route) => [route.source, route.target]),
  ];
}
