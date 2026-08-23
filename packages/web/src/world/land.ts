import { feature, mesh } from 'topojson-client';
import coarseTopology from 'world-atlas/countries-110m.json';

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
 *
 * ## One file per tier, carrying both the coastline and the borders
 *
 * `countries-*.json` holds a `countries` collection **and** the same `land` union
 * that `land-*.json` ships on its own, built from one shared set of arcs. So a
 * tier is one download rather than two, and — the part that actually matters —
 * a border and the coastline it meets are the same arc, so they cannot disagree
 * by a hairline the way two independently simplified files would.
 *
 * The cost is real and modest. Measured on a production build, carrying every
 * country as well as the coastline takes the main bundle from 376 to **395 KB
 * gzip**, and the on-demand tier from 179 to **243 KB gzip**.
 */

/** Any GeoJSON the land layer can render. Deliberately loose; only deck.gl reads it. */
export type LandGeometry = ReturnType<typeof feature>;

/** The country borders, as one line geometry. */
export type BorderGeometry = ReturnType<typeof mesh>;

/** A tier: the coastline and the borders that share its arcs. */
export interface WorldGeometry {
  land: LandGeometry;
  borders: BorderGeometry;
}

type CountriesTopology = Topology<{ countries: GeometryCollection; land: GeometryCollection }>;

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
 * **The carry then has to be recentred, and leaving that out cost the flat map a
 * continent.** The offset starts at zero on the ring's *first* vertex, so where a
 * ring happens to begin decides where the whole ring ends up. Afro-Eurasia's outline
 * starts just west of the antimeridian in Chukotka: the second vertex is 358 degrees
 * east of the first, unwrapping carries −360, and the entire landmass came out at
 * longitude −377.6 to −169.9 instead of −17.6 to 190.1. Coherent, no jumps, passes a
 * jump test — and drawn a whole world to the west, so the globe was fine (a sphere is
 * periodic) while **the flat map simply had no Africa, Europe or Asia on it**, plus a
 * pale sliver of the displaced ring cutting across the Atlantic.
 *
 * So each ring is shifted back by whole worlds until its own midpoint is inside
 * [−180, 180]. That preserves contiguity exactly — every vertex moves by the same
 * multiple of 360 — while putting the ring where it belongs.
 *
 * `wrapLongitude` on the layer does **not** do this, which was worth finding out
 * by trying it: it shifts whole paths for Web Mercator and leaves the jump inside
 * the ring untouched.
 */
function unwrapRing(ring: number[][]): number[][] {
  let offset = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  const unwrapped: number[][] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const longitude = ring[index]?.[0] ?? 0;
    if (index > 0) {
      const previous = unwrapped[index - 1]?.[0] ?? 0;
      const delta = longitude + offset - previous;
      if (delta > 180) offset -= 360;
      else if (delta < -180) offset += 360;
    }
    const carried = longitude + offset;
    if (carried < minimum) minimum = carried;
    if (carried > maximum) maximum = carried;
    unwrapped.push([carried, ring[index]?.[1] ?? 0]);
  }

  /*
   * Recentre: move the whole ring by whole worlds until its midpoint is in range.
   *
   * Only when it is *outside* [-180, 180]. A ring that legitimately straddles the
   * antimeridian sits at, say, 179..181 with a midpoint of exactly 180, and must
   * stay there — rounding it to the nearest world would push it a whole turn west
   * and reintroduce the bug for the rings this whole function exists to fix.
   * Antarctica spans -180..180, midpoint 0, and never moves either.
   */
  const midpoint = (minimum + maximum) / 2;
  const shift =
    midpoint > 180
      ? -360 * Math.ceil((midpoint - 180) / 360)
      : midpoint < -180
        ? 360 * Math.ceil((-180 - midpoint) / 360)
        : 0;
  if (shift !== 0) for (const point of unwrapped) point[0] = (point[0] ?? 0) + shift;
  return unwrapped;
}

