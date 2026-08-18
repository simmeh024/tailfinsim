import { describe, expect, it } from 'vitest';

import { haversineNm } from '../distance';

import { isTerminal, planFlight, reduce, type FlightState } from './machine';
import {
  type AirportLookup,
  type AirportPoint,
  type Coordinates,
  greatCirclePath,
  initialBearingDeg,
  interpolatePosition,
  slerp,
  unwrapLongitudes,
} from './position';
import { DEFAULT_FLIGHT_PROFILE, DEFAULT_TURNAROUND_MINUTES, type FlightProfile } from './profile';
import { addMinutes, type FlightPlan, type PhaseWindow } from './timeline';

/**
 * Position interpolation.
 *
 * The headline case is NRT–LAX, because it is the one that goes wrong: the two
 * airports sit either side of the antimeridian, and any implementation that
 * interpolates longitude arithmetically sends the aircraft the long way round
 * the planet.
 */

const PROFILE: FlightProfile = DEFAULT_FLIGHT_PROFILE;
const CREATED = new Date('2024-10-20T00:00:00.000Z');
const OFF_BLOCKS = new Date('2024-10-20T08:00:00.000Z');

const AIRPORTS: Record<string, AirportPoint> = {
  RJAA: { latitudeDeg: 35.7647, longitudeDeg: 140.3863, elevationFt: 141 },
  KLAX: { latitudeDeg: 33.9425, longitudeDeg: -118.4081, elevationFt: 125 },
  EHAM: { latitudeDeg: 52.3086, longitudeDeg: 4.7639, elevationFt: -11 },
  KJFK: { latitudeDeg: 40.6398, longitudeDeg: -73.7789, elevationFt: 13 },
  BIKF: { latitudeDeg: 63.985, longitudeDeg: -22.6056, elevationFt: 171 },
  KDEN: { latitudeDeg: 39.8617, longitudeDeg: -104.6731, elevationFt: 5431 },
};

const lookup: AirportLookup = (icao) => AIRPORTS[icao];

function plan(overrides: Partial<FlightPlan> = {}): FlightPlan {
  return {
    originIcao: 'EHAM',
    destinationIcao: 'KJFK',
    distanceNm: 3157,
    cruiseSpeedKt: 480,
    cruiseAltitudeFt: 35_000,
    createdAt: CREATED,
    scheduledDeparture: OFF_BLOCKS,
    turnaroundMinutes: DEFAULT_TURNAROUND_MINUTES,
    ...overrides,
  };
}

/** NRT–LAX: 4,750 nm across the Pacific, over the antimeridian. */
function transpacific(): FlightPlan {
  return plan({
    originIcao: 'RJAA',
    destinationIcao: 'KLAX',
    distanceNm: 4750,
    cruiseSpeedKt: 490,
  });
}

function windowFor(state: FlightState, phase: string): PhaseWindow {
  const window = state.timeline.find((w) => w.phase === phase);
  if (!window) throw new Error(`no ${phase} window`);
  return window;
}

function midOf(window: PhaseWindow): Date {
  if (!window.to) throw new Error('open window');
  return new Date((window.from.getTime() + window.to.getTime()) / 2);
}

function runTo(state: FlightState, phase: string): FlightState {
  let current = state;
  while (current.phase !== phase) {
    if (isTerminal(current)) throw new Error(`never reached ${phase}`);
    const next = current.timeline[current.index + 1];
    if (!next) throw new Error(`never reached ${phase}`);
    const result = reduce(current, { type: 'ADVANCE', at: next.from }, PROFILE);
    if (!result.ok) throw new Error(result.reason);
    current = result.state;
  }
  return current;
}

/** Samples the whole airborne leg, evenly. */
function samplePath(state: FlightState, samples: number): Coordinates[] {
  const leg = state.legs[state.legs.length - 1];
  const first = state.legs[0];
  if (!leg || !first) throw new Error('no legs');
  const span = leg.endsAt.getTime() - first.startedAt.getTime();

  const points: Coordinates[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const at = new Date(first.startedAt.getTime() + (span * i) / samples);
    const position = interpolatePosition(state, at, PROFILE, lookup);
    if (!position) throw new Error('no position');
    points.push({ latitudeDeg: position.latitudeDeg, longitudeDeg: position.longitudeDeg });
  }
  return points;
}

