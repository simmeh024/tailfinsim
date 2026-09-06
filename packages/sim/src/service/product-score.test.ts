import { describe, expect, it } from 'vitest';

import {
  PRODUCT_SCORE_TERM_OF_CATEGORY,
  PRODUCT_SCORE_TERMS,
  SERVICE_CATEGORIES,
  ServiceBalance,
  type CabinClass,
  type ServicePackageContent,
} from '@tailfin/shared';

import { DEFAULT_SERVICE } from './bands';
import { packageTermScores, productScore, productScoreForPackage } from './product-score';

/**
 * App. D.6's composite, and M8-04's third acceptance criterion:
 *
 * > Weights per class are config, not code.
 *
 * Tested as behaviour rather than as a file location: change the weights in a
 * balance object and the score moves, with no code change anywhere. The second
 * criterion — that nothing else computes a `ProductScore` — is
 * `product-score-source.test.ts`, which scans the repository for a rival.
 */

const WEIGHTS = DEFAULT_SERVICE.productScoreWeights;

const FULL: ServicePackageContent = {
  perClass: {
    economy: {
      catering: 5,
      baggage_seating: 3,
      amenities: 3,
      onboard_retail: 3,
      atmosphere: 3,
      ife_connectivity: 4,
      ground_services: 4,
    },
  },
  commercialIntensity: 0,
};
const BARE: ServicePackageContent = { perClass: { economy: {} }, commercialIntensity: 0 };

describe('the per-cabin weights', () => {
  it('sums to 1 in every cabin, which is what puts the score on 0–1', () => {
    for (const cabin of Object.keys(WEIGHTS) as CabinClass[]) {
      const weights = WEIGHTS[cabin];
      const total = weights.seat + weights.service + weights.ife + weights.ground;
      expect(total).toBeCloseTo(1, 9);
    }
  });

  it('is refused by the schema when a cabin does not sum to 1', () => {
    // The guard against a retune that quietly produces scores above one.
    const broken = {
      ...DEFAULT_SERVICE,
      productScoreWeights: {
        ...WEIGHTS,
        economy: { seat: 0.5, service: 0.5, ife: 0.2, ground: 0.1 },
      },
    };
    const parsed = ServiceBalance.safeParse(broken);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('must sum to 1');
  });

  it('makes the seat dominate at the front and service dominate at the back', () => {
    // App. D.6: "seat product dominates in business and first, service and price
    // dominate in economy."
    expect(WEIGHTS.economy.service).toBeGreaterThan(WEIGHTS.economy.seat);
    expect(WEIGHTS.business.seat).toBeGreaterThan(WEIGHTS.business.service);
    expect(WEIGHTS.first.seat).toBeGreaterThan(WEIGHTS.business.seat);
  });

  it('is config, not code — a different payload gives a different score', () => {
    const inputs = { seat: 1, service: 0, ife: 0, ground: 0 };
    const shipped = productScore(DEFAULT_SERVICE, 'economy', inputs);
    const seatOnly = productScore(
      {
        ...DEFAULT_SERVICE,
        productScoreWeights: {
          ...WEIGHTS,
          economy: { seat: 1, service: 0, ife: 0, ground: 0 },
        },
      },
      'economy',
      inputs,
    );
    expect(shipped.score).toBeCloseTo(WEIGHTS.economy.seat, 10);
    expect(seatOnly.score).toBe(1);
  });
});

describe('mapping the catalogue onto App. D.6’s four terms', () => {
  it('sends every category somewhere, and only to a real term', () => {
    for (const category of SERVICE_CATEGORIES) {
      expect(PRODUCT_SCORE_TERMS).toContain(PRODUCT_SCORE_TERM_OF_CATEGORY[category]);
    }
  });

  it('leaves the seat term to §6.4 — no category feeds it', () => {
    const terms = packageTermScores(DEFAULT_SERVICE, FULL, 'economy', 1);
    expect(terms.seat).toBeNull();
    expect(terms.service).not.toBeNull();
    expect(terms.ife).not.toBeNull();
    expect(terms.ground).not.toBeNull();
  });

  it('averages the five service categories rather than summing them', () => {
    // A sum of five 0–1 band positions is not a score, and would put `service`
    // on a different scale from `ife` and `ground` — making the weights lie.
    const terms = packageTermScores(DEFAULT_SERVICE, FULL, 'economy', 1);
    expect(terms.service).toBeLessThanOrEqual(1);
    expect(terms.service).toBeGreaterThan(0);
  });

  it('reads the cabin it is asked about, not the one the package describes', () => {
    const terms = packageTermScores(DEFAULT_SERVICE, FULL, 'business', 1);
    // Nothing was configured for business, so every category is at tier 0.
    const economyTerms = packageTermScores(DEFAULT_SERVICE, FULL, 'economy', 1);
    expect(terms.ife!).toBeLessThan(economyTerms.ife!);
  });
});

