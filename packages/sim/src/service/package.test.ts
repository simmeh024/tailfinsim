import { describe, expect, it } from 'vitest';

import { validateServicePackage, type ServicePackageContent } from '@tailfin/shared';

import { DEFAULT_SERVICE } from './bands';
import {
  intensityRevenueMultiplier,
  intensitySatisfactionPenalty,
  packageEconomics,
  packageScores,
} from './package';

/**
 * What a package costs, earns and scores — and M8-03's second acceptance
 * criterion:
 *
 * > Commercial intensity raises revenue and lowers satisfaction proportionally.
 *
 * "Proportionally" is tested as linearity in both directions at once: half the
 * dial buys half the extra money *and* half the satisfaction cost. A dial that
 * raised revenue faster than it cost satisfaction would quietly make maximum
 * intensity correct, which App. D.2 explicitly does not want — the strategy is
 * to be *"fully supported without being optimal"*.
 */

function pkg(economy: Record<string, number>, commercialIntensity = 0): ServicePackageContent {
  return { perClass: { economy }, commercialIntensity };
}

describe('what a package costs and earns', () => {
  it('adds up the selected rungs, per passenger', () => {
    // Catering tier 3 (€8.40 cost) plus atmosphere tier 2 (€0.40 cost).
    const economics = packageEconomics(
      DEFAULT_SERVICE,
      pkg({ catering: 3, atmosphere: 2 }),
      'economy',
    );
    expect(economics.costPerPaxMinor).toBe(840 + 40);
    expect(economics.netPerPaxMinor).toBe(economics.revenuePerPaxMinor - economics.costPerPaxMinor);
  });

  it('treats a category the package is silent about as tier 0', () => {
    const silent = packageEconomics(DEFAULT_SERVICE, pkg({ catering: 3 }), 'economy');
    const explicit = packageEconomics(
      DEFAULT_SERVICE,
      pkg({ catering: 3, amenities: 0, atmosphere: 0 }),
      'economy',
    );
    expect(silent).toEqual(explicit);
  });

  it('sells a cabin the package does not describe the baseline product', () => {
    // Not "nothing happens". Silence is tier 0 in every category, and tier 0 of
    // `baggage_seating` is "everything charged for" — so an airline that wrote no
    // business-class package still charges business passengers for their bags,
    // and spends nothing on them. That is a real configuration, and the one a
    // player who has not thought about a cabin should get.
    const economics = packageEconomics(DEFAULT_SERVICE, pkg({ catering: 5 }), 'business');
    const baseline = DEFAULT_SERVICE.categories.baggage_seating.tiers[0]!;
    expect(economics.costPerPaxMinor).toBe(0);
    expect(economics.revenuePerPaxMinor).toBe(baseline.revenuePerPaxMinor);
    expect(economics.turnaroundDeltaMinutes).toBe(baseline.turnaroundDeltaMinutes);
    // The catering the package bought for economy does not leak into it.
    expect(economics.costPerPaxMinor).not.toBe(
      DEFAULT_SERVICE.categories.catering.tiers[5]!.costPerPaxMinor,
    );
  });

  it('holds App. D.3’s budget ancillary anchor: bags and seats charged are €13.30', () => {
    const economics = packageEconomics(DEFAULT_SERVICE, pkg({ baggage_seating: 0 }), 'economy');
    expect(economics.revenuePerPaxMinor).toBe(1_330);
    // And the premium config gives all of it away — D.3's "€13.30 forgone".
    expect(
      packageEconomics(DEFAULT_SERVICE, pkg({ baggage_seating: 3 }), 'economy').revenuePerPaxMinor,
    ).toBe(0);
  });

  it('holds App. D.3’s premium Wi-Fi anchor of €2.10', () => {
    expect(
      packageEconomics(DEFAULT_SERVICE, pkg({ ife_connectivity: 4 }), 'economy').costPerPaxMinor,
    ).toBe(210);
  });

  it('sums the turnaround delta, which a budget bag policy makes negative', () => {
    // Charging for cabin bags moves them off the aisle and out of the critical path.
    expect(
      packageEconomics(DEFAULT_SERVICE, pkg({ baggage_seating: 0 }), 'economy')
        .turnaroundDeltaMinutes,
    ).toBe(-1);
    // A full premium package costs minutes on the ground instead.
    expect(
      packageEconomics(DEFAULT_SERVICE, pkg({ catering: 5, amenities: 3 }), 'economy')
        .turnaroundDeltaMinutes,
    ).toBeGreaterThan(0);
  });

  it('keeps money in integer minor units even through the intensity multiplier', () => {
    for (const dial of [0, 0.13, 0.37, 0.5, 0.777, 1]) {
      const economics = packageEconomics(
        DEFAULT_SERVICE,
        pkg({ onboard_retail: 3 }, dial),
        'economy',
      );
      expect(Number.isInteger(economics.revenuePerPaxMinor)).toBe(true);
      expect(Number.isInteger(economics.netPerPaxMinor)).toBe(true);
    }
  });
});

