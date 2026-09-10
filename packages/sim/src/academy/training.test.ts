import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, type AcademyCommissionedLevel } from '@tailfin/shared';

import { trainingRoute, type TrainingAcademyState } from './training';

const balance = ECONOMY_CONFIG_V1.academy;
/** The market rate a course is bought in at — `crew.conversion.costPerHeadMinor`. */
const MARKET = ECONOMY_CONFIG_V1.crew.conversion.costPerHeadMinor;

function academy(
  level: AcademyCommissionedLevel,
  modules: TrainingAcademyState['modules'],
  slotsInUse = 0,
): TrainingAcademyState {
  return { level, modules, slotsInUse };
}

const CBT = { kind: 'cbt_suite', family: null } as const;
const MOCKUP = { kind: 'cabin_service_mockup', family: null } as const;
const FBS = { kind: 'fixed_base_sim', family: null } as const;
const ffs = (family: string) => ({ kind: 'full_flight_sim', family }) as const;

function route(overrides: Partial<Parameters<typeof trainingRoute>[0]> = {}) {
  return trainingRoute({
    academy: null,
    rank: 'first_officer',
    toFamily: 'A320',
    heads: 2,
    outsourcedPerHeadMinor: MARKET,
    balance,
    ...overrides,
  });
}

/**
 * Where a conversion is trained (M9-01, §10.1).
 *
 * The decision this file defends is that the academy is a **discount and a
 * ceiling, never a gate**. Every "outsourced" case below is a case that used to
 * work before M9-01 and still works — which is the whole reason the reading was
 * chosen, and the thing a later change would most plausibly break by accident.
 */
describe('without an academy', () => {
  it('buys the course in at the market rate, exactly as M5-01 did', () => {
    const result = route();
    expect(result.mode).toBe('outsourced');
    expect(result.costPerHeadMinor).toBe(MARKET);
    expect(result.outsourcedBecause).toBe('no_academy');
    expect(result.provider).toBeNull();
  });

  it('still refuses nothing — a base with no academy can convert crew', () => {
    // §10.1's "a base without one can only hire pre-qualified crew at market
    // rates" is a price, not a refusal. There is no `mode: 'refused'` to return.
    for (const rank of ['cabin_crew', 'captain', 'training_captain'] as const) {
      expect(route({ rank }).mode).toBe('outsourced');
    }
  });
});

describe('a building site', () => {
  it('trains nobody, however much has been spent on it', () => {
    const result = route({ academy: academy(0, [CBT, FBS]) });
    expect(result.mode).toBe('outsourced');
    expect(result.outsourcedBecause).toBe('not_commissioned');
    expect(result.costPerHeadMinor).toBe(MARKET);
  });
});

describe('the level ceiling', () => {
  it('sends a rank above the ceiling to the market', () => {
    // Level 3 tops out at Senior FO; a Captain conversion is bought in.
    const result = route({ academy: academy(3, [CBT, FBS]), rank: 'captain' });
    expect(result.outsourcedBecause).toBe('rank_above_ceiling');
  });

  it('trains that same rank once the building reaches level 4', () => {
    const result = route({ academy: academy(4, [CBT, FBS]), rank: 'captain' });
    expect(result.mode).toBe('in_house');
  });
});

