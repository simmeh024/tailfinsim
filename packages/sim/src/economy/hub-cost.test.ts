import { describe, expect, it } from 'vitest';

import type { HubTier } from '@tailfin/shared';

import {
  DEFAULT_HUB_COST,
  hubAnnualFee,
  hubAnnualUpkeep,
  hubFacilityCost,
  hubMonthlyUpkeep,
  hubPurchaseCost,
} from './hub-cost';

/**
 * The hub purchase curve is App. B.5 turned into a function, so it is checked
 * against App. B.5's own table — every cell through hub 8 — and against the two
 * scenarios the design doc uses to show the strategic tension.
 */

/** Minor units per $1M, at the 100-per-unit scale the config uses. */
const M = 100_000_000;

// App. B.5's table, in $M, indexed by hubs already owned (0 = the free first hub).
const TABLE: Record<HubTier, number[]> = {
  small: [0, 2, 4, 8, 16, 32, 64, 128],
  medium: [0, 5, 10, 20, 40, 80, 160, 320],
  large: [0, 10, 20, 40, 80, 160, 320, 640],
  flagship: [0, 25, 50, 100, 200, 400, 800, 1600],
};

describe('hubPurchaseCost', () => {
  it('reproduces the App. B.5 cost table exactly through hub 8', () => {
    for (const tier of Object.keys(TABLE) as HubTier[]) {
      TABLE[tier].forEach((millions, hubsOwned) => {
        expect(hubPurchaseCost(tier, hubsOwned), `${tier} hub #${String(hubsOwned + 1)}`).toBe(
          millions * M,
        );
      });
    }
  });

  it('makes the first hub free at any tier', () => {
    for (const tier of Object.keys(TABLE) as HubTier[]) {
      expect(hubPurchaseCost(tier, 0)).toBe(0);
    }
  });

  it('costs $375M for four flagships taken as hubs 2–5', () => {
    // hubs_owned 1,2,3,4 → 25 + 50 + 100 + 200 = 375M.
    const total = [1, 2, 3, 4].reduce((sum, owned) => sum + hubPurchaseCost('flagship', owned), 0);
    expect(total).toBe(375 * M);
  });

  it('costs $14M + $3,000M for three smalls first, then four flagships', () => {
    // Free first hub, then three smalls as hubs 2–4 (owned 1,2,3)…
    const smalls = [1, 2, 3].reduce((sum, owned) => sum + hubPurchaseCost('small', owned), 0);
    // …then four flagships as hubs 5–8 (owned 4,5,6,7).
    const flagships = [4, 5, 6, 7].reduce(
      (sum, owned) => sum + hubPurchaseCost('flagship', owned),
      0,
    );
    expect(smalls).toBe(14 * M);
    expect(flagships).toBe(3_000 * M);
    // Buying $14M of convenience early costs $2.6B more later — the doc's point.
    expect(flagships - 375 * M).toBe(2_625 * M);
  });

  it('reads the shipped tier bases and doubling growth from the config', () => {
    expect(DEFAULT_HUB_COST.tierBaseMinor.flagship).toBe(25 * M);
    expect(DEFAULT_HUB_COST.costGrowth).toBe(2);
  });

  it('rejects a negative or fractional hub count', () => {
    expect(() => hubPurchaseCost('small', -1)).toThrow();
    expect(() => hubPurchaseCost('small', 1.5)).toThrow();
  });
});

/**
 * The upkeep half (M7-04). App. B.5 fixes no figures for these, so what is
 * asserted is the *shape* the doc does fix — fees rise with tier, facilities
 * scale off the same tier base, and the free first hub is still not free to hold.
 */
