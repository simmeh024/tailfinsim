import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, economyConfigFor } from './config';

describe('airline starting position', () => {
  it('is versioned and contains the two tunable founding grants', () => {
    expect(ECONOMY_CONFIG_V1).toEqual({
      version: 'v1',
      airlineStartingPosition: {
        openingCashMinor: 50_000_000,
        freeHubAllowance: 1,
      },
    });
  });

  it('resolves the version a world pins rather than falling back', () => {
    expect(economyConfigFor('v1')).toBe(ECONOMY_CONFIG_V1);
    expect(economyConfigFor('not-a-version')).toBeNull();
  });
});
