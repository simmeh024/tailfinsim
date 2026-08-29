import { describe, expect, it } from 'vitest';

import {
  altitudeProfile,
  bearing,
  flightPath,
  headingAt,
  interpolateGreatCircle,
  planesForRoutes,
  routeSeed,
} from './flight';

import type { LngLat } from './terminator';

/**
 * The plane simulation is pure geometry, so it is checked as geometry: an endpoint
 * maps to itself, a heading points the way the world turns, and every route gets a
 * plane somewhere on its own line.
 */
describe('great-circle interpolation', () => {
  const ams: LngLat = [4.76, 52.31];
  const jfk: LngLat = [-73.78, 40.64];

  it('returns the endpoints at t=0 and t=1', () => {
    const [lon0, lat0] = interpolateGreatCircle(ams, jfk, 0);
    expect(lon0).toBeCloseTo(ams[0], 3);
    expect(lat0).toBeCloseTo(ams[1], 3);
    const [lon1, lat1] = interpolateGreatCircle(ams, jfk, 1);
    expect(lon1).toBeCloseTo(jfk[0], 3);
    expect(lat1).toBeCloseTo(jfk[1], 3);
  });

  it('bows north of the straight line on a mid-latitude westbound leg', () => {
    // The great circle between two northern-hemisphere cities arcs poleward, so the
    // midpoint sits north of the average latitude a straight Mercator line would give.
    const mid = interpolateGreatCircle(ams, jfk, 0.5);
    expect(mid[1]).toBeGreaterThan((ams[1] + jfk[1]) / 2);
  });

  it('handles a degenerate zero-length leg without NaN', () => {
    const p = interpolateGreatCircle(ams, ams, 0.5);
    expect(p[0]).toBeCloseTo(ams[0], 6);
    expect(p[1]).toBeCloseTo(ams[1], 6);
  });
});

describe('bearing', () => {
  it('reads due east and due north', () => {
    expect(bearing([0, 0], [10, 0])).toBeCloseTo(90, 1);
    expect(bearing([0, 0], [0, 10])).toBeCloseTo(0, 1);
    expect(bearing([0, 0], [0, -10])).toBeCloseTo(180, 1);
  });

  it('keeps a heading in [0, 360)', () => {
    const h = headingAt([170, 10], [-170, 12], 0.5);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

describe('altitudeProfile', () => {
  it('is on the ground at both ends and at cruise in the middle', () => {
    expect(altitudeProfile(0)).toBeCloseTo(0, 6);
    expect(altitudeProfile(1)).toBeCloseTo(0, 6);
    expect(altitudeProfile(0.5)).toBe(1);
  });

  it('climbs and descends monotonically at the ends', () => {
    expect(altitudeProfile(0.06)).toBeGreaterThan(altitudeProfile(0.02));
    expect(altitudeProfile(0.94)).toBeGreaterThan(altitudeProfile(0.98));
  });
});

describe('routeSeed', () => {
  it('is stable for an id and differs between ids', () => {
    expect(routeSeed('r1')).toBe(routeSeed('r1'));
    expect(routeSeed('r1')).not.toBe(routeSeed('r2'));
  });
});

describe('flightPath', () => {
  const ams: LngLat = [4.76, 52.31];
  const nce: LngLat = [7.22, 43.66];

  it('anchors the endpoints exactly and samples segments+1 points', () => {
    const path = flightPath(ams, nce, routeSeed('r1'), 32);
    expect(path).toHaveLength(33);
    expect(path[0]![0]).toBeCloseTo(ams[0], 6);
    expect(path[0]![1]).toBeCloseTo(ams[1], 6);
    expect(path[32]![0]).toBeCloseTo(nce[0], 6);
    expect(path[32]![1]).toBeCloseTo(nce[1], 6);
  });

  it('is deterministic for a seed and varies between seeds', () => {
    const a = flightPath(ams, nce, routeSeed('r1'), 32);
    const b = flightPath(ams, nce, routeSeed('r1'), 32);
    expect(b).toEqual(a);
    const c = flightPath(ams, nce, routeSeed('r2'), 32);
    // Different seed → a different track (the interior differs even if the ends match).
    const mid = 16;
    expect(c[mid]).not.toEqual(a[mid]);
  });

  it('wanders off the great circle in the middle but not at the ends', () => {
    const seed = routeSeed('wandering');
    const path = flightPath(ams, nce, seed, 64);
    const gcMid = interpolateGreatCircle(ams, nce, 0.5);
    const mid = path[32]!;
    const drift = Math.hypot(mid[0] - gcMid[0], mid[1] - gcMid[1]);
    // A real, non-zero lateral offset at mid-leg, but small — degrees, not a detour.
    expect(drift).toBeGreaterThan(0.001);
    expect(drift).toBeLessThan(2);
  });
});

describe('planesForRoutes', () => {
  const routes = [
    { id: 'r1', source: [4.76, 52.31] as LngLat, target: [-73.78, 40.64] as LngLat },
    { id: 'r2', source: [2.55, 49.01] as LngLat, target: [13.29, 52.56] as LngLat },
  ];

  it('places one plane per route, on the route line, with a finite heading', () => {
    const planes = planesForRoutes(routes, 0.25, 1);
    expect(planes).toHaveLength(2);
    for (const plane of planes) {
      expect(Number.isFinite(plane.position[0])).toBe(true);
      expect(Number.isFinite(plane.position[1])).toBe(true);
      expect(Number.isFinite(plane.angle)).toBe(true);
    }
  });

  it('tags each plane with the route it flies, so a click finds the carrier', () => {
    const planes = planesForRoutes(routes, 0.25, 1);
    expect(planes.map((p) => p.sourceId)).toEqual(['r1', 'r2']);
    // A staggered pair still both belong to their one route.
    const pair = planesForRoutes([routes[0]!], 0, 2);
    expect(pair.map((p) => p.sourceId)).toEqual(['r1', 'r1']);
  });

  it('moves the plane as the phase advances', () => {
    const a = planesForRoutes(routes, 0.1, 1)[0]!.position;
    const b = planesForRoutes(routes, 0.6, 1)[0]!.position;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(1);
  });

  it('staggers multiple planes along one route', () => {
    const planes = planesForRoutes([routes[0]!], 0, 2);
    expect(planes).toHaveLength(2);
    expect(planes[0]!.position).not.toEqual(planes[1]!.position);
  });
});