describe('the commercial intensity dial', () => {
  it('does nothing at rest', () => {
    expect(intensityRevenueMultiplier(DEFAULT_SERVICE, 0)).toBe(1);
    expect(intensitySatisfactionPenalty(DEFAULT_SERVICE, 0)).toBe(0);
    const scores = packageScores(DEFAULT_SERVICE, pkg({ onboard_retail: 3 }, 0), 'economy', 1);
    expect(scores.intensityPenalty).toBe(0);
    expect(scores.reputationAtRisk).toBe(false);
  });

  it('raises revenue and lowers satisfaction in the same proportion', () => {
    const atMaxRevenue =
      intensityRevenueMultiplier(DEFAULT_SERVICE, 1) -
      intensityRevenueMultiplier(DEFAULT_SERVICE, 0);
    const atMaxPenalty = intensitySatisfactionPenalty(DEFAULT_SERVICE, 1);

    for (const dial of [0.25, 0.5, 0.75]) {
      const revenueShare =
        (intensityRevenueMultiplier(DEFAULT_SERVICE, dial) -
          intensityRevenueMultiplier(DEFAULT_SERVICE, 0)) /
        atMaxRevenue;
      const penaltyShare = intensitySatisfactionPenalty(DEFAULT_SERVICE, dial) / atMaxPenalty;
      // Same fraction of the maximum on both sides — that is "proportionally".
      expect(revenueShare).toBeCloseTo(dial, 10);
      expect(penaltyShare).toBeCloseTo(dial, 10);
      expect(revenueShare).toBeCloseTo(penaltyShare, 10);
    }
  });

  it('takes the money out of onboard retail and nowhere else', () => {
    const quiet = packageEconomics(
      DEFAULT_SERVICE,
      pkg({ onboard_retail: 3, baggage_seating: 0, catering: 1 }, 0),
      'economy',
    );
    const loud = packageEconomics(
      DEFAULT_SERVICE,
      pkg({ onboard_retail: 3, baggage_seating: 0, catering: 1 }, 1),
      'economy',
    );
    const retailAtRest = DEFAULT_SERVICE.categories.onboard_retail.tiers[3]!.revenuePerPaxMinor;
    const expected = Math.round(
      retailAtRest * DEFAULT_SERVICE.commercialIntensity.revenueMultiplierAtMax,
    );
    // Only the retail line moved; the bag and buy-on-board revenue is untouched.
    expect(loud.revenuePerPaxMinor - quiet.revenuePerPaxMinor).toBe(expected - retailAtRest);
  });

  it('earns nothing extra when there is nothing being sold on board', () => {
    // The dial describes how hard retail is pushed. With retail at tier 0 there
    // is nothing to push, and a package should not be paid for an attitude.
    const quiet = packageEconomics(DEFAULT_SERVICE, pkg({ catering: 2 }, 0), 'economy');
    const loud = packageEconomics(DEFAULT_SERVICE, pkg({ catering: 2 }, 1), 'economy');
    expect(loud.revenuePerPaxMinor).toBe(quiet.revenuePerPaxMinor);
  });

  it('lands App. D.3’s "scratch cards, medium intensity +€0.60"', () => {
    // D.3 prices that line at €0.60 a head *in total* — it is a row of the
    // budget package's ancillary column, not an increment over a quieter dial.
    // So the assertion is on what the line earns, not on what the dial added.
    // Isolated against the same package with nothing sold on board, because a
    // package's revenue also carries the €13.30 of bag and seat fees that tier 0
    // of `baggage_seating` charges by default — D.3 lists those on their own row.
    const medium = packageEconomics(DEFAULT_SERVICE, pkg({ onboard_retail: 3 }, 0.5), 'economy');
    const noRetail = packageEconomics(DEFAULT_SERVICE, pkg({ onboard_retail: 0 }, 0.5), 'economy');
    expect(medium.revenuePerPaxMinor - noRetail.revenuePerPaxMinor).toBe(60);
    // The dial is still doing the work: at rest the same selection earns less.
    const rest = packageEconomics(DEFAULT_SERVICE, pkg({ onboard_retail: 3 }, 0), 'economy');
    expect(rest.revenuePerPaxMinor).toBeLessThan(medium.revenuePerPaxMinor);
  });

  it('costs the retail score, and never drives it below zero', () => {
    const scores = packageScores(DEFAULT_SERVICE, pkg({ onboard_retail: 1 }, 1), 'economy', 0);
    expect(scores.intensityPenalty).toBe(
      DEFAULT_SERVICE.commercialIntensity.satisfactionPenaltyAtMax,
    );
    expect(scores.byCategory.onboard_retail).toBeGreaterThanOrEqual(0);
    // The penalty falls on retail alone; catering is untouched by how hard the
    // trolley is pushed.
    expect(scores.byCategory.catering).toBe(0);
  });

  it('flags the reputation risk only past the configured threshold', () => {
    const threshold = DEFAULT_SERVICE.commercialIntensity.reputationRiskAbove;
    const under = packageScores(
      DEFAULT_SERVICE,
      pkg({ onboard_retail: 3 }, threshold),
      'economy',
      1,
    );
    const over = packageScores(
      DEFAULT_SERVICE,
      pkg({ onboard_retail: 3 }, Math.min(1, threshold + 0.01)),
      'economy',
      1,
    );
    expect(under.reputationAtRisk).toBe(false);
    expect(over.reputationAtRisk).toBe(true);
  });
});

