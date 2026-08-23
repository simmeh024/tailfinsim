import { describe, expect, it } from 'vitest';

import { COARSE_LAND, LAND_DETAIL_ZOOM, loadDetailedLand, unwrapAntimeridian } from './land';

/**
 * The coastline data (App. H.2).
 *
 * Two things matter here and neither is about GeoJSON in general: that no ring
 * jumps the antimeridian, because one that does draws a line around the world; and
 * that the finer tier is genuinely finer and genuinely optional.
 */

function ringsOf(geojson: unknown): number[][][] {
  const rings: number[][][] = [];
  const collect = (geometry: { type: string; coordinates: unknown }) => {
    if (geometry.type === 'Polygon') rings.push(...(geometry.coordinates as number[][][]));
    else if (geometry.type === 'MultiPolygon')
      for (const polygon of geometry.coordinates as number[][][][]) rings.push(...polygon);
  };
  const value = geojson as {
    features?: { geometry: { type: string; coordinates: unknown } }[];
    geometry?: { type: string; coordinates: unknown };
  };
  if (value.features) for (const shape of value.features) collect(shape.geometry);
  else if (value.geometry) collect(value.geometry);
  return rings;
}

/** Every ring's midpoint, which recentring has to keep inside the real world. */
const midpointsOf = (rings: number[][][]) =>
  rings.map((ring) => {
    let min = Infinity;
    let max = -Infinity;
    for (const point of ring) {
      min = Math.min(min, point[0] ?? 0);
      max = Math.max(max, point[0] ?? 0);
    }
    return (min + max) / 2;
  });

const jumpsIn = (rings: number[][][]) =>
  rings.flatMap((ring) =>
    ring
      .map((point, index) =>
        index === 0 ? 0 : Math.abs((point[0] ?? 0) - (ring[index - 1]?.[0] ?? 0)),
      )
      .filter((delta) => delta > 180),
  );

describe('unwrapping the antimeridian', () => {
  it('makes a crossing ring contiguous and leaves an ordinary one alone', () => {
    const crossing = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [179, 60],
            [-180, 61],
            [-179, 62],
            [179, 60],
          ],
        ],
      },
    };
    unwrapAntimeridian(crossing);
    // The same three points, now without a 360-degree step between them.
    expect(crossing.geometry.coordinates[0]).toEqual([
      [179, 60],
      [180, 61],
      [181, 62],
      [179, 60],
    ]);

    const ordinary = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 50],
            [12, 51],
            [11, 52],
            [10, 50],
          ],
        ],
      },
    };
    unwrapAntimeridian(ordinary);
    expect(ordinary.geometry.coordinates[0]).toEqual([
      [10, 50],
      [12, 51],
      [11, 52],
      [10, 50],
    ]);
  });

  it('leaves no jump in the coarse tier', () => {
    const rings = ringsOf(COARSE_LAND);
    expect(rings.length).toBeGreaterThan(100);
    expect(jumpsIn(rings), 'consecutive coastline vertices 360 degrees apart').toEqual([]);
  });

  it('recentres a ring whose carry displaced it by a whole world', () => {
    /*
     * The regression this exists for. Unwrapping starts its carry at zero on the
     * *first* vertex, so where a ring happens to begin decides where it lands.
     * Afro-Eurasia's outline starts just west of the antimeridian, and without
     * recentring the whole landmass came out at -377.6..-169.9 — contiguous, no
     * jumps, and a whole world west of where it belongs. The globe did not care;
     * the flat map lost Africa, Europe and Asia.
     */
    const crossingFirst = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-179, 60],
            [179, 61],
            [170, 62],
            [-179, 60],
          ],
        ],
      },
    };
    unwrapAntimeridian(crossingFirst);
    const ring = crossingFirst.geometry.coordinates[0] ?? [];
    // Contiguous...
    expect(jumpsIn([ring])).toEqual([]);
    // ...and back in the world it came from, rather than one to the west.
    expect(ring).toEqual([
      [181, 60],
      [179, 61],
      [170, 62],
      [181, 60],
    ]);
  });

  it('leaves every ring of both tiers centred on the real world', async () => {
    for (const [name, geometry] of [
      ['coarse', COARSE_LAND],
      ['detailed', await loadDetailedLand()],
    ] as const) {
      const midpoints = midpointsOf(ringsOf(geometry));
      const stray = midpoints.filter((m) => m < -180 || m > 180);
      expect(stray, `${name} rings displaced by whole worlds`).toEqual([]);
    }
  });
});

describe('the detailed tier', () => {
  it('is finer than the coarse one, and unwrapped the same way', async () => {
    const detailed = await loadDetailedLand();
    const coarseVertices = ringsOf(COARSE_LAND).reduce((total, ring) => total + ring.length, 0);
    const detailedVertices = ringsOf(detailed).reduce((total, ring) => total + ring.length, 0);

    // The whole reason it exists. If a dependency bump ever pointed both tiers at
    // the same file, the coastline would silently stop sharpening on zoom.
    expect(detailedVertices).toBeGreaterThan(coarseVertices * 2);
    expect(jumpsIn(ringsOf(detailed))).toEqual([]);
  });

  it('is fetched once and shared', async () => {
    // The camera crosses the zoom threshold repeatedly; the chunk downloads once.
    const [first, second] = await Promise.all([loadDetailedLand(), loadDetailedLand()]);
    expect(first).toBe(second);
    expect(await loadDetailedLand()).toBe(first);
  });

  it('does not load before the camera needs it', () => {
    // A threshold above the default camera, or the split buys nothing: every first
    // paint would pull the larger file anyway.
    expect(LAND_DETAIL_ZOOM).toBeGreaterThan(0.35);
  });
});
