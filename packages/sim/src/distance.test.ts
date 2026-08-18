import { describe, expect, it } from 'vitest';

import {
  buildDistanceMatrix,
  DistanceMatrix,
  EARTH_RADIUS_NM,
  haversineNm,
  packedIndex,
  packedLength,
  type MatrixPoint,
} from './distance';

/**
 * The distance matrix.
 *
 * The spot checks come straight from M1-04's acceptance criteria and from App.
 * B.4's own table, so they are testing the numbers the design doc asserts rather
 * than numbers this implementation happens to produce.
 */

/**
 * The acceptance criterion is ±1%, so assert exactly that.
 *
 * `toBeCloseTo` on a ratio is a fiddly way to express a percentage and it is
 * easy to end up testing something tighter than the requirement — which is what
 * happened first: AMS–LHR computes to 200.0 nm against the doc's 199, which is
 * 0.5% out and well inside the criterion, but failed a 0.5% assertion.
 */
function expectWithinOnePercent(actual: number, expected: number): void {
  const drift = Math.abs(actual - expected) / expected;
  expect(
    drift,
    `${String(actual.toFixed(1))} nm against ${String(expected)} nm is ${String((drift * 100).toFixed(2))}% out`,
  ).toBeLessThanOrEqual(0.01);
}

const AMS: MatrixPoint = { ident: 'EHAM', latitude: 52.3086, longitude: 4.76389 };
const LHR: MatrixPoint = { ident: 'EGLL', latitude: 51.4706, longitude: -0.461941 };
const JFK: MatrixPoint = { ident: 'KJFK', latitude: 40.6398, longitude: -73.7789 };
const NRT: MatrixPoint = { ident: 'RJAA', latitude: 35.7647, longitude: 140.386 };

describe('haversineNm', () => {
  it('matches the acceptance criteria within 1%', () => {
    expectWithinOnePercent(
      haversineNm(AMS.latitude, AMS.longitude, LHR.latitude, LHR.longitude),
      199,
    );
    expectWithinOnePercent(
      haversineNm(AMS.latitude, AMS.longitude, JFK.latitude, JFK.longitude),
      3157,
    );
    expectWithinOnePercent(
      haversineNm(LHR.latitude, LHR.longitude, NRT.latitude, NRT.longitude),
      5179,
    );
  });

  it('matches App. B.4 sectors from Amsterdam', () => {
    // The doc's own table of what an ATR 72 reaches from AMS.
    const from = (lat: number, lon: number): number =>
      haversineNm(AMS.latitude, AMS.longitude, lat, lon);
    // B.4's table is quoted to the nearest nautical mile, so allow 2%.
    const within2pc = (actual: number, expected: number): void => {
      expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(0.02);
    };
    within2pc(from(55.6181, 12.656), 342); // CPH
    within2pc(from(53.4213, -6.27007), 405); // DUB
    within2pc(from(48.1103, 16.5697), 518); // VIE
    within2pc(from(40.4719, -3.56264), 789); // MAD
  });

  it('is zero between a point and itself', () => {
    expect(haversineNm(52.3, 4.76, 52.3, 4.76)).toBe(0);
  });

  it('is symmetric', () => {
    const forward = haversineNm(1, 2, 3, 4);
    const backward = haversineNm(3, 4, 1, 2);
    expect(forward).toBeCloseTo(backward, 9);
  });

  it('survives antipodal points instead of returning NaN', () => {
    // sqrt can land a hair above 1 here, and Math.asin of that is NaN.
    const half = Math.PI * EARTH_RADIUS_NM;
    expect(haversineNm(0, 0, 0, 180)).toBeCloseTo(half, 0);
    expect(haversineNm(90, 0, -90, 0)).toBeCloseTo(half, 0);
  });

  it('handles a sector crossing the date line', () => {
    // ANC–NRT crosses 180°; a naive longitude difference would give the long way
    // round the planet.
    const km = haversineNm(61.1744, -149.996, 35.7647, 140.386);
    expect(km).toBeGreaterThan(2_500);
    expect(km).toBeLessThan(4_000);
  });

  it('gives a short sector real precision', () => {
    // Where the spherical law of cosines loses its digits, and where the ATR-72
    // game of B.4 is actually played.
    const short = haversineNm(52.3086, 4.76389, 52.3186, 4.76389);
    expect(short).toBeGreaterThan(0.5);
    expect(short).toBeLessThan(0.7);
  });
});

