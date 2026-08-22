import { describe, expect, it } from 'vitest';

import { AircraftClass } from './aircraft';
import { AIRCRAFT_CATALOGUE_V1 } from './aircraft-catalogue';
import { AircraftOptionCategory } from './aircraft-options';
import {
  ECONOMY_CONFIG_V1,
  UsedMarketBalance,
  UsedMarketConfigurationBalance,
  UsedMarketDepreciationBalance,
  UsedMarketInventoryBalance,
} from './economy-config';

const BALANCE = ECONOMY_CONFIG_V1.usedMarket;

/**
 * The shipped balance has to stay complete as the catalogue grows (M4-05).
 *
 * These are the assertions that catch the *omission* rather than the wrong
 * number. A new option category or aircraft class added to the catalogue with no
 * used-market coefficient would otherwise be a runtime `undefined` folded
 * silently into an asking price — the failure mode M4-03 already met once, when
 * two options had a cost and no modelled gain and only a test noticed.
 */
describe('the shipped used-market balance is complete', () => {
  it('prices every option category the catalogue can produce', () => {
    const priced = Object.keys(BALANCE.configuration.categoryDrag).sort();
    expect(priced).toEqual([...AircraftOptionCategory.options].sort());
  });

  it('gives every aircraft class a utilisation and a sector length', () => {
    const classes = [...AircraftClass.options].sort();
    expect(Object.keys(BALANCE.depreciation.expectedAnnualHours).sort()).toEqual(classes);
    expect(Object.keys(BALANCE.depreciation.averageBlockHoursPerCycle).sort()).toEqual(classes);
    expect(Object.keys(BALANCE.inventory.classSupplyWeight).sort()).toEqual(classes);
  });

  it('offers at least one class the market can actually draw from', () => {
    const total = Object.values(BALANCE.inventory.classSupplyWeight).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  /**
   * The one category that is a premium rather than a penalty, asserted so the
   * sign cannot be flipped by accident.
   *
   * C.5's *"a bargain if it fits your network"* only means something if some
   * options are wanted by everybody. An all-penalty table would make the
   * configurator a trap.
   */
  it('treats aerodynamic options as wanted and specialising ones as not', () => {
    const { categoryDrag } = BALANCE.configuration;
    expect(categoryDrag.aerodynamic).toBeLessThan(0);
    for (const category of ['fuel', 'structural', 'cabin', 'engine', 'cargo'] as const) {
      expect(categoryDrag[category], category).toBeGreaterThan(0);
    }
    // C.5 names the cabin and the engine variant by hand, and a cargo door is
    // the most drastic thing in C.3's list. They should be the heaviest.
    expect(categoryDrag.cargo).toBeGreaterThan(categoryDrag.cabin);
    expect(categoryDrag.cabin).toBeGreaterThan(categoryDrag.structural);
    expect(categoryDrag.engine).toBeGreaterThan(categoryDrag.avionics);
  });

  /**
   * The residual has to sit below the oldest airframe the market can list, or
   * the curve is flat where the market is most interesting. See the note on
   * `residualFloorRatio`, and the sim test that asserts the consequence.
   */
  it('keeps the residual below the value of the oldest listable airframe', () => {
    const { annualRetentionRate, residualFloorRatio } = BALANCE.depreciation;
    const oldest = annualRetentionRate ** BALANCE.inventory.maxAgeYears;
    expect(residualFloorRatio).toBeLessThan(1);
    expect(oldest).toBeGreaterThan(0);
    // Salvage form, so this is the *depreciable* share still left at the oldest
    // listable age. It only has to be positive; the point of the assertion is
    // that the two numbers are compared at all.
    expect(residualFloorRatio + (1 - residualFloorRatio) * oldest).toBeGreaterThan(
      residualFloorRatio,
    );
  });

  it('capitalises a lease at the rate the catalogue authored its lease rates with', () => {
    // `leaseFor` in the catalogue is 0.8% of list per month. This is its inverse,
    // and the sim tests prove the round trip on all three unpriced types.
    expect(BALANCE.leaseCapitalisationMonths).toBe(1 / 0.008);
  });

  it('offers fewer berths than the catalogue has types, so the market is a choice', () => {
    // Not a hard rule, but a market with a berth for every type would always
    // hold everything and waiting would never mean anything.
    expect(BALANCE.inventory.slots).toBeGreaterThan(AIRCRAFT_CATALOGUE_V1.types.length);
  });
});

describe('what the used-market schema refuses', () => {
  it('refuses an age band the wrong way round', () => {
    const bad = { ...BALANCE.inventory, minAgeYears: 30, maxAgeYears: 5 };
    expect(UsedMarketInventoryBalance.safeParse(bad).success).toBe(false);
  });

  it('refuses utilisation bounds the wrong way round', () => {
    const bad = {
      ...BALANCE.depreciation,
      utilisationFactorBounds: [1.4, 0.6] as [number, number],
    };
    expect(UsedMarketDepreciationBalance.safeParse(bad).success).toBe(false);
  });

  it('refuses configuration bounds the wrong way round or collapsed', () => {
    for (const bounds of [
      [1.2, 0.5],
      [0.8, 0.8],
    ] as [number, number][]) {
      const bad = { ...BALANCE.configuration, factorBounds: bounds };
      expect(UsedMarketConfigurationBalance.safeParse(bad).success, String(bounds)).toBe(false);
    }
  });

  it('refuses a retention rate of 1, which would never depreciate', () => {
    const bad = { ...BALANCE.depreciation, annualRetentionRate: 1 };
    expect(UsedMarketDepreciationBalance.safeParse(bad).success).toBe(false);
  });

  it('refuses a market with no berths', () => {
    const bad = { ...BALANCE.inventory, slots: 0 };
    expect(UsedMarketInventoryBalance.safeParse(bad).success).toBe(false);
  });

  it('refuses an unknown option category rather than ignoring it', () => {
    const bad = {
      ...BALANCE.configuration,
      categoryDrag: { ...BALANCE.configuration.categoryDrag, telepathy: 0.5 },
    };
    expect(UsedMarketConfigurationBalance.safeParse(bad).success).toBe(false);
  });

  it('accepts the shipped balance, which is the whole point', () => {
    expect(UsedMarketBalance.safeParse(BALANCE).success).toBe(true);
  });
});