describe('slerp', () => {
  const a: Coordinates = { latitudeDeg: 0, longitudeDeg: 0 };
  const b: Coordinates = { latitudeDeg: 0, longitudeDeg: 90 };

  it('returns the endpoints exactly', () => {
    expect(slerp(a, b, 0).longitudeDeg).toBeCloseTo(0, 9);
    expect(slerp(a, b, 1).longitudeDeg).toBeCloseTo(90, 9);
  });

  it('halves an equatorial arc down the middle', () => {
    const mid = slerp(a, b, 0.5);
    expect(mid.latitudeDeg).toBeCloseTo(0, 9);
    expect(mid.longitudeDeg).toBeCloseTo(45, 9);
  });

  it('bulges towards the pole on a high-latitude arc, as a great circle does', () => {
    // Two points at 60°N, 120° of longitude apart. The straight line on a flat
    // map stays at 60°N; the great circle goes considerably further north.
    const from: Coordinates = { latitudeDeg: 60, longitudeDeg: -60 };
    const to: Coordinates = { latitudeDeg: 60, longitudeDeg: 60 };
    expect(slerp(from, to, 0.5).latitudeDeg).toBeGreaterThan(70);
  });

  it('handles coincident points without dividing by zero', () => {
    const same: Coordinates = { latitudeDeg: 51.5, longitudeDeg: -0.45 };
    expect(slerp(same, { ...same }, 0.5)).toEqual(same);
  });

  it('refuses antipodal points rather than inventing a route', () => {
    // Every great circle between opposite points is the same length, so there is
    // no shortest one to pick. Impossible for real airports, and a silent guess
    // would draw a confident line along a route nothing chose.
    expect(() =>
      slerp({ latitudeDeg: 10, longitudeDeg: 20 }, { latitudeDeg: -10, longitudeDeg: -160 }, 0.5),
    ).toThrow(/antipodal/);
  });

  it('keeps every point on the sphere', () => {
    for (let i = 0; i <= 20; i += 1) {
      const p = slerp(AIRPORTS.RJAA as Coordinates, AIRPORTS.KLAX as Coordinates, i / 20);
      expect(Math.abs(p.latitudeDeg)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.longitudeDeg)).toBeLessThanOrEqual(180);
    }
  });
});

describe('initialBearingDeg', () => {
  it('is 90 due east and 0 due north', () => {
    expect(
      initialBearingDeg({ latitudeDeg: 0, longitudeDeg: 0 }, { latitudeDeg: 0, longitudeDeg: 10 }),
    ).toBeCloseTo(90, 6);
    expect(
      initialBearingDeg({ latitudeDeg: 0, longitudeDeg: 0 }, { latitudeDeg: 10, longitudeDeg: 0 }),
    ).toBeCloseTo(0, 6);
  });

  it('is always in 0–360, never negative', () => {
    const west = initialBearingDeg(
      { latitudeDeg: 0, longitudeDeg: 0 },
      { latitudeDeg: 0, longitudeDeg: -10 },
    );
    expect(west).toBeCloseTo(270, 6);
    expect(west).toBeGreaterThanOrEqual(0);
    expect(west).toBeLessThan(360);
  });

  it('changes along a great circle, which is why it is taken from where the aircraft is', () => {
    const from = AIRPORTS.EHAM as Coordinates;
    const to = AIRPORTS.KJFK as Coordinates;
    const atStart = initialBearingDeg(from, to);
    const atEnd = initialBearingDeg(slerp(from, to, 0.9), to);
    expect(Math.abs(atEnd - atStart)).toBeGreaterThan(10);
  });
});