describe('scoring a package', () => {
  it('positions every category by the one execution value', () => {
    const selection = pkg({ catering: 3, ife_connectivity: 2, atmosphere: 1 });
    const worst = packageScores(DEFAULT_SERVICE, selection, 'economy', 0);
    const best = packageScores(DEFAULT_SERVICE, selection, 'economy', 1);
    expect(worst.byCategory.catering).toBeCloseTo(0.45, 10);
    expect(best.byCategory.catering).toBeCloseTo(0.62, 10);
    expect(best.byCategory.ife_connectivity).toBeGreaterThan(worst.byCategory.ife_connectivity);
  });

  it('scores a cabin the package does not describe as an unserved one', () => {
    const scores = packageScores(DEFAULT_SERVICE, pkg({ catering: 5 }), 'first', 1);
    // Tier 0 across the board — and tier 0 is 0 at the floor of its band, but the
    // ceiling of a tier-0 band is not zero, so this asserts the selection, not the score.
    expect(scores.byCategory.catering).toBeCloseTo(
      DEFAULT_SERVICE.categories.catering.tiers[0]!.scoreBand.max,
      10,
    );
  });
});

describe('what the configurator refuses', () => {
  it('accepts a coherent package', () => {
    expect(validateServicePackage(pkg({ catering: 3, amenities: 3 }))).toEqual([]);
  });

  it('refuses a tier the ladder does not have', () => {
    const problems = validateServicePackage(pkg({ catering: 9 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ category: 'catering', code: 'unknown_tier' });
  });

  it('refuses bedding on a flight with no catering', () => {
    // The one shipped cross-category requirement: a duvet and no food is not a
    // premium product, it is a bug in the configurator.
    const problems = validateServicePackage(pkg({ catering: 1, amenities: 3 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ category: 'amenities', code: 'requires' });
    expect(problems[0]?.message).toContain('catering');
  });

  it('reports every problem rather than the first', () => {
    const problems = validateServicePackage({
      perClass: { economy: { catering: 99 }, business: { catering: 0, amenities: 3 } },
      commercialIntensity: 0,
    });
    expect(problems).toHaveLength(2);
    expect(problems.map((p) => p.cabin).sort()).toEqual(['business', 'economy']);
  });
});