/**
 * Exported for the test that asserts nothing jumps the antimeridian.
 *
 * Handles lines as well as rings, because the country borders arrive as a
 * `MultiLineString` and have exactly the same problem — Russia's eastern border
 * meets the antimeridian, and an unwrapped border draws a line round the world
 * just as an unwrapped coastline does. `unwrapRing` does not care that a border
 * is not closed; it carries the offset along whatever sequence it is given.
 */
export function unwrapAntimeridian<T>(geojson: T): T {
  const walk = (geometry: { type: string; coordinates: unknown }): void => {
    switch (geometry.type) {
      case 'LineString':
        geometry.coordinates = unwrapRing(geometry.coordinates as number[][]);
        break;
      case 'Polygon':
      case 'MultiLineString':
        geometry.coordinates = (geometry.coordinates as number[][][]).map(unwrapRing);
        break;
      case 'MultiPolygon':
        geometry.coordinates = (geometry.coordinates as number[][][][]).map((polygon) =>
          polygon.map(unwrapRing),
        );
        break;
      default:
        break;
    }
  };

  const value = geojson as unknown as {
    features?: { geometry: { type: string; coordinates: unknown } }[];
    geometry?: { type: string; coordinates: unknown };
    type?: string;
    coordinates?: unknown;
  };
  if (value.features) for (const shape of value.features) walk(shape.geometry);
  else if (value.geometry) walk(value.geometry);
  // A bare geometry, which is what `mesh` returns — no `Feature` wrapper.
  else if (value.coordinates !== undefined && value.type !== undefined) {
    walk(value as { type: string; coordinates: unknown });
  }
  return geojson;
}

/**
 * The country borders, as one `MultiLineString`.
 *
 * `mesh` with `(a, b) => a !== b` keeps only arcs shared by **two different**
 * countries, which is the whole trick: a coastline arc belongs to one country
 * and is dropped, so the borders never draw over the coastline the land layer
 * already strokes. Drawing every country outline instead would double every
 * coast — twice the geometry, and a visibly heavier line wherever the two
 * happened not to land on the same pixel.
 *
 * One geometry rather than 177 features, because nothing here is per-country:
 * there are no labels, no picking and no fills, so a single path saves deck.gl
 * the work of tessellating each border twice, once for each side.
 */
function borders(typed: CountriesTopology): BorderGeometry {
  return unwrapAntimeridian(mesh(typed, typed.objects.countries, (a, b) => a !== b));
}

function land(typed: CountriesTopology): LandGeometry {
  return unwrapAntimeridian(feature(typed, typed.objects.land));
}

function worldGeometry(topology: unknown): WorldGeometry {
  const typed = topology as CountriesTopology;
  return { land: land(typed), borders: borders(typed) };
}

/** Always available, and what every first paint draws. */
export const COARSE_WORLD: WorldGeometry = worldGeometry(coarseTopology);

let detailed: WorldGeometry | undefined;
let inFlight: Promise<WorldGeometry> | undefined;

/**
 * The finer coastline and borders, fetched from this origin as a code-split chunk.
 *
 * Idempotent and cached: the promise is shared, so a camera that crosses the zoom
 * threshold repeatedly downloads once. A failure resolves to the coarse geometry
 * rather than rejecting — a chunk that will not load should cost detail, not the
 * whole world view, and the renderer has no way to tell a player to retry.
 */
export async function loadDetailedWorld(): Promise<WorldGeometry> {
  if (detailed) return detailed;
  inFlight ??= import('world-atlas/countries-50m.json')
    .then((module) => {
      detailed = worldGeometry(module.default);
      return detailed;
    })
    .catch(() => COARSE_WORLD);
  return inFlight;
}

/** For tests; there is no reason to call this in the app. */
export function resetDetailedWorld(): void {
  detailed = undefined;
  inFlight = undefined;
}
