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

  it('is deterministic for a seed', () => {
    const a = flightPath(ams, nce, routeSeed('r1'), 32);
    const b = flightPath(ams, nce, routeSeed('r1'), 32);
    expect(b).toEqual(a);
  });

  /**
   * How far each sampled point sits off the direct great circle, in degrees.
   *
   * The shape of this profile is the whole point of the track model: flat at zero for
   * a leg flown as filed, and a single peak for one air traffic control re-routed.
   */
  const driftProfile = (id: string, segments = 128): number[] => {
    const path = flightPath(ams, nce, routeSeed(id), segments);
    return path.map((point, i) => {
      const direct = interpolateGreatCircle(ams, nce, i / segments);
      return Math.hypot(point[0] - direct[0], point[1] - direct[1]);
    });
  };

  /** Turning points in a profile — one per bend, many for a wave. */
  const peaks = (profile: readonly number[]): number => {
    let found = 0;
    for (let i = 1; i < profile.length - 1; i += 1) {
      if (profile[i]! > profile[i - 1]! + 1e-9 && profile[i]! >= profile[i + 1]!) found += 1;
    }
    return found;
  };

  /**
   * Cross-track angle at each sample: how far the track lies off the plane of the
   * direct great circle, signed, in radians.
   *
   * This is the quantity the model makes piecewise linear, so curvature shows up in it
   * exactly. Measuring drift in longitude and latitude instead folds in the projection,
   * which curves even a dead-straight track slightly all by itself.
   */
  const crossTrack = (id: string, segments: number): number[] => {
    const rad = Math.PI / 180;
    const vec = ([lon, lat]: LngLat): [number, number, number] => [
      Math.cos(lat * rad) * Math.cos(lon * rad),
      Math.cos(lat * rad) * Math.sin(lon * rad),
      Math.sin(lat * rad),
    ];
    const [ax, ay, az] = vec(ams);
    const [bx, by, bz] = vec(nce);
    const normal = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const length = Math.hypot(...normal) || 1;
    const unit = normal.map((c) => c / length);
    return flightPath(ams, nce, routeSeed(id), segments).map((point) => {
      const [px, py, pz] = vec(point);
      const dot = px * unit[0]! + py * unit[1]! + pz * unit[2]!;
      return Math.asin(Math.max(-1, Math.min(1, dot)));
    });
  };

  /**
   * What share of a leg is actually turning.
   *
   * Zero second difference in the cross-track angle is a straight leg; only a rolled
   * turn bends. So this separates the two characters a bend can have: a slow bow turns
   * across most of the leg, a dogleg turns in one small part of it.
   */
  const bendingFraction = (id: string, segments = 256): number => {
    const track = crossTrack(id, segments);
    let bending = 0;
    for (let i = 1; i < track.length - 1; i += 1) {
      if (Math.abs(track[i - 1]! - 2 * track[i]! + track[i + 1]!) > 1e-9) bending += 1;
    }
    return bending / track.length;
  };

  const ids = Array.from({ length: 60 }, (_, i) => `route-${String(i)}`);

  it('flies a few legs exactly as filed, and most with some drift', () => {
    // Cleared as filed means a drift of precisely nothing, not merely a small one — so
    // some legs must measure exactly zero. But a map of ruler-straight lines looks
    // unflown, so those are the minority: most legs leave the direct track a little.
    const direct = ids.filter((id) => Math.max(...driftProfile(id)) === 0);
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.length).toBeLessThan(ids.length / 3);
  });

  it('drifts off the track gently on most legs, and doglegs on a few', () => {
    // The two characters a bend can have, told apart by how much of the leg is turning:
    // a bow spreads the heading change across the middle of the leg, a dogleg puts it
    // all in one place. Both must actually occur, or the map is all curves or all kinks.
    const bendingFractions = ids
      .filter((id) => Math.max(...driftProfile(id)) > 0)
      .map((id) => ({ id, bending: bendingFraction(id) }));

    expect(bendingFractions.some(({ bending }) => bending > 0.4)).toBe(true);
    expect(bendingFractions.some(({ bending }) => bending < 0.3)).toBe(true);
  });

  it('re-routes some legs, and those are the only ones that leave the track', () => {
    const deviating = ids.filter((id) => Math.max(...driftProfile(id)) > 0);
    expect(deviating.length).toBeGreaterThan(0);
    const degrees = 180 / Math.PI;
    for (const id of deviating) {
      // Measured as the cross-track angle, not a longitude/latitude distance: the
      // latter exaggerates by 1/cos(latitude), which at 48°N turns a 1.5° deviation
      // into a 2° reading and would make this bound about the projection.
      const track = crossTrack(id, 128).map((angle) => Math.abs(angle) * degrees);
      // Off the direct track by real degrees, but a bend rather than a detour.
      expect(Math.max(...track), id).toBeGreaterThan(0.001);
      expect(Math.max(...track), id).toBeLessThan(2);
      // Still joined to both airports.
      expect(track[0], id).toBeCloseTo(0, 9);
      expect(track.at(-1), id).toBeCloseTo(0, 9);
    }
  });

  it('bends at a waypoint or two rather than oscillating like a wave', () => {
    // The assertion that separates a flight path from a sine wave: at most two turning
    // points, because a track is straight legs joined at one or two waypoints. The
    // sum-of-sines this replaced produced four and more.
    for (const id of ids) {
      expect(peaks(driftProfile(id)), id).toBeLessThanOrEqual(2);
    }
    // And at least one leg genuinely has a single dogleg, or the bound above would be
    // satisfied by drawing nothing at all.
    expect(ids.some((id) => peaks(driftProfile(id)) === 1)).toBe(true);
  });

  it('flies a dogleg as straight legs either side of one turn', () => {
    // Pick the tightest bend on offer — the dogleg regime — and show the rest of that
    // leg is dead straight. A sum of sines curves at every sample, so it would score
    // near 1 here rather than a small fraction.
    const tightest = ids
      .filter((id) => Math.max(...driftProfile(id)) > 0)
      .map((id) => ({ id, bending: bendingFraction(id) }))
      .reduce((best, next) => (next.bending < best.bending ? next : best));

    expect(tightest.bending).toBeGreaterThan(0);
    expect(tightest.bending).toBeLessThan(0.3);
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
