import { feature } from 'topojson-client';
import coarseTopology from 'world-atlas/land-110m.json';

import type { GeometryCollection, Topology } from 'topojson-specification';

/**
 * The coastlines, at two resolutions (App. H.2).
 *
 * Natural Earth's land outline, bundled rather than fetched: §21's renderer
 * contacts no basemap or tile service at runtime, so the world draws without an
 * API key or a third party being up. That decision is kept here — the finer tier
 * is a **code-split chunk from this same origin**, not a request to anyone.
 *
 * ## Two tiers, because one cannot be both
 *
 * `110m` is 1:110,000,000, roughly a degree between vertices. Whole-globe views
 * are indistinguishable from finer data at that scale and it costs 54 KB. Zoom in
 * and the same data is unmistakable: the Mediterranean coast becomes a handful of
 * straight multi-degree segments.
 *
 * `50m` is a little over twice as detailed and ten times the bytes — 533 KB, which
 * is a third of the entire client bundle for something most sessions never zoom in
 * far enough to see. So it is loaded on demand, once, the first time the camera
 * goes past {@link LAND_DETAIL_ZOOM}, and kept for the rest of the session.
 *
 * `10m` exists and is 3 MB. That is a tile service's job, not a bundle's.
 */

/** Any GeoJSON the land layer can render. Deliberately loose; only deck.gl reads it. */
export type LandGeometry = ReturnType<typeof feature>;

/**
 * The zoom at which the coarse outline stops being good enough.
 *
 * Around here a degree of longitude is tens of pixels rather than a few, which is
 * the point at which `110m`'s straight segments read as facets rather than as
 * coastline.
 */
export const LAND_DETAIL_ZOOM = 1.6;

/**
 * Undo the antimeridian jumps in a land dataset.
 *
 * Both tiers store longitudes in `[-180, 180]`, so a coastline crossing the
 * antimeridian has two consecutive vertices like `179.99` and `-180`. Neighbours
 * on a sphere; **360 degrees apart in the coordinate space the layers tessellate
 * in** — so the coastline `PathLayer` draws a segment sweeping the entire way
 * round the world, which on the globe lands as a large smooth arc across the
 * Arctic with no coastline under it.
 *
 * `110m` has seven such jumps: Eurasia twice at Chukotka (65N and 69N), Wrangel
 * Island, Fiji twice, and Antarctica. The northern ones are why the artefact
 * appears around the North Pole. `50m` has its own set, so both tiers go through
 * this.
 *
 * Unwrapping carries a multiple of 360 along each ring so no step exceeds 180
 * degrees. A ring may then legitimately run past 180 — `179.99, 180.01` rather
 * than `179.99, -179.99` — which is the same point on a sphere, and on the flat
 * map `repeat: true` already draws the neighbouring world copy.
 *
 * `wrapLongitude` on the layer does **not** do this, which was worth finding out
 * by trying it: it shifts whole paths for Web Mercator and leaves the jump inside
 * the ring untouched.
 */
function unwrapRing(ring: number[][]): number[][] {
  let offset = 0;
  const unwrapped: number[][] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const longitude = ring[index]?.[0] ?? 0;
    if (index > 0) {
      const previous = unwrapped[index - 1]?.[0] ?? 0;
      const delta = longitude + offset - previous;
      if (delta > 180) offset -= 360;
      else if (delta < -180) offset += 360;
    }
    unwrapped.push([longitude + offset, ring[index]?.[1] ?? 0]);
  }
  return unwrapped;
}

/** Exported for the test that asserts no ring jumps the antimeridian. */
export function unwrapAntimeridian<T>(geojson: T): T {
  const walk = (geometry: { type: string; coordinates: unknown }): void => {
    if (geometry.type === 'Polygon') {
      geometry.coordinates = (geometry.coordinates as number[][][]).map(unwrapRing);
    } else if (geometry.type === 'MultiPolygon') {
      geometry.coordinates = (geometry.coordinates as number[][][][]).map((polygon) =>
        polygon.map(unwrapRing),
      );
    }
  };

  const value = geojson as unknown as {
    features?: { geometry: { type: string; coordinates: unknown } }[];
    geometry?: { type: string; coordinates: unknown };
  };
  if (value.features) for (const shape of value.features) walk(shape.geometry);
  else if (value.geometry) walk(value.geometry);
  return geojson;
}

function land(topology: unknown): LandGeometry {
  const typed = topology as Topology<{ land: GeometryCollection }>;
  return unwrapAntimeridian(feature(typed, typed.objects.land));
}

/** Always available, and what every first paint draws. */
export const COARSE_LAND: LandGeometry = land(coarseTopology);

let detailed: LandGeometry | undefined;
let inFlight: Promise<LandGeometry> | undefined;

/**
 * The finer coastline, fetched from this origin as a code-split chunk.
 *
 * Idempotent and cached: the promise is shared, so a camera that crosses the zoom
 * threshold repeatedly downloads once. A failure resolves to the coarse outline
 * rather than rejecting — a chunk that will not load should cost detail, not the
 * whole world view, and the renderer has no way to tell a player to retry.
 */
export async function loadDetailedLand(): Promise<LandGeometry> {
  if (detailed) return detailed;
  inFlight ??= import('world-atlas/land-50m.json')
    .then((module) => {
      detailed = land(module.default);
      return detailed;
    })
    .catch(() => COARSE_LAND);
  return inFlight;
}

/** For tests; there is no reason to call this in the app. */
export function resetDetailedLand(): void {
  detailed = undefined;
  inFlight = undefined;
}
