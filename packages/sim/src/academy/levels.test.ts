import { describe, expect, it } from 'vitest';

import {
  ACADEMY_LEVELS,
  ACADEMY_MAX_LEVEL,
  ACADEMY_MODULE_KINDS,
  ACADEMY_MODULES,
  academyLevelDefinition,
  CabinRank,
  CrewRank,
  ECONOMY_CONFIG_V1,
  FlightDeckRank,
  SHIPPED_ACADEMY_BALANCE,
  type AcademyLevel,
} from '@tailfin/shared';

import {
  academyMonthlyUpkeep,
  academyPermitsRank,
  academyResearchTier,
  academyTrainingSlots,
  buildCompletesAt,
  crewLadderOf,
  levelBalance,
  nextAcademyLevel,
} from './levels';

const balance = ECONOMY_CONFIG_V1.academy;
const LEVELS = [1, 2, 3, 4, 5] as const satisfies readonly AcademyLevel[];

/**
 * §10.1's ladder (M9-01).
 *
 * The three acceptance criteria are what these tests are for, and the first is
 * the one most easily lost: *"levelling the academy unlocks researchable tiers
 * but grants no boost by itself"*. Proving an absence needs a structural test
 * rather than an assertion about one number, so the module's whole exported
 * surface is checked for anything that could be a multiplier.
 */
describe('the academy ladder', () => {
  it('is the five levels of §10.1, in order and with no gaps', () => {
    expect(ACADEMY_LEVELS.map((row) => row.level)).toEqual([1, 2, 3, 4, 5]);
    expect(ACADEMY_LEVELS).toHaveLength(ACADEMY_MAX_LEVEL);
    expect(ACADEMY_LEVELS.map((row) => row.name)).toEqual([
      'Training Room',
      'Training Centre',
      'Flight Academy',
      'Full-Flight Sim Centre',
      'Centre of Excellence',
    ]);
  });

  it('raises both rank ceilings monotonically — a level never takes one away', () => {
    const flightDeck = FlightDeckRank.options;
    const cabin = CabinRank.options;
    for (let index = 1; index < ACADEMY_LEVELS.length; index += 1) {
      const previous = ACADEMY_LEVELS[index - 1];
      const current = ACADEMY_LEVELS[index];
      if (previous === undefined || current === undefined) throw new Error('ladder gap');

      const previousDeck =
        previous.flightDeckUpTo === null ? -1 : flightDeck.indexOf(previous.flightDeckUpTo);
      const currentDeck =
        current.flightDeckUpTo === null ? -1 : flightDeck.indexOf(current.flightDeckUpTo);
      expect(currentDeck).toBeGreaterThan(previousDeck);

      expect(cabin.indexOf(current.cabinUpTo)).toBeGreaterThanOrEqual(
        cabin.indexOf(previous.cabinUpTo),
      );
      expect(current.researchTier).toBeGreaterThanOrEqual(previous.researchTier);
    }
  });

  it('trains nobody on the flight deck at level 1 — a training room is not a sim', () => {
    expect(academyLevelDefinition(1)?.flightDeckUpTo).toBeNull();
    for (const rank of FlightDeckRank.options) {
      expect(academyPermitsRank(1, rank)).toBe(false);
    }
    // It still trains the rank §10.1 puts there.
    expect(academyPermitsRank(1, 'cabin_crew')).toBe(true);
    expect(academyPermitsRank(1, 'senior_cabin_crew')).toBe(false);
  });

  it('permits every rank at level 5 and none at level 0', () => {
    for (const rank of CrewRank.options) {
      expect(academyPermitsRank(5, rank)).toBe(true);
      // A building site is the third acceptance criterion in one assertion:
      // the capital is spent, and nothing has arrived early.
      expect(academyPermitsRank(0, rank)).toBe(false);
    }
  });

  it('reaches Captain only at level 4 and Training Captain only at level 5', () => {
    expect(academyPermitsRank(3, 'captain')).toBe(false);
    expect(academyPermitsRank(4, 'captain')).toBe(true);
    expect(academyPermitsRank(4, 'training_captain')).toBe(false);
    expect(academyPermitsRank(5, 'training_captain')).toBe(true);
  });

  it('puts every rank on exactly one ladder', () => {
    for (const rank of FlightDeckRank.options) expect(crewLadderOf(rank)).toBe('flight_deck');
    for (const rank of CabinRank.options) expect(crewLadderOf(rank)).toBe('cabin');
  });
});

/**
 * AC1: *"Levelling the academy unlocks researchable tiers but grants no boost
 * by itself."*
 */
describe('a level is permission, never power', () => {
  it('raises the research tier ceiling, and that ceiling is all it is', () => {
    expect(academyResearchTier(0)).toBeNull();
    expect(LEVELS.map((level) => academyResearchTier(level))).toEqual([1, 1, 2, 3, 4]);
  });

  it('exposes nothing a level could multiply a flight by', () => {
    /*
     * The structural half of AC1. A boost would arrive as a rate, a factor or a
     * percentage hanging off a level, so the level definitions are checked for
     * having no numeric field beyond the two ceilings — a new `fuelBurnBonus`
     * fails here rather than in a review.
     */
    for (const row of ACADEMY_LEVELS) {
      const numericFields = Object.entries(row)
        .filter(([, value]) => typeof value === 'number')
        .map(([key]) => key);
      expect(numericFields.sort()).toEqual(['level', 'researchTier']);
    }
  });

  it('says nothing about how well anybody flies — only how far they may train', () => {
    // The balance's own shape: every per-level number is a price, a duration or
    // a count of places. None of them is a coefficient.
    for (const level of LEVELS) {
      expect(Object.keys(levelBalance(level, balance)).sort()).toEqual([
        'buildWeeks',
        'capitalCostMinor',
        'monthlyUpkeepMinor',
        'trainingSlots',
      ]);
    }
  });
});

