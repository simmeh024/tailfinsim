import { describe, expect, it } from 'vitest';

import {
  ECONOMY_CONFIG_V1,
  maxTier,
  SERVICE_CATEGORIES,
  ServiceBalance,
  type ServiceCategory,
} from '@tailfin/shared';

import {
  bandOverlaps,
  bandPosition,
  categoryScore,
  DEFAULT_SERVICE,
  ladderCrossings,
} from './bands';

/**
 * App. D.1's rule, which is M8-03's first acceptance criterion:
 *
 * > No two tier bands overlap after execution is applied — verified with a test
 * > at both extremes.
 *
 * "At both extremes" is the part that matters. Checking the intervals against
 * each other proves the numbers are tidy; checking the **outcomes** proves the
 * promise, because the promise is about what a player experiences: money spent
 * on a higher tier is never wasted by someone else executing a lower one well.
 * So the assertions below run every tier at execution 1 against every tier above
 * it at execution 0 — the most flattering reading of the cheaper service against
 * the least flattering reading of the dearer one.
 */

/** A ladder whose tiers do overlap, for proving the checks can fail. */
function overlappingLadder(): unknown {
  return {
    ...ECONOMY_CONFIG_V1.service,
    categories: {
      ...ECONOMY_CONFIG_V1.service.categories,
      catering: {
        tiers: [
          {
            costPerPaxMinor: 0,
            revenuePerPaxMinor: 0,
            scoreBand: { min: 0, max: 0.5 },
            turnaroundDeltaMinutes: 0,
          },
          {
            costPerPaxMinor: 100,
            revenuePerPaxMinor: 0,
            scoreBand: { min: 0.4, max: 0.9 },
            turnaroundDeltaMinutes: 0,
          },
        ],
      },
    },
  };
}

describe('positioning a tier inside its band', () => {
  it('puts perfect execution at the ceiling and none at the floor', () => {
    const band = { min: 0.45, max: 0.62 };
    expect(bandPosition(band, 0)).toBeCloseTo(0.45, 10);
    expect(bandPosition(band, 1)).toBeCloseTo(0.62, 10);
    expect(bandPosition(band, 0.5)).toBeCloseTo(0.535, 10);
  });

  it('never escapes the band, whatever it is handed', () => {
    const band = { min: 0.45, max: 0.62 };
    for (const execution of [-5, -0.001, 1.001, 42, Number.NaN, Number.POSITIVE_INFINITY]) {
      const score = bandPosition(band, execution);
      expect(score).toBeGreaterThanOrEqual(band.min);
      expect(score).toBeLessThanOrEqual(band.max);
    }
  });

  it('scores an off-ladder tier zero rather than throwing', () => {
    // A package can outlive a catalogue that shrank. The passenger did not get
    // the service; that is not a reason the flight cannot be scored.
    expect(categoryScore(DEFAULT_SERVICE, 'catering', 99, 1)).toBe(0);
  });
});