describe('greatCirclePath', () => {
  it('includes both endpoints and the steps between', () => {
    const path = greatCirclePath(AIRPORTS.EHAM as Coordinates, AIRPORTS.KJFK as Coordinates, 8);
    expect(path).toHaveLength(9);
    expect(path[0]?.latitudeDeg).toBeCloseTo(52.3086, 6);
    expect(path[8]?.longitudeDeg).toBeCloseTo(-73.7789, 6);
  });

  it('refuses a path with no steps', () => {
    expect(() =>
      greatCirclePath(AIRPORTS.EHAM as Coordinates, AIRPORTS.KJFK as Coordinates, 0),
    ).toThrow(/at least one step/);
  });
});

describe('the antimeridian', () => {
  it('flies NRT to LAX across the Pacific, not backwards across Asia', () => {
    const path = greatCirclePath(AIRPORTS.RJAA as Coordinates, AIRPORTS.KLAX as Coordinates, 200);

    // Naively interpolating longitude from 140.4 to -118.4 sweeps 259° westward
    // through Europe. The great circle goes east over the Aleutians, so no point
    // on it may be anywhere near the Atlantic.
    for (const point of path) {
      const nearEurope = point.longitudeDeg > -60 && point.longitudeDeg < 100;
      expect(nearEurope).toBe(false);
    }
  });

  it('reaches far further north than either airport, as the real route does', () => {
    const path = greatCirclePath(AIRPORTS.RJAA as Coordinates, AIRPORTS.KLAX as Coordinates, 200);
    const highest = Math.max(...path.map((p) => p.latitudeDeg));
    expect(highest).toBeGreaterThan(45);
  });

  it('actually crosses 180°, so the case is genuinely exercised', () => {
    const path = greatCirclePath(AIRPORTS.RJAA as Coordinates, AIRPORTS.KLAX as Coordinates, 200);
    const crossed = path.some((p, i) => {
      const previous = path[i - 1];
      return previous !== undefined && previous.longitudeDeg > 0 && p.longitudeDeg < 0;
    });
    expect(crossed).toBe(true);
  });

  it('interpolates a whole NRT–LAX flight without a jump artefact', () => {
    // The acceptance criterion, stated as the thing that actually matters: no
    // two consecutive samples are far apart *on the ground*. The longitude
    // number does flip sign at 180° — that is correct — but the aircraft does
    // not move.
    const flight = planFlight(transpacific(), PROFILE);
    const path = samplePath(flight, 400);

    let biggestStepNm = 0;
    for (let i = 1; i < path.length; i += 1) {
      const a = path[i - 1];
      const b = path[i];
      if (!a || !b) continue;
      biggestStepNm = Math.max(
        biggestStepNm,
        haversineNm(a.latitudeDeg, a.longitudeDeg, b.latitudeDeg, b.longitudeDeg),
      );
    }

    // 4,750 nm over 400 samples averages under 12 nm a step; cruise segments are
    // the longest. Anything near half the planet would be the artefact.
    expect(biggestStepNm).toBeLessThan(40);
  });

  it('unwraps longitudes into something a renderer can draw a line through', () => {
    const path = greatCirclePath(AIRPORTS.RJAA as Coordinates, AIRPORTS.KLAX as Coordinates, 200);
    const unwrapped = unwrapLongitudes(path);

    expect(unwrapped).toHaveLength(path.length);
    for (let i = 1; i < unwrapped.length; i += 1) {
      const step = Math.abs((unwrapped[i] ?? 0) - (unwrapped[i - 1] ?? 0));
      expect(step).toBeLessThan(180);
    }

    // Continuity is bought by leaving the valid coordinate range, which is why
    // the result is bare numbers rather than positions.
    expect(Math.max(...unwrapped)).toBeGreaterThan(180);
  });

  it('leaves a path that never crosses the antimeridian alone', () => {
    const path = greatCirclePath(AIRPORTS.EHAM as Coordinates, AIRPORTS.KJFK as Coordinates, 50);
    expect(unwrapLongitudes(path)).toEqual(path.map((p) => p.longitudeDeg));
  });

  it('unwraps an empty path to an empty result', () => {
    expect(unwrapLongitudes([])).toEqual([]);
  });
});