/** AC2: *"Training slots are finite."* */
describe('training slots', () => {
  it('is zero while the first level is still going up', () => {
    expect(academyTrainingSlots(0, balance)).toBe(0);
  });

  it('is finite at every level, and grows with the building', () => {
    const counts = LEVELS.map((level) => academyTrainingSlots(level, balance));
    for (const count of counts) expect(Number.isFinite(count)).toBe(true);
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]).toBeGreaterThan(counts[index - 1] ?? 0);
    }
  });
});

/** AC3: *"Build time … cannot be shortened with money."* */
describe('build time', () => {
  it('depends on the weeks and on nothing else', () => {
    const start = new Date('2026-03-01T00:00:00.000Z');
    expect(buildCompletesAt(start, 4).toISOString()).toBe('2026-03-29T00:00:00.000Z');
    // Same start, same weeks, same answer — there is no third input a payment
    // could reach, which is the criterion held structurally.
    expect(buildCompletesAt(start, 4)).toEqual(buildCompletesAt(start, 4));
    expect(buildCompletesAt(start, 1).getTime()).toBeLessThan(buildCompletesAt(start, 2).getTime());
  });

  it('takes longer at every level up the ladder', () => {
    const weeks = LEVELS.map((level) => levelBalance(level, balance).buildWeeks);
    for (let index = 1; index < weeks.length; index += 1) {
      expect(weeks[index]).toBeGreaterThan(weeks[index - 1] ?? 0);
    }
  });
});

describe('upkeep', () => {
  it('charges nothing for a building site', () => {
    expect(academyMonthlyUpkeep(0, [], balance)).toBe(0);
  });

  it('adds every operational module to the level fee', () => {
    const level3 = levelBalance(3, balance).monthlyUpkeepMinor;
    expect(academyMonthlyUpkeep(3, [], balance)).toBe(level3);
    expect(academyMonthlyUpkeep(3, ['cbt_suite'], balance)).toBe(
      level3 + balance.modules.cbt_suite.monthlyUpkeepMinor,
    );
    expect(academyMonthlyUpkeep(3, ['cbt_suite', 'fixed_base_sim'], balance)).toBe(
      level3 +
        balance.modules.cbt_suite.monthlyUpkeepMinor +
        balance.modules.fixed_base_sim.monthlyUpkeepMinor,
    );
  });
});

describe('the module table', () => {
  it('describes every kind in the enum, and no others', () => {
    expect(ACADEMY_MODULES.map((row) => row.kind).sort()).toEqual([...ACADEMY_MODULE_KINDS].sort());
    expect(Object.keys(balance.modules).sort()).toEqual([...ACADEMY_MODULE_KINDS].sort());
  });

  it('marks exactly the full-flight sim as per-family', () => {
    expect(ACADEMY_MODULES.filter((row) => row.perFamily).map((row) => row.kind)).toEqual([
      'full_flight_sim',
    ]);
  });

  it('never gates a module above the top of the ladder', () => {
    for (const row of ACADEMY_MODULES) {
      expect(row.fromLevel).toBeGreaterThanOrEqual(1);
      expect(row.fromLevel).toBeLessThanOrEqual(ACADEMY_MAX_LEVEL);
    }
  });

  it('says which modules a mechanic actually reads today', () => {
    /*
     * Pinned deliberately. Three modules are priced and buildable and nothing
     * consumes them yet; if a later milestone wires one up and forgets to flip
     * the flag, the interface goes on telling players it does nothing.
     */
    expect(
      ACADEMY_MODULES.filter((row) => row.readToday)
        .map((row) => row.kind)
        .sort(),
    ).toEqual(['cabin_service_mockup', 'cbt_suite', 'fixed_base_sim', 'full_flight_sim']);
  });
});

describe('the shipped balance', () => {
  it('is the payload the economy config seeds', () => {
    expect(ECONOMY_CONFIG_V1.academy).toEqual(SHIPPED_ACADEMY_BALANCE);
  });

  it('never prices an in-house course above buying it in', () => {
    // §10.1 says "a fraction of the cost of outsourcing", and a fraction above
    // one would make the whole building a liability.
    for (const rate of Object.values(balance.inHouseConversionRate)) {
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThan(1);
    }
    // The simulator is the best rate — that is the sentence's whole point.
    expect(balance.inHouseConversionRate.fullFlightSim).toBeLessThan(
      balance.inHouseConversionRate.fixedBaseSim,
    );
  });

  it('makes each level dearer to build and to hold than the one below', () => {
    for (let index = 1; index < LEVELS.length; index += 1) {
      const previous = levelBalance(LEVELS[index - 1] as AcademyLevel, balance);
      const current = levelBalance(LEVELS[index] as AcademyLevel, balance);
      expect(current.capitalCostMinor).toBeGreaterThan(previous.capitalCostMinor);
      expect(current.monthlyUpkeepMinor).toBeGreaterThan(previous.monthlyUpkeepMinor);
    }
  });
});

describe('climbing the ladder', () => {
  it('offers the next level and stops at the top', () => {
    expect(nextAcademyLevel(0)).toBe(1);
    expect(nextAcademyLevel(4)).toBe(5);
    expect(nextAcademyLevel(5)).toBeNull();
  });
});
