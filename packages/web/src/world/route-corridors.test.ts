import { describe, expect, it } from 'vitest';

import { bundleCorridors, corridorGridForZoom, type CorridorRoute } from './route-corridors';

import type { LngLat } from './terminator';

/**
 * Corridor bundling is pure geometry, so it is checked as geometry: legs between the
 * same regions collapse to one weighted line whichever way round they are flown, and
 * a fine enough grid leaves every leg on its own.
 */
describe('bundleCorridors', () => {
  const ams: LngLat = [4.76, 52.31];
  const ams2: LngLat = [5.2, 52.0]; // a near neighbour of AMS, same coarse cell
  const lhr: LngLat = [-0.46, 51.47];
  const lhr2: LngLat = [-0.2, 51.15];

  it('bundles near-parallel legs between the same regions into one weighted line', () => {
    const routes: CorridorRoute[] = [
      { id: 'a', source: ams, target: lhr },
      { id: 'b', source: ams2, target: lhr2 },
    ];
    const corridors = bundleCorridors(routes, 12);
    expect(corridors).toHaveLength(1);
    expect(corridors[0]!.count).toBe(2);
    expect(corridors[0]!.routeIds.sort()).toEqual(['a', 'b']);
  });

  it('treats A→B and B→A as one corridor, without cancelling the line out', () => {
    const routes: CorridorRoute[] = [
      { id: 'out', source: ams, target: lhr },
      { id: 'back', source: lhr2, target: ams2 },
    ];
    // A 3° grid keeps AMS and LHR in different cells (they are only ~5° apart), so the
    // corridor spans two regions and the A/B alignment has real work to do.
    const corridors = bundleCorridors(routes, 3);
    expect(corridors).toHaveLength(1);
    expect(corridors[0]!.count).toBe(2);
    const { source, target } = corridors[0]!;
    // The averaged ends sit near the two real regions, not collapsed onto each other.
    expect(Math.hypot(source[0] - target[0], source[1] - target[1])).toBeGreaterThan(3);
  });

  it('keeps legs separate once the grid is fine enough', () => {
    const routes: CorridorRoute[] = [
      { id: 'a', source: ams, target: lhr },
      { id: 'b', source: ams2, target: lhr2 },
    ];
    // A tenth of a degree puts each endpoint in its own cell.
    expect(bundleCorridors(routes, 0.1)).toHaveLength(2);
  });

  it('averages members back among the legs they stand for', () => {
    const corridors = bundleCorridors(
      [
        { id: 'a', source: ams, target: lhr },
        { id: 'b', source: ams2, target: lhr2 },
      ],
      12,
    );
    const { source } = corridors[0]!;
    // The A end is the mean of the two AMS-side endpoints.
    expect(source[0]).toBeCloseTo((ams[0] + ams2[0]) / 2, 6);
    expect(source[1]).toBeCloseTo((ams[1] + ams2[1]) / 2, 6);
  });
});

describe('corridorGridForZoom', () => {
  it('bundles coarsely far out and not at all once zoomed in', () => {
    expect(corridorGridForZoom(0)).toBeGreaterThan(corridorGridForZoom(2));
    expect(corridorGridForZoom(3.5)).toBe(0);
    expect(corridorGridForZoom(6)).toBe(0);
  });
});
