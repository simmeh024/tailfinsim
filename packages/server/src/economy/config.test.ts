import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, economyConfigFor } from './config';

describe('versioned economy configuration', () => {
  it('holds the tunable founding and identity terms', () => {
    expect(ECONOMY_CONFIG_V1).toEqual({
      version: 'v1',
      airlineStartingPosition: {
        openingCashMinor: 50_000_000,
        freeHubAllowance: 1,
      },
      airlineIdentity: {
        rebrandCostMinor: 2_500_000,
      },
    });
  });

  it('resolves exactly the version a world pins rather than falling back', () => {
    expect(economyConfigFor('v1')).toBe(ECONOMY_CONFIG_V1);
    expect(economyConfigFor('not-a-version')).toBeNull();
  });

  it('cannot be mutated after a world has pinned it', () => {
    expect(Object.isFrozen(ECONOMY_CONFIG_V1)).toBe(true);
    expect(Object.isFrozen(ECONOMY_CONFIG_V1.airlineStartingPosition)).toBe(true);
    expect(Object.isFrozen(ECONOMY_CONFIG_V1.airlineIdentity)).toBe(true);
  });
});