describe('the modules', () => {
  it('teaches nothing in-house without a CBT suite', () => {
    const result = route({ academy: academy(4, [FBS]) });
    expect(result.outsourcedBecause).toBe('no_cbt_suite');
  });

  it('needs a flight-deck module for a pilot and a mock-up for cabin crew', () => {
    expect(route({ academy: academy(4, [CBT, MOCKUP]) }).outsourcedBecause).toBe('no_module');
    expect(route({ academy: academy(4, [CBT, FBS]), rank: 'cabin_crew' }).outsourcedBecause).toBe(
      'no_module',
    );
  });

  it('charges the fixed-base rate when that is all there is', () => {
    const result = route({ academy: academy(4, [CBT, FBS]) });
    expect(result.mode).toBe('in_house');
    expect(result.provider).toBe('fixed_base_sim');
    expect(result.costPerHeadMinor).toBe(
      Math.round(MARKET * balance.inHouseConversionRate.fixedBaseSim),
    );
  });

  it('charges the simulator rate for the target family — §10.1’s own sentence', () => {
    const result = route({ academy: academy(4, [CBT, FBS, ffs('A320')]) });
    expect(result.provider).toBe('full_flight_sim');
    expect(result.costPerHeadMinor).toBe(
      Math.round(MARKET * balance.inHouseConversionRate.fullFlightSim),
    );
    expect(result.costPerHeadMinor).toBeLessThan(MARKET);
  });

  it('ignores a simulator for a different family, and falls back to the sim it has', () => {
    // A 737 box teaches nothing about an A320, which is what makes fleet
    // commonality pay a second time inside the academy.
    const result = route({ academy: academy(4, [CBT, FBS, ffs('B737')]), toFamily: 'A320' });
    expect(result.provider).toBe('fixed_base_sim');
  });

  it('buys the course in when the wrong-family simulator is the only module', () => {
    const result = route({ academy: academy(4, [CBT, ffs('B737')]), toFamily: 'A320' });
    expect(result.outsourcedBecause).toBe('no_module');
    expect(result.costPerHeadMinor).toBe(MARKET);
  });

  it('trains cabin crew through the mock-up', () => {
    const result = route({ academy: academy(4, [CBT, MOCKUP]), rank: 'purser' });
    expect(result.provider).toBe('cabin_mockup');
    expect(result.costPerHeadMinor).toBe(
      Math.round(MARKET * balance.inHouseConversionRate.cabinMockup),
    );
  });
});

/** AC2: *"Training slots are finite and visibly consume crew availability."* */
describe('the slot limit', () => {
  const equipped = (slotsInUse: number) => academy(2, [CBT, FBS], slotsInUse);

  it('trains in-house while there is room for the whole course', () => {
    // Level 2 has ten slots in the shipped balance.
    const slots = balance.levels['2'].trainingSlots;
    expect(route({ academy: equipped(slots - 2), heads: 2 }).mode).toBe('in_house');
  });

  it('counts heads, not courses — a course of ten fills ten slots', () => {
    const slots = balance.levels['2'].trainingSlots;
    expect(route({ academy: equipped(0), heads: slots }).mode).toBe('in_house');
    expect(route({ academy: equipped(0), heads: slots + 1 }).outsourcedBecause).toBe('slots_full');
  });

  it('sends the overflow to the market rather than refusing it', () => {
    const full = route({ academy: equipped(balance.levels['2'].trainingSlots), heads: 1 });
    expect(full.mode).toBe('outsourced');
    expect(full.outsourcedBecause).toBe('slots_full');
    expect(full.costPerHeadMinor).toBe(MARKET);
  });

  it('checks the slot last, so the interface can tell "cannot" from "not yet"', () => {
    /*
     * A full academy that also lacks the module reports the module, because
     * that is the one the player has to act on first. Ordering, not cosmetics:
     * "wait for a slot" on an academy that could never teach this course would
     * send somebody away to wait for nothing.
     */
    const result = route({ academy: academy(4, [CBT], 999), rank: 'captain' });
    expect(result.outsourcedBecause).toBe('no_module');
  });
});

describe('the whole course goes one way', () => {
  it('never splits a course between in-house and bought-in places', () => {
    // Four free slots, a course of six: all six are bought in, at one price.
    const result = route({ academy: academy(1, [CBT, MOCKUP], 0), rank: 'cabin_crew', heads: 6 });
    expect(balance.levels['1'].trainingSlots).toBeLessThan(6);
    expect(result.mode).toBe('outsourced');
    expect(result.costPerHeadMinor).toBe(MARKET);
  });
});