describe('interpolatePosition', () => {
  it('puts a boarding aircraft on its stand, at field elevation', () => {
    const flight = planFlight(plan({ destinationIcao: 'KDEN', distanceNm: 3900 }), PROFILE);
    const at = midOf(windowFor(flight, 'boarding'));
    const position = interpolatePosition(flight, at, PROFILE, lookup);

    expect(position?.latitudeDeg).toBeCloseTo(52.3086, 6);
    expect(position?.altitudeFt).toBe(-11);
    expect(position?.groundSpeedKt).toBe(0);
    expect(position?.progress).toBe(0);
    expect(position?.legIndex).toBe(-1);
  });

  it('puts an arrived aircraft on its destination stand, at that field elevation', () => {
    // Denver is 5,431 ft up. An aircraft parked there is not at sea level, and a
    // profile that says it is would read as a bug in the altitude readout.
    const flight = runTo(
      planFlight(plan({ destinationIcao: 'KDEN', distanceNm: 3900 }), PROFILE),
      'turnaround',
    );
    const position = interpolatePosition(
      flight,
      midOf(windowFor(flight, 'turnaround')),
      PROFILE,
      lookup,
    );
    expect(position?.altitudeFt).toBe(5431);
    expect(position?.progress).toBe(1);
  });

  it('leaves the origin and arrives at the destination', () => {
    const flight = planFlight(plan(), PROFILE);
    const leg = flight.legs[0];
    if (!leg) throw new Error('no leg');

    const start = interpolatePosition(flight, leg.startedAt, PROFILE, lookup);
    const end = interpolatePosition(flight, leg.endsAt, PROFILE, lookup);

    expect(
      haversineNm(start?.latitudeDeg ?? 0, start?.longitudeDeg ?? 0, 52.3086, 4.7639),
    ).toBeLessThan(0.1);
    expect(
      haversineNm(end?.latitudeDeg ?? 0, end?.longitudeDeg ?? 0, 40.6398, -73.7789),
    ).toBeLessThan(0.1);
  });

  it('points where it is going, not where it came from', () => {
    const flight = planFlight(plan(), PROFILE);
    const position = interpolatePosition(
      flight,
      midOf(windowFor(flight, 'cruise')),
      PROFILE,
      lookup,
    );
    // EHAM–KJFK crosses the Atlantic heading broadly west, having started
    // north-west and swinging south of west as it goes.
    expect(position?.headingDeg).toBeGreaterThan(230);
    expect(position?.headingDeg).toBeLessThan(300);
  });

  it('still gives a sensible heading at the very end of the leg', () => {
    // The bearing from a point to itself is meaningless, so the last stretch
    // must not produce a wild number.
    const flight = planFlight(plan(), PROFILE);
    const leg = flight.legs[0];
    if (!leg) throw new Error('no leg');
    const position = interpolatePosition(flight, leg.endsAt, PROFILE, lookup);
    expect(Number.isFinite(position?.headingDeg ?? NaN)).toBe(true);
    expect(position?.headingDeg).toBeGreaterThanOrEqual(0);
    expect(position?.headingDeg).toBeLessThan(360);
  });

  it('climbs, cruises and descends without ever jumping between levels', () => {
    const flight = planFlight(plan(), PROFILE);
    const leg = flight.legs[0];
    if (!leg) throw new Error('no leg');
    const span = leg.endsAt.getTime() - leg.startedAt.getTime();

    let previous: number | undefined;
    let highest = 0;
    for (let i = 0; i <= 600; i += 1) {
      const at = new Date(leg.startedAt.getTime() + (span * i) / 600);
      const altitude = interpolatePosition(flight, at, PROFILE, lookup)?.altitudeFt ?? 0;
      highest = Math.max(highest, altitude);
      if (previous !== undefined) {
        // A phase change must not teleport the aircraft. 600 samples over ~7
        // hours is 42 seconds apart; 2,000 ft/min cannot cover 2,000 ft in that.
        expect(Math.abs(altitude - previous)).toBeLessThan(2_000);
      }
      previous = altitude;
    }

    expect(highest).toBe(35_000);
  });

  it('is on the ground at both ends of the leg', () => {
    const flight = planFlight(plan(), PROFILE);
    const leg = flight.legs[0];
    if (!leg) throw new Error('no leg');
    expect(interpolatePosition(flight, leg.startedAt, PROFILE, lookup)?.altitudeFt).toBe(-11);
    expect(interpolatePosition(flight, leg.endsAt, PROFILE, lookup)?.altitudeFt).toBe(13);
  });

  it('answers null when the lookup does not have the airport', () => {
    const flight = planFlight(plan({ destinationIcao: 'ZZZZ' }), PROFILE);
    const leg = flight.legs[0];
    if (!leg) throw new Error('no leg');
    expect(interpolatePosition(flight, leg.startedAt, PROFILE, lookup)).toBeNull();
  });
});

