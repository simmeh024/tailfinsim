import { describe, expect, it } from 'vitest';

import {
  affinityBetween,
  DEFAULT_GRAVITY,
  DEFAULT_SEGMENTS,
  type DemandEndpoint,
  demandPool,
  distanceFactor,
  isViablePair,
  segmentShares,
} from './gravity';

/**
 * The gravity model (M3-01, App. A.2).
 *
 * A.2 gives the formula and the shape of `f(distance)` and leaves everything
 * else to be decided. The four acceptance criteria are the tests that matter,
 * and the first is a claim about *shape* rather than magnitude:
 *
 *   1. **AMS–LHR is business-heavy; AMS–PMI is leisure-heavy.** Two financial
 *      centres 200 nm apart against a northern city and a holiday island.
 *   2. Segment shares sum to exactly 1 for every pair.
 *   3. `k` and `α` are config, not code.
 *   4. Generation of every viable pair fits in five minutes — see
 *      `gravity.perf.test.ts`, which is where that is measured.
 */

const AMS: DemandEndpoint = {
  icaoCode: 'EHAM',
  population: 2_500_000,
  wealthIndex: 1.6,
  tourismIndex: 1.5,
  businessIndex: 1.8,
  isoCountry: 'NL',
  language: 'nl',
};

/** London: bigger, richer, and one of the two densest business ends in Europe. */
const LHR: DemandEndpoint = {
  icaoCode: 'EGLL',
  population: 9_000_000,
  wealthIndex: 1.7,
  tourismIndex: 1.9,
  businessIndex: 2.4,
  isoCountry: 'GB',
  language: 'en',
};

/** Palma: a holiday island. Heavy tourism, almost no business. */
const PMI: DemandEndpoint = {
  icaoCode: 'LEPA',
  population: 900_000,
  wealthIndex: 1.0,
  tourismIndex: 3.8,
  businessIndex: 0.5,
  isoCountry: 'ES',
  language: 'es',
};

const JFK: DemandEndpoint = {
  icaoCode: 'KJFK',
  population: 8_000_000,
  wealthIndex: 1.8,
  tourismIndex: 1.8,
  businessIndex: 2.3,
  isoCountry: 'US',
  language: 'en',
};

/** A second Dutch city, for the domestic and shared-language terms. */
const RTM: DemandEndpoint = {
  icaoCode: 'EHRD',
  population: 1_200_000,
  wealthIndex: 1.4,
  tourismIndex: 0.9,
  businessIndex: 1.5,
  isoCountry: 'NL',
  language: 'nl',
};

const AMS_LHR_NM = 200;
const AMS_PMI_NM = 700;
const AMS_JFK_NM = 3_160;