describe('packedIndex', () => {
  it('numbers a 4-point triangle without gaps or collisions', () => {
    const n = 4;
    const seen = new Set<number>();
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) seen.add(packedIndex(i, j, n));
    }
    expect(seen.size).toBe(packedLength(n));
    expect(Math.max(...seen)).toBe(packedLength(n) - 1);
    expect(Math.min(...seen)).toBe(0);
  });

  it('gives the same slot whichever order the pair is passed', () => {
    expect(packedIndex(2, 5, 10)).toBe(packedIndex(5, 2, 10));
  });

  it('refuses the diagonal rather than returning a wrong slot', () => {
    expect(() => packedIndex(3, 3, 10)).toThrow(/diagonal/);
  });

  it('refuses an index outside the matrix', () => {
    expect(() => packedIndex(0, 10, 10)).toThrow(/outside a matrix/);
    expect(() => packedIndex(-1, 2, 10)).toThrow(/outside a matrix/);
  });

  it('halves the storage a full matrix would need', () => {
    // 4,359 airports: 9.5M entries at 4 bytes is 38 MB, against the issue's
    // 40 MB budget. A full square matrix would be 76 MB and would not fit.
    expect(packedLength(4_359)).toBe(9_498_261);
    expect((packedLength(4_359) * 4) / 1024 / 1024).toBeLessThan(40);
  });
});

describe('buildDistanceMatrix', () => {
  const points = [AMS, LHR, JFK, NRT];
  const matrix = new DistanceMatrix(buildDistanceMatrix(points));

  it('covers every pair', () => {
    expect(matrix.size).toBe(4);
    for (const a of points) {
      for (const b of points) {
        expect(matrix.distanceNm(a.ident, b.ident)).not.toBeNull();
      }
    }
  });

  it('agrees with the direct calculation', () => {
    // The packed lookup and the formula must not drift apart; Float32 storage is
    // the only difference between them.
    const direct = haversineNm(AMS.latitude, AMS.longitude, JFK.latitude, JFK.longitude);
    expect(matrix.distanceNm('EHAM', 'KJFK')!).toBeCloseTo(direct, 2);
  });

  it('reproduces the acceptance-criteria sectors through the matrix', () => {
    expectWithinOnePercent(matrix.distanceNm('EHAM', 'EGLL')!, 199);
    expectWithinOnePercent(matrix.distanceNm('EHAM', 'KJFK')!, 3157);
    expectWithinOnePercent(matrix.distanceNm('EGLL', 'RJAA')!, 5179);
  });

  it('is symmetric through the lookup', () => {
    expect(matrix.distanceNm('EHAM', 'RJAA')).toBe(matrix.distanceNm('RJAA', 'EHAM'));
  });

  it('reports zero for an airport against itself', () => {
    expect(matrix.distanceNm('EHAM', 'EHAM')).toBe(0);
  });

  it('answers null for an airport it does not carry', () => {
    // The matrix covers the scheduled-service subset; asking about an airstrip
    // outside it is a fair question with an honest answer.
    expect(matrix.distanceNm('EHAM', 'ZZZZ')).toBeNull();
    expect(matrix.has('ZZZZ')).toBe(false);
  });

  it('is deterministic', () => {
    const again = new DistanceMatrix(buildDistanceMatrix(points));
    expect(again.distanceNm('EHAM', 'RJAA')).toBe(matrix.distanceNm('EHAM', 'RJAA'));
  });

  it('handles the degenerate one-airport case without a zero-length array bug', () => {
    const single = new DistanceMatrix(buildDistanceMatrix([AMS]));
    expect(single.size).toBe(1);
    expect(single.distanceNm('EHAM', 'EHAM')).toBe(0);
  });
});

describe('DistanceMatrix construction', () => {
  it('refuses a buffer that does not match the ident count', () => {
    // The failure mode this guards: a matrix built from one airport set loaded
    // against another. Every lookup would return a real-looking wrong number.
    expect(
      () => new DistanceMatrix({ idents: ['A', 'B', 'C'], distances: new Float32Array(2) }),
    ).toThrow(/expected 3 entries|expected 3 for|entries, expected/);
  });

  it('accepts a correctly sized buffer', () => {
    expect(
      () => new DistanceMatrix({ idents: ['A', 'B', 'C'], distances: new Float32Array(3) }),
    ).not.toThrow();
  });
});

describe('performance', () => {
  it('builds a 2,000-airport matrix well inside the 60-second budget', () => {
    // 2M pairs here against 9.5M for the real set, so this is roughly a fifth of
    // the real job — if this takes seconds, the real one cannot take a minute.
    const many: MatrixPoint[] = Array.from({ length: 2_000 }, (_, i) => ({
      ident: `A${String(i)}`,
      latitude: -80 + (160 * i) / 2_000,
      longitude: -180 + (360 * (i % 97)) / 97,
    }));

    const started = Date.now();
    const built = buildDistanceMatrix(many);
    const elapsed = Date.now() - started;

    expect(built.distances.length).toBe(packedLength(2_000));
    expect(elapsed).toBeLessThan(10_000);
  });
});