describe('a diverted flight', () => {
  function diverted(): FlightState {
    const state = runTo(planFlight(plan(), PROFILE), 'cruise');
    const at = midOf(windowFor(state, 'cruise'));
    const result = reduce(state, { type: 'DIVERT', at, toIcao: 'BIKF', distanceNm: 700 }, PROFILE);
    if (!result.ok) throw new Error(result.reason);
    return result.state;
  }

  it('turns without teleporting', () => {
    // The moment of the diversion is the one place the path could tear: the old
    // leg ends and a new one begins from a point in open water, and the two have
    // to be the same point.
    const flight = diverted();
    const second = flight.legs[1];
    if (!second) throw new Error('no diversion leg');

    const before = interpolatePosition(
      flight,
      new Date(second.startedAt.getTime() - 1),
      PROFILE,
      lookup,
    );
    const after = interpolatePosition(flight, second.startedAt, PROFILE, lookup);

    expect(
      haversineNm(
        before?.latitudeDeg ?? 0,
        before?.longitudeDeg ?? 0,
        after?.latitudeDeg ?? 0,
        after?.longitudeDeg ?? 0,
      ),
    ).toBeLessThan(0.5);
  });

  it('ends up at the alternate', () => {
    const flight = diverted();
    const second = flight.legs[1];
    if (!second) throw new Error('no diversion leg');
    const arrival = interpolatePosition(flight, second.endsAt, PROFILE, lookup);
    expect(
      haversineNm(arrival?.latitudeDeg ?? 0, arrival?.longitudeDeg ?? 0, 63.985, -22.6056),
    ).toBeLessThan(0.1);
  });

  it('reports which leg it is on', () => {
    const flight = diverted();
    const second = flight.legs[1];
    if (!second) throw new Error('no diversion leg');
    expect(interpolatePosition(flight, second.startedAt, PROFILE, lookup)?.legIndex).toBe(1);
    expect(
      interpolatePosition(flight, addMinutes(second.startedAt, -30), PROFILE, lookup)?.legIndex,
    ).toBe(0);
  });

  it('never doubles back on itself across the turn', () => {
    const flight = diverted();
    const path = samplePath(flight, 400);
    let biggestStepNm = 0;
    for (let i = 1; i < path.length; i += 1) {
      const a = path[i - 1];
      const b = path[i];
      if (!a || !b) continue;
      biggestStepNm = Math.max(
        biggestStepNm,
        haversineNm(a.latitudeDeg, a.longitudeDeg, b.latitudeDeg, b.longitudeDeg),
      );
    }
    expect(biggestStepNm).toBeLessThan(40);
  });
});