describe('hub upkeep', () => {
  it('charges an annual fee that rises with every tier', () => {
    const fees = (['small', 'medium', 'large', 'flagship'] as const).map((t) => hubAnnualFee(t));
    expect(fees).toEqual([...fees].sort((a, b) => a - b));
    expect(new Set(fees).size).toBe(4);
  });

  it('keeps the annual fee at 2% of the tier base, the anchor it was tuned to', () => {
    for (const tier of ['small', 'medium', 'large', 'flagship'] as const) {
      expect(hubAnnualFee(tier)).toBe(DEFAULT_HUB_COST.tierBaseMinor[tier] * 0.02);
    }
  });

  it('makes the free first hub free to buy and never free to hold', () => {
    // The whole of App. B.5's self-balancing argument for the free flagship:
    // acquisition is waived, upkeep is not.
    expect(hubPurchaseCost('flagship', 0)).toBe(0);
    expect(hubAnnualFee('flagship')).toBeGreaterThan(0);
    expect(hubMonthlyUpkeep('flagship', [])).toBeGreaterThan(0);
  });

  it('prices a facility off its hub tier, so a flagship lounge costs 12.5x a small one', () => {
    const small = hubFacilityCost('lounge', 'small');
    const flagship = hubFacilityCost('lounge', 'flagship');
    const ratio = DEFAULT_HUB_COST.tierBaseMinor.flagship / DEFAULT_HUB_COST.tierBaseMinor.small;
    expect(ratio).toBe(12.5);
    expect(flagship.openingMinor).toBe(small.openingMinor * ratio);
    expect(flagship.annualFeeMinor).toBe(small.annualFeeMinor * ratio);
  });

  it('makes heavy check the dearest facility and the lounge the cheapest', () => {
    const at = (kind: Parameters<typeof hubFacilityCost>[0]) =>
      hubFacilityCost(kind, 'medium').openingMinor;
    expect(at('heavy_check')).toBeGreaterThan(at('self_handling'));
    expect(at('self_handling')).toBeGreaterThan(at('maintenance_line'));
    expect(at('maintenance_line')).toBeGreaterThan(at('training_academy'));
    expect(at('training_academy')).toBeGreaterThan(at('lounge'));
  });

  it('adds every open facility to the hub bill, and counts a duplicate once', () => {
    const bare = hubAnnualUpkeep('medium', []);
    expect(bare).toBe(hubAnnualFee('medium'));

    const withLounge = hubAnnualUpkeep('medium', ['lounge']);
    expect(withLounge).toBe(bare + hubFacilityCost('lounge', 'medium').annualFeeMinor);

    // The database cannot hold two of the same facility at one hub; charging
    // twice for a caller's mistake would be the wrong way to discover that.
    expect(hubAnnualUpkeep('medium', ['lounge', 'lounge'])).toBe(withLounge);
  });

  it('bills a twelfth a month, rounding the instalment rather than the year', () => {
    const annual = hubAnnualUpkeep('large', ['lounge', 'maintenance_line']);
    expect(hubMonthlyUpkeep('large', ['lounge', 'maintenance_line'])).toBe(Math.round(annual / 12));
  });

  it('returns integer minor units for every tier and facility', () => {
    for (const tier of ['small', 'medium', 'large', 'flagship'] as const) {
      expect(Number.isSafeInteger(hubAnnualFee(tier))).toBe(true);
      expect(Number.isSafeInteger(hubMonthlyUpkeep(tier, ['heavy_check']))).toBe(true);
      for (const kind of [
        'training_academy',
        'maintenance_line',
        'heavy_check',
        'lounge',
        'self_handling',
      ] as const) {
        const cost = hubFacilityCost(kind, tier);
        expect(Number.isSafeInteger(cost.openingMinor)).toBe(true);
        expect(Number.isSafeInteger(cost.annualFeeMinor)).toBe(true);
      }
    }
  });

  it('makes a fully built small hub cost about 2.75x the hub itself', () => {
    // The stated intent of the shipped fractions: facilities are the larger half
    // of a hub's lifetime bill, which is what makes siting them a decision.
    const base = DEFAULT_HUB_COST.tierBaseMinor.small;
    const build = (
      ['training_academy', 'maintenance_line', 'heavy_check', 'lounge', 'self_handling'] as const
    ).reduce((sum, kind) => sum + hubFacilityCost(kind, 'small').openingMinor, 0);
    expect(build / base).toBeCloseTo(2.75, 10);
  });
});