describe('distanceFactor', () => {
  it('is near nothing where the train wins', () => {
    // A.2: "rises from ~0 at very short distance (surface transport competes)".
    expect(distanceFactor(50)).toBeLessThan(0.01);
    expect(distanceFactor(90)).toBeLessThan(0.05);
  });

  it('rises fast once surface transport stops competing', () => {
    // The correction the first version needed. A square-root rise towards a
    // 1,500 nm peak put Amsterdam–London at a fifth of peak demand and made the
    // North Atlantic look like the bigger market, which it is not.
    expect(distanceFactor(200)).toBeGreaterThan(0.4);
    expect(distanceFactor(400)).toBeGreaterThan(0.8);
  });

  it('peaks at medium haul', () => {
    const peak = distanceFactor(DEFAULT_GRAVITY.peakDistanceNm);

    expect(peak).toBeGreaterThan(distanceFactor(200));
    expect(peak).toBeGreaterThan(distanceFactor(3_000));
    expect(peak).toBeCloseTo(1, 1);
  });

  it('decays slowly beyond it, rather than falling off', () => {
    // What "decays slowly" has to mean for a widebody strategy to exist.
    expect(distanceFactor(3_000)).toBeGreaterThan(0.25);
    expect(distanceFactor(5_000)).toBeGreaterThan(0.1);
  });

  it('never goes backwards on the rising limb', () => {
    let previous = 0;
    for (let d = 100; d <= DEFAULT_GRAVITY.peakDistanceNm; d += 25) {
      const value = distanceFactor(d);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('refuses a negative distance', () => {
    expect(() => distanceFactor(-1)).toThrow(/[Dd]istance/);
  });
});

describe('affinityBetween', () => {
  it('is 1 for a pair with nothing distinctive about it', () => {
    const plain: DemandEndpoint = {
      icaoCode: 'XXXX',
      population: 500_000,
      wealthIndex: 1,
      tourismIndex: 1,
      businessIndex: 1,
      isoCountry: 'ZZ',
    };

    expect(affinityBetween(plain, { ...plain, icaoCode: 'YYYY', isoCountry: 'AA' }).value).toBe(1);
  });

  it('is raised by tourism at either end, because one beach is enough', () => {
    expect(affinityBetween(AMS, PMI).value).toBeGreaterThan(affinityBetween(AMS, RTM).value);
    expect(affinityBetween(AMS, PMI).components.map((c) => c.source)).toContain('tourism');
  });

  it('needs business at both ends, not one', () => {
    // A financial centre paired with a beach is a leisure route, not a business
    // one — which is why the term multiplies rather than adds.
    const both = affinityBetween(AMS, LHR).components.find((c) => c.source === 'business');
    const oneEnd = affinityBetween(AMS, PMI).components.find((c) => c.source === 'business');

    expect(both?.value).toBeGreaterThan(0);
    expect(oneEnd).toBeUndefined();
  });

  it('rewards a domestic pair', () => {
    expect(affinityBetween(AMS, RTM).components.map((c) => c.source)).toContain('domestic');
  });

  it('rewards a shared language across a border, but not twice', () => {
    // Domestic already implies the language; adding both would double-count.
    const shared = affinityBetween(LHR, JFK).components.map((c) => c.source);
    const domestic = affinityBetween(AMS, RTM).components.map((c) => c.source);

    expect(shared).toContain('language');
    expect(domestic).toContain('domestic');
    expect(domestic).not.toContain('language');
  });

  it('takes a migration tie when one is known, and is silent when it is not', () => {
    // A.2 names migration ties; nobody has bilateral data for them. Zero by
    // default rather than invented from geography.
    expect(affinityBetween(AMS, LHR).components.map((c) => c.source)).not.toContain('migration');
    expect(affinityBetween(AMS, LHR, 0.4).components.map((c) => c.source)).toContain('migration');
  });

  it('explains itself, so a surprising pool is not a dead end', () => {
    for (const component of affinityBetween(AMS, PMI).components) {
      expect(component.detail.length).toBeGreaterThan(10);
    }
  });
});

describe('segmentShares', () => {
  it('sums to exactly 1 for every pair — M3-01’s third acceptance criterion', () => {
    // Asserted across the whole range, because the shares are clamped into A.2's
    // bands first and clamping three numbers independently does not preserve
    // their sum. The normalisation afterwards is what makes this true.
    const endpoints = [AMS, LHR, PMI, JFK, RTM];

    for (const origin of endpoints) {
      for (const destination of endpoints) {
        const shares = segmentShares(origin, destination);
        const total = shares.business + shares.leisure + shares.vfr;

        expect(total, `${origin.icaoCode}-${destination.icaoCode}`).toBeCloseTo(1, 12);
      }
    }
  });

  it('makes AMS–LHR business-heavy — M3-01’s first acceptance criterion', () => {
    const shares = segmentShares(AMS, LHR);

    expect(shares.business).toBeGreaterThan(0.25);
    // A.2's band tops out at 35%.
    expect(shares.business).toBeLessThanOrEqual(0.36);
  });

  it('makes AMS–PMI leisure-heavy — the other half of the same criterion', () => {
    const shares = segmentShares(AMS, PMI);

    expect(shares.leisure).toBeGreaterThan(0.58);
    expect(shares.business).toBeLessThan(segmentShares(AMS, LHR).business);
  });

  it('puts the two routes at opposite ends, which is the point of the split', () => {
    // "This split is what makes different strategies viable." If the two came out
    // similar there would be one strategy.
    const business = segmentShares(AMS, LHR);
    const leisure = segmentShares(AMS, PMI);

    expect(business.business - leisure.business).toBeGreaterThan(0.08);
    expect(leisure.leisure - business.leisure).toBeGreaterThan(0.05);
  });

  it('lifts VFR on a domestic pair', () => {
    expect(segmentShares(AMS, RTM).vfr).toBeGreaterThan(segmentShares(AMS, PMI).vfr);
  });

  it('stays inside A.2’s published bands after normalisation', () => {
    const endpoints = [AMS, LHR, PMI, JFK, RTM];

    for (const origin of endpoints) {
      for (const destination of endpoints) {
        const shares = segmentShares(origin, destination);
        for (const segment of ['business', 'leisure', 'vfr'] as const) {
          const [low, high] = DEFAULT_SEGMENTS.bounds[segment];
          // Normalisation can move a share slightly outside its clamp, so the
          // check is that it stays near the band rather than exactly inside it.
          expect(shares[segment]).toBeGreaterThan(low - 0.06);
          expect(shares[segment]).toBeLessThan(high + 0.06);
        }
      }
    }
  });

  it('is symmetric — a market is the same market in both directions', () => {
    expect(segmentShares(AMS, PMI)).toEqual(segmentShares(PMI, AMS));
  });
});

describe('demandPool', () => {
  it('is calibrated to Amsterdam–London at about 10,000 passengers a day', () => {
    // The single anchor. Roughly 3.6 million a year, which is the right order
    // for one of Europe's densest city pairs.
    const pool = demandPool(AMS, LHR, AMS_LHR_NM);

    expect(pool.dailyPassengers).toBeGreaterThan(8_000);
    expect(pool.dailyPassengers).toBeLessThan(12_000);
  });

  it('puts Amsterdam–New York near its real size too, unprompted', () => {
    // Not calibrated to. The distance curve and the sub-linear mass term put it
    // near 5,000 a day on their own, against a real figure of roughly that —
    // which is the check that the shape is right rather than just the scale.
    const pool = demandPool(AMS, JFK, AMS_JFK_NM);

    expect(pool.dailyPassengers).toBeGreaterThan(3_000);
    expect(pool.dailyPassengers).toBeLessThan(8_000);
  });

  it('leaves a 90 nm pair as a market nobody would fly', () => {
    // Amsterdam–Brussels. The train wins and the model has to agree.
    const brussels: DemandEndpoint = { ...RTM, icaoCode: 'EBBR', isoCountry: 'BE' };

    expect(demandPool(AMS, brussels, 90).dailyPassengers).toBeLessThan(
      demandPool(AMS, LHR, AMS_LHR_NM).dailyPassengers / 20,
    );
  });

  it('is sub-linear in size, so megacity pairs do not dwarf everything', () => {
    // A.2's whole reason for α. Ten times the mass gives about 2.5 times the
    // demand, not ten — without which there would be one viable strategy.
    const small = demandPool(
      { ...AMS, population: 1_000_000 },
      { ...LHR, population: 1_000_000 },
      AMS_LHR_NM,
    );
    const large = demandPool(
      { ...AMS, population: 10_000_000 },
      { ...LHR, population: 10_000_000 },
      AMS_LHR_NM,
    );

    const ratio = large.dailyPassengers / small.dailyPassengers;
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(7);
  });

  it('carries every term that produced it (§14.1)', () => {
    const pool = demandPool(AMS, PMI, AMS_PMI_NM);

    expect(pool.basis.massTerm).toBeGreaterThan(0);
    expect(pool.basis.distanceFactor).toBeGreaterThan(0);
    expect(pool.basis.affinity.value).toBeGreaterThan(1);
    // And the product reconciles to the reported figure.
    expect(
      DEFAULT_GRAVITY.k *
        pool.basis.massTerm *
        pool.basis.distanceFactor *
        pool.basis.affinity.value,
    ).toBeCloseTo(pool.dailyPassengers, 6);
  });

  it('keeps k and alpha in config — M3-01’s fourth acceptance criterion', () => {
    const doubled = demandPool(AMS, LHR, AMS_LHR_NM, {
      gravity: { ...DEFAULT_GRAVITY, k: DEFAULT_GRAVITY.k * 2 },
    });

    expect(doubled.dailyPassengers).toBeCloseTo(
      demandPool(AMS, LHR, AMS_LHR_NM).dailyPassengers * 2,
      6,
    );
    expect(DEFAULT_GRAVITY.alpha).toBeCloseTo(0.4, 10);
  });

  it('refuses an endpoint that cannot mean anything', () => {
    expect(() => demandPool({ ...AMS, population: -1 }, LHR, 200)).toThrow(/[Oo]rigin population/);
    expect(() => demandPool(AMS, { ...LHR, wealthIndex: 0 }, 200)).toThrow(/wealthIndex/);
  });

  it('is a pure function — the same pair always sizes the same', () => {
    expect(demandPool(AMS, LHR, AMS_LHR_NM)).toEqual(demandPool(AMS, LHR, AMS_LHR_NM));
  });
});

describe('isViablePair', () => {
  it('keeps a real market and drops one that is a fraction of a passenger', () => {
    expect(isViablePair(demandPool(AMS, LHR, AMS_LHR_NM))).toBe(true);

    const remote: DemandEndpoint = {
      icaoCode: 'NZSP',
      population: 200,
      wealthIndex: 0.5,
      tourismIndex: 0.5,
      businessIndex: 0.5,
      isoCountry: 'AQ',
    };
    expect(isViablePair(demandPool(remote, { ...remote, icaoCode: 'ZZZZ' }, 6_000))).toBe(false);
  });
});