describe('purity', () => {
  it('is a function of the flight and the instant, and nothing else', () => {
    const flight = planFlight(transpacific(), PROFILE);
    const at = midOf(windowFor(flight, 'cruise'));
    const first = interpolatePosition(flight, at, PROFILE, lookup);
    const second = interpolatePosition(flight, at, PROFILE, lookup);
    expect(second).toEqual(first);
  });

  it('gives the same answers whatever order the instants are asked in', () => {
    // No stored per-tick history, stated as a property: a position asked for out
    // of order must match the one asked for in order.
    const flight = planFlight(transpacific(), PROFILE);
    const leg = flight.legs[0];
    if (!leg) throw new Error('no leg');
    const span = leg.endsAt.getTime() - leg.startedAt.getTime();

    const instants = Array.from(
      { length: 200 },
      (_, i) => new Date(leg.startedAt.getTime() + (span * i) / 199),
    );
    const forwards = instants.map((t) => interpolatePosition(flight, t, PROFILE, lookup));
    const backwards = [...instants]
      .reverse()
      .map((t) => interpolatePosition(flight, t, PROFILE, lookup))
      .reverse();

    expect(backwards).toEqual(forwards);
  });

  it('does not mutate the flight it is given', () => {
    const flight = planFlight(transpacific(), PROFILE);
    const snapshot = JSON.stringify(flight);
    interpolatePosition(flight, midOf(windowFor(flight, 'cruise')), PROFILE, lookup);
    expect(JSON.stringify(flight)).toBe(snapshot);
  });
});

/**
 * Is this run instrumented for coverage?
 *
 * V8 coverage costs roughly 5× on this code path — it scales with the number of
 * distinct branches executed, and interpolation is branchy — so a latency budget
 * measured under it is measuring the instrumentation rather than the code.
 *
 * Reads a vitest internal, deliberately biased to fail safe: if the internal
 * ever moves, this answers `false`, the budget is asserted anyway, and the test
 * goes red where someone will look at it. The alternative bias would silently
 * stop enforcing the criterion.
 *
 * `pnpm test:perf` runs this test uninstrumented, and CI runs that step, so the
 * budget is enforced on every pull request rather than only locally.
 */
/**
 * A high-resolution clock, reached through `globalThis`.
 *
 * `packages/sim` compiles against ES2022 with no platform library, because
 * nothing in it may depend on running under Node (CONTRIBUTING invariant 2).
 * A benchmark needs sub-millisecond resolution — `Date.now()` on Windows is
 * coarser than the thing being measured — so this test, and only this test,
 * reaches for the host's clock explicitly.
 */
const clock = (globalThis as unknown as { performance: { now: () => number } }).performance;

function coverageInstrumented(): boolean {
  const worker = (globalThis as Record<string, unknown>).__vitest_worker__ as
    { config?: { coverage?: { enabled?: boolean } } } | undefined;
  return worker?.config?.coverage?.enabled === true;
}

describe('cost at world scale', () => {
  it('interpolates 5,000 concurrent flights in under 16ms', () => {
    // §21's reason for computing position rather than storing it. 16ms is one
    // frame: if a full world sweep does not fit inside one, the map cannot be
    // driven from it.
    const flights: FlightState[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      flights.push(
        planFlight(
          plan({
            // Spread the departures so the sample lands across every phase
            // rather than only in the cheap ones.
            scheduledDeparture: addMinutes(OFF_BLOCKS, i % 480),
            distanceNm: 500 + (i % 4_000),
          }),
          PROFILE,
        ),
      );
    }

    const at = addMinutes(OFF_BLOCKS, 240);

    // Warm up first. Timing the optimiser instead of the code would make this
    // measure nothing at all.
    for (const flight of flights) interpolatePosition(flight, at, PROFILE, lookup);

    const started = clock.now();
    let found = 0;
    for (const flight of flights) {
      if (interpolatePosition(flight, at, PROFILE, lookup)) found += 1;
    }
    const elapsedMs = clock.now() - started;

    expect(found).toBe(5_000);

    // The sweep has to be doing varied work for the number to mean anything.
    const phases = new Set(
      flights.map((flight) => interpolatePosition(flight, at, PROFILE, lookup)?.phase),
    );
    expect(phases.size).toBeGreaterThan(4);

    // Always on: catches an accidental O(n²) or a per-call allocation storm in
    // any mode, without pretending an instrumented measurement is the budget.
    expect(elapsedMs).toBeLessThan(150);

    if (!coverageInstrumented()) expect(elapsedMs).toBeLessThan(16);
  });
});