describe('assembling the score', () => {
  it('is higher for a full package than a bare one, in every cabin', () => {
    for (const cabin of ['economy', 'premium_economy', 'business', 'first'] as CabinClass[]) {
      const full = productScoreForPackage(DEFAULT_SERVICE, {
        content: { ...FULL, perClass: { [cabin]: FULL.perClass.economy } },
        cabin,
        execution: 1,
        seat: null,
      });
      const bare = productScoreForPackage(DEFAULT_SERVICE, {
        content: BARE,
        cabin,
        execution: 1,
        seat: null,
      });
      expect(full.score).toBeGreaterThan(bare.score);
    }
  });

  it('rises with execution, holding the package still', () => {
    const worst = productScoreForPackage(DEFAULT_SERVICE, {
      content: FULL,
      cabin: 'economy',
      execution: 0,
      seat: null,
    });
    const best = productScoreForPackage(DEFAULT_SERVICE, {
      content: FULL,
      cabin: 'economy',
      execution: 1,
      seat: null,
    });
    expect(best.score).toBeGreaterThan(worst.score);
  });

  it('stays on 0–1 at both ends', () => {
    const perfect = productScore(DEFAULT_SERVICE, 'economy', {
      seat: 1,
      service: 1,
      ife: 1,
      ground: 1,
    });
    const nothing = productScore(DEFAULT_SERVICE, 'economy', {
      seat: 0,
      service: 0,
      ife: 0,
      ground: 0,
    });
    expect(perfect.score).toBeCloseTo(1, 10);
    expect(nothing.score).toBe(0);
  });

  it('renormalises around an absent term rather than scoring it zero', () => {
    // The seat model is M6-09 and does not exist. Scored as zero it would cap
    // every business-class product at 1 − 0.5, uniformly, for a reason no player
    // could act on.
    const withoutSeat = productScore(DEFAULT_SERVICE, 'business', {
      seat: null,
      service: 1,
      ife: 1,
      ground: 1,
    });
    const seatAsZero = productScore(DEFAULT_SERVICE, 'business', {
      seat: 0,
      service: 1,
      ife: 1,
      ground: 1,
    });
    expect(withoutSeat.score).toBe(1);
    expect(seatAsZero.score).toBeCloseTo(1 - WEIGHTS.business.seat, 10);
    expect(withoutSeat.absent).toEqual(['seat']);
  });

  it('rescales the surviving weights so they still sum to 1', () => {
    const result = productScore(DEFAULT_SERVICE, 'economy', {
      seat: null,
      service: 1,
      ife: 0,
      ground: 0,
    });
    const total = result.contributions.reduce((sum, entry) => sum + entry.weight, 0);
    expect(total).toBeCloseTo(1, 10);
    // Service was 0.45 of 0.70 of surviving weight — now nearly two-thirds.
    expect(result.contributions.find((c) => c.term === 'service')?.weight).toBeCloseTo(
      WEIGHTS.economy.service / (1 - WEIGHTS.economy.seat),
      10,
    );
  });

  it('says where the score came from, so a payback table can explain it', () => {
    const result = productScoreForPackage(DEFAULT_SERVICE, {
      content: FULL,
      cabin: 'economy',
      execution: 1,
      seat: 0.8,
    });
    expect(result.contributions.map((c) => c.term).sort()).toEqual([
      'ground',
      'ife',
      'seat',
      'service',
    ]);
    const summed = result.contributions.reduce((sum, entry) => sum + entry.contribution, 0);
    expect(summed).toBeCloseTo(result.score, 10);
  });

  it('scores zero when nothing at all is known, rather than guessing', () => {
    const result = productScore(DEFAULT_SERVICE, 'economy', {
      seat: null,
      service: null,
      ife: null,
      ground: null,
    });
    expect(result.score).toBe(0);
    expect(result.absent).toHaveLength(4);
  });
});
