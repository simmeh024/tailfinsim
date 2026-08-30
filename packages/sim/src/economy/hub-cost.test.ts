import { describe, expect, it } from 'vitest';

import type { HubTier } from '@tailfin/shared';

import { DEFAULT_HUB_COST, hubPurchaseCost } from './hub-cost';

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