describe('the shipped catalogue', () => {
  it('quotes App. D.1’s catering ladder exactly', () => {
    // The one ladder the design doc writes out in full. If these move, the doc
    // moved — or somebody retuned the shipped seed without saying so.
    expect(DEFAULT_SERVICE.categories.catering.tiers.map((t) => t.scoreBand)).toEqual([
      { min: 0, max: 0.05 },
      { min: 0.1, max: 0.25 },
      { min: 0.28, max: 0.42 },
      { min: 0.45, max: 0.62 },
      { min: 0.65, max: 0.82 },
      { min: 0.85, max: 1 },
    ]);
    // "−€4.20 (net revenue)" is revenue, not a negative cost.
    expect(DEFAULT_SERVICE.categories.catering.tiers[1]).toMatchObject({
      costPerPaxMinor: 0,
      revenuePerPaxMinor: 420,
    });
    expect(DEFAULT_SERVICE.categories.catering.tiers[3]?.costPerPaxMinor).toBe(840);
    expect(DEFAULT_SERVICE.categories.catering.tiers[5]?.costPerPaxMinor).toBe(7_800);
  });

  it('carries a rung for every tier the catalogue names, and no more', () => {
    for (const category of SERVICE_CATEGORIES) {
      expect(DEFAULT_SERVICE.categories[category].tiers).toHaveLength(maxTier(category) + 1);
    }
  });

  it('starts every ladder at zero — nothing at all is worth nothing', () => {
    for (const category of SERVICE_CATEGORIES) {
      expect(categoryScore(DEFAULT_SERVICE, category, 0, 0)).toBe(0);
    }
  });

  it('never lets a perfectly executed tier reach a badly executed higher one', () => {
    // The acceptance criterion, at both extremes, over every pair of tiers in
    // every category — not only adjacent ones.
    expect(ladderCrossings(DEFAULT_SERVICE)).toEqual([]);
  });

  it('holds App. D.1’s worked example: a flawless Tier 2 loses to a botched Tier 3', () => {
    const perfectTier2 = categoryScore(DEFAULT_SERVICE, 'catering', 2, 1);
    const botchedTier3 = categoryScore(DEFAULT_SERVICE, 'catering', 3, 0);
    expect(perfectTier2).toBeCloseTo(0.42, 10);
    expect(botchedTier3).toBeCloseTo(0.45, 10);
    expect(perfectTier2).toBeLessThan(botchedTier3);
  });

  it('has no touching bands either', () => {
    expect(bandOverlaps(DEFAULT_SERVICE)).toEqual([]);
  });

  it('moves the money one way up every ladder, in the direction that ladder sells', () => {
    // The band rule's economic twin: a tier that scored higher and cost less
    // would make every tier below it unreachable as a decision.
    //
    // The direction is not the same for every category, and that is App. D's
    // design rather than an inconsistency. Five ladders are **spend**: you buy
    // score, so net cost rises. `onboard_retail` is a **revenue** ladder — every
    // rung sells more to the same passenger — so its net cost falls, and its
    // price is paid in the satisfaction band, not in money.
    const revenueLadders = new Set<ServiceCategory>(['onboard_retail']);
    for (const category of SERVICE_CATEGORIES) {
      const net = DEFAULT_SERVICE.categories[category].tiers.map(
        (tier) => tier.costPerPaxMinor - tier.revenuePerPaxMinor,
      );
      // Catering tier 1 is the documented exception: App. D.1 writes buy-on-board
      // as "−€4.20 (net revenue)", so it undercuts tier 0's free nothing. From
      // tier 1 up, spend rises like everything else.
      const from = category === 'catering' ? 2 : 1;
      for (let i = from; i < net.length; i += 1) {
        if (revenueLadders.has(category)) expect(net[i]!).toBeLessThan(net[i - 1]!);
        else expect(net[i]!).toBeGreaterThan(net[i - 1]!);
      }
    }
    // And the exception itself, asserted rather than merely skipped.
    const catering = DEFAULT_SERVICE.categories.catering.tiers;
    expect(catering[1]!.revenuePerPaxMinor).toBeGreaterThan(catering[0]!.revenuePerPaxMinor);
  });
});

describe('the schema’s refusal to store an overlapping ladder', () => {
  it('rejects a ladder whose bands cross', () => {
    const parsed = ServiceBalance.safeParse(overlappingLadder());
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('badly executed higher one');
  });

  it('rejects a ladder whose bands merely touch', () => {
    const touching = overlappingLadder() as {
      categories: { catering: { tiers: { scoreBand: { min: number } }[] } };
    };
    // Tier 1 starting exactly where tier 0 ends is still a tie, and a tie means
    // a perfect Tier 0 equals a botched Tier 1.
    touching.categories.catering.tiers[1]!.scoreBand.min = 0.5;
    expect(ServiceBalance.safeParse(touching).success).toBe(false);
  });

  it('rejects a ladder that does not start at zero', () => {
    const raised = {
      ...ECONOMY_CONFIG_V1.service,
      categories: {
        ...ECONOMY_CONFIG_V1.service.categories,
        atmosphere: {
          tiers: [
            {
              costPerPaxMinor: 0,
              revenuePerPaxMinor: 0,
              scoreBand: { min: 0.2, max: 0.3 },
              turnaroundDeltaMinutes: 0,
            },
          ],
        },
      },
    };
    const parsed = ServiceBalance.safeParse(raised);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('nothing at all is the bottom');
  });

  it('accepts the shipped catalogue, which is the same check the seed already passed', () => {
    expect(ServiceBalance.safeParse(DEFAULT_SERVICE).success).toBe(true);
  });
});

describe('the crossing check itself', () => {
  it('finds a crossing when there is one, so a green run means something', () => {
    // The guard against a check that passes because it looks at nothing.
    const broken = {
      ...DEFAULT_SERVICE,
      categories: {
        ...DEFAULT_SERVICE.categories,
        catering: {
          tiers: [
            {
              costPerPaxMinor: 0,
              revenuePerPaxMinor: 0,
              scoreBand: { min: 0, max: 0.5 },
              turnaroundDeltaMinutes: 0,
            },
            {
              costPerPaxMinor: 100,
              revenuePerPaxMinor: 0,
              scoreBand: { min: 0.4, max: 0.9 },
              turnaroundDeltaMinutes: 0,
            },
          ],
        },
      },
    };
    const crossings = ladderCrossings(broken);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toMatchObject({
      category: 'catering' satisfies ServiceCategory,
      lowerTier: 0,
      higherTier: 1,
    });
  });
});
