import { describe, expect, it } from 'vitest';

import {
  ECONOMY_CONFIG_V1,
  SHIPPED_CREW_SKILL_BALANCE,
  SKILL_BRANCHES,
  SKILL_BRANCH_DEFINITIONS,
  branchesForLadder,
  skillBranchDefinition,
} from '@tailfin/shared';

import { EFFICIENCY_CEILINGS } from '../economy/boosts';

import { crewNameFor, CREW_NAME_COMBINATIONS } from './names';
import {
  canSpendPoint,
  levelForXp,
  pointsForLevel,
  skillBoosts,
  stackAirlineSkills,
  treeFor,
  typeMasteryActive,
  unspentPoints,
  xpForLevel,
  xpToNextLevel,
  type SkilledCrew,
} from './skills';

const BALANCE = ECONOMY_CONFIG_V1.crew.skills;
const CEILINGS = EFFICIENCY_CEILINGS;

function pilot(over: Partial<SkilledCrew> = {}): SkilledCrew {
  return { rank: 'captain', family: 'A320neo', level: 10, spent: {}, ...over };
}

function cabin(over: Partial<SkilledCrew> = {}): SkilledCrew {
  return { rank: 'purser', family: 'A320neo', level: 10, spent: {}, ...over };
}

/**
 * §10.2's skill trees (M9-03).
 *
 * The three acceptance criteria are what this file is for, and the first two are
 * structural rather than numeric — which is why they are tested by asking what
 * the module *can* express rather than by checking one number.
 */
describe('the branch table', () => {
  it('is §10.2s four pilot branches and three cabin ones', () => {
    expect(branchesForLadder('flight_deck').map((b) => b.branch)).toEqual([
      'performance_fuel',
      'handling_safety',
      'command_leadership',
      'type_mastery',
    ]);
    expect(branchesForLadder('cabin').map((b) => b.branch)).toEqual([
      'service',
      'safety',
      'leadership',
    ]);
  });

  it('defines every branch in the enum, and no others', () => {
    expect(SKILL_BRANCH_DEFINITIONS.map((b) => b.branch).sort()).toEqual(
      [...SKILL_BRANCHES].sort(),
    );
    expect(Object.keys(BALANCE.fractionPerPoint).sort()).toEqual([...SKILL_BRANCHES].sort());
  });

  it('marks exactly Type Mastery as family-bound', () => {
    expect(SKILL_BRANCH_DEFINITIONS.filter((b) => b.familyBound).map((b) => b.branch)).toEqual([
      'type_mastery',
    ]);
  });

  /**
   * §10.4: *"Boosts are operational efficiency, never demand or money
   * directly."* The structural form of that rule: a branch can only name a
   * ceiling from the efficiency set, so there is no way to express a branch that
   * moves demand.
   */
  it('points every branch at an efficiency ceiling and nothing else', () => {
    const allowed = ['fuelBurn', 'turnaroundTime', 'maintenanceCost', 'incidentRate'];
    for (const definition of SKILL_BRANCH_DEFINITIONS) {
      expect(allowed, definition.branch).toContain(definition.ceiling);
      // And the ceiling it names is one §10.4 actually publishes.
      expect(CEILINGS[definition.ceiling]).toBeGreaterThan(0);
    }
  });

  it('gives every branch §10.2s own description', () => {
    for (const definition of SKILL_BRANCH_DEFINITIONS) {
      expect(definition.effect.length, definition.branch).toBeGreaterThan(20);
      expect(skillBranchDefinition(definition.branch)).toBe(definition);
    }
  });
});

describe('levels and points', () => {
  it('starts everyone at level 1 with nothing to spend', () => {
    expect(levelForXp(0, BALANCE)).toBe(1);
    expect(xpForLevel(1, BALANCE)).toBe(0);
    expect(pointsForLevel(1, BALANCE)).toBe(0);
  });

  it('needs more XP for each level than the one before', () => {
    for (let level = 2; level < BALANCE.maxLevel; level += 1) {
      const step = xpForLevel(level + 1, BALANCE) - xpForLevel(level, BALANCE);
      const previous = xpForLevel(level, BALANCE) - xpForLevel(level - 1, BALANCE);
      expect(step, `level ${String(level)}`).toBeGreaterThan(previous);
    }
  });

  it('clamps at the ceiling however much XP arrives', () => {
    expect(levelForXp(Number.MAX_SAFE_INTEGER, BALANCE)).toBe(BALANCE.maxLevel);
    expect(xpToNextLevel(Number.MAX_SAFE_INTEGER, BALANCE)).toBeNull();
  });

  it('reports the XP still to go, and reaches zero exactly at the threshold', () => {
    const atFive = xpForLevel(5, BALANCE);
    expect(levelForXp(atFive, BALANCE)).toBe(5);
    expect(levelForXp(atFive - 1, BALANCE)).toBe(4);
    expect(xpToNextLevel(atFive, BALANCE)).toBe(xpForLevel(6, BALANCE) - atFive);
  });

  it('grants a point per level and counts what is left', () => {
    expect(pointsForLevel(10, BALANCE)).toBe(9 * BALANCE.pointsPerLevel);
    expect(unspentPoints(10, {}, BALANCE)).toBe(9 * BALANCE.pointsPerLevel);
    expect(unspentPoints(10, { performance_fuel: 4 }, BALANCE)).toBe(
      9 * BALANCE.pointsPerLevel - 4,
    );
    // Over-spent rows (an older build, a retune) read as nothing left, never as
    // a negative that would let a caller spend again.
    expect(unspentPoints(2, { performance_fuel: 5 }, BALANCE)).toBe(0);
  });
});

describe('spending a point', () => {
  it('refuses a branch on the other ladder', () => {
    expect(canSpendPoint(pilot(), 'service', BALANCE)).toBe('branch_wrong_ladder');
    expect(canSpendPoint(cabin(), 'performance_fuel', BALANCE)).toBe('branch_wrong_ladder');
  });

  it('refuses a full branch before it refuses an empty purse', () => {
    const full = pilot({ spent: { performance_fuel: BALANCE.maxPointsPerBranch } });
    expect(canSpendPoint(full, 'performance_fuel', BALANCE)).toBe('branch_full');
  });

  it('refuses when there is nothing left to spend', () => {
    // Level 2 grants one point; spend it and the next is refused.
    const spent = pilot({ level: 2, spent: { performance_fuel: 1 } });
    expect(canSpendPoint(spent, 'handling_safety', BALANCE)).toBe('no_unspent_points');
  });

  it('allows a legitimate spend', () => {
    expect(canSpendPoint(pilot(), 'performance_fuel', BALANCE)).toBeNull();
    expect(canSpendPoint(cabin(), 'service', BALANCE)).toBeNull();
  });

  it('offers each rank only its own ladder', () => {
    expect(treeFor('captain').map((b) => b.branch)).not.toContain('service');
    expect(treeFor('purser').map((b) => b.branch)).not.toContain('performance_fuel');
  });
});

/** AC1: *"Skill effects feed the same capped boost pool as research."* */
describe('skill effects go through the capped pool', () => {
  it('produces EfficiencyBoosts, never a bare multiplier', () => {
    const boosts = skillBoosts(pilot({ spent: { performance_fuel: 3 } }), ['A320neo'], BALANCE);
    expect(boosts.fuelBurn).toHaveLength(1);
    expect(boosts.fuelBurn[0]?.fraction).toBeCloseTo(3 * BALANCE.fractionPerPoint.performance_fuel);
    expect(boosts.fuelBurn[0]?.id).toContain('performance_fuel');
  });

  it('never exceeds §10.4s ceiling, however many veterans stack', () => {
    const crowd = Array.from({ length: 40 }, () =>
      pilot({ spent: { performance_fuel: BALANCE.maxPointsPerBranch } }),
    );
    const stacked = stackAirlineSkills(crowd, ['A320neo'], BALANCE, CEILINGS);
    expect(stacked.stacked.fuelBurn.fraction).toBe(CEILINGS.fuelBurn);
    expect(stacked.stacked.fuelBurn.capped).toBe(true);
  });

  it('stacks multiplicatively — two veterans are worth less than twice one', () => {
    const one = stackAirlineSkills(
      [pilot({ spent: { performance_fuel: 5 } })],
      ['A320neo'],
      BALANCE,
      CEILINGS,
    );
    const two = stackAirlineSkills(
      [pilot({ spent: { performance_fuel: 5 } }), pilot({ spent: { performance_fuel: 5 } })],
      ['A320neo'],
      BALANCE,
      CEILINGS,
    );
    expect(two.stacked.fuelBurn.fraction).toBeGreaterThan(one.stacked.fuelBurn.fraction);
    expect(two.stacked.fuelBurn.fraction).toBeLessThan(one.stacked.fuelBurn.fraction * 2);
  });

  it('leaves room for the three sources that have not shipped', () => {
    /*
     * §10.4: stacking academy + research + personal skill + Training Captain
     * never exceeds the ceiling. Only one of those four exists, so one fully
     * specialised veteran must not fill a ceiling on their own — or M9-04 and
     * M9-05 would arrive with nothing to give.
     */
    const solo = stackAirlineSkills(
      [pilot({ spent: { performance_fuel: BALANCE.maxPointsPerBranch } })],
      ['A320neo'],
      BALANCE,
      CEILINGS,
    );
    expect(solo.stacked.fuelBurn.fraction).toBeLessThan(CEILINGS.fuelBurn * 0.75);
    expect(solo.stacked.fuelBurn.capped).toBe(false);
  });

  it('counts contributors so the page can say who earned it', () => {
    const stacked = stackAirlineSkills(
      [pilot({ spent: { performance_fuel: 2 } }), pilot({ spent: { handling_safety: 2 } })],
      ['A320neo'],
      BALANCE,
      CEILINGS,
    );
    expect(stacked.contributors.fuelBurn).toBe(1);
    expect(stacked.contributors.incidentRate).toBe(1);
    expect(stacked.contributors.turnaroundTime).toBe(0);
  });

  it('gives nothing for an unspent tree', () => {
    const stacked = stackAirlineSkills([pilot()], ['A320neo'], BALANCE, CEILINGS);
    for (const value of Object.values(stacked.stacked)) expect(value.fraction).toBe(0);
  });
});

/** AC3: *"Type Mastery bonuses are lost if that fleet is sold."* */
describe('Type Mastery and the fleet', () => {
  const master = pilot({ family: 'A320neo', spent: { type_mastery: 5 } });

  it('pays while the airline still operates the family', () => {
    expect(typeMasteryActive(master, ['A320neo'])).toBe(true);
    expect(skillBoosts(master, ['A320neo'], BALANCE).maintenanceCost).toHaveLength(1);
  });

  it('pays nothing once the fleet is gone', () => {
    expect(typeMasteryActive(master, ['B737 MAX'])).toBe(false);
    expect(skillBoosts(master, ['B737 MAX'], BALANCE).maintenanceCost).toEqual([]);
    expect(skillBoosts(master, [], BALANCE).maintenanceCost).toEqual([]);
  });

  it('keeps the points rather than refunding them', () => {
    // The spend is untouched — §10.2 says the bonus is *lost*, not returned.
    expect(master.spent.type_mastery).toBe(5);
    expect(unspentPoints(master.level, master.spent, BALANCE)).toBe(
      pointsForLevel(master.level, BALANCE) - 5,
    );
  });

  it('works again when the family comes back', () => {
    expect(skillBoosts(master, ['B737 MAX'], BALANCE).maintenanceCost).toEqual([]);
    expect(skillBoosts(master, ['B737 MAX', 'A320neo'], BALANCE).maintenanceCost).toHaveLength(1);
  });

  it('does not silence the member’s other branches', () => {
    const mixed = pilot({ family: 'A320neo', spent: { type_mastery: 5, performance_fuel: 3 } });
    const boosts = skillBoosts(mixed, ['B737 MAX'], BALANCE);
    expect(boosts.maintenanceCost).toEqual([]);
    expect(boosts.fuelBurn).toHaveLength(1);
  });

  it('drops a family-bound branch from the airline stack too', () => {
    const withFleet = stackAirlineSkills([master], ['A320neo'], BALANCE, CEILINGS);
    const without = stackAirlineSkills([master], ['B737 MAX'], BALANCE, CEILINGS);
    expect(withFleet.stacked.maintenanceCost.fraction).toBeGreaterThan(0);
    expect(without.stacked.maintenanceCost.fraction).toBe(0);
    expect(without.contributors.maintenanceCost).toBe(0);
  });
});

describe('points held on the wrong ladder', () => {
  it('are ignored rather than trusted', () => {
    // A row written before a rank changed, or by an older build. It must not
    // grant a cabin branch's effect to a pilot.
    const odd = pilot({ spent: { service: 5 } });
    const boosts = skillBoosts(odd, ['A320neo'], BALANCE);
    for (const entries of Object.values(boosts)) expect(entries).toEqual([]);
  });
});

describe('naming', () => {
  it('is deterministic given the world, the base and the ordinal', () => {
    const first = crewNameFor('seed-1', 'base-a', 0);
    for (let n = 0; n < 10; n += 1) {
      expect(crewNameFor('seed-1', 'base-a', 0)).toBe(first);
    }
  });

  it('differs by world, by base and by ordinal', () => {
    expect(crewNameFor('seed-1', 'base-a', 0)).not.toBe(crewNameFor('seed-2', 'base-a', 0));
    expect(crewNameFor('seed-1', 'base-a', 0)).not.toBe(crewNameFor('seed-1', 'base-b', 0));
    expect(crewNameFor('seed-1', 'base-a', 0)).not.toBe(crewNameFor('seed-1', 'base-a', 1));
  });

  it('always produces a given name and a surname', () => {
    for (let n = 0; n < 200; n += 1) {
      const name = crewNameFor('seed-1', 'base-a', n);
      expect(name.split(' ')).toHaveLength(2);
      expect(name.length).toBeGreaterThan(4);
    }
  });

  it('draws from a wide enough pool that a base rarely repeats', () => {
    expect(CREW_NAME_COMBINATIONS).toBeGreaterThan(2_000);
    const names = new Set(Array.from({ length: 60 }, (_, n) => crewNameFor('seed-1', 'base-a', n)));
    // Birthday-problem collisions are expected at 60 draws from ~2,300; the
    // guard is that it is not producing one or two names over and over.
    expect(names.size).toBeGreaterThan(50);
  });
});

describe('the shipped balance', () => {
  it('is the payload the economy config seeds', () => {
    expect(ECONOMY_CONFIG_V1.crew.skills).toEqual(SHIPPED_CREW_SKILL_BALANCE);
  });

  it('names crew well after they start, not on hire', () => {
    // §9.1's "never manage individuals" arrives through the back door if every
    // head is named the day they are hired.
    expect(BALANCE.namedFromLevel).toBeGreaterThan(1);
    expect(xpForLevel(BALANCE.namedFromLevel, BALANCE)).toBeGreaterThan(10_000);
  });

  it('pays Type Mastery more per point than the branch it competes with', () => {
    // §10.2 promises "big bonuses" for the branch that can be lost.
    expect(BALANCE.fractionPerPoint.type_mastery).toBeGreaterThan(
      BALANCE.fractionPerPoint.performance_fuel,
    );
  });

  it('keeps every branch below a full ceiling on its own', () => {
    for (const branch of SKILL_BRANCHES) {
      const definition = skillBranchDefinition(branch);
      const solo = BALANCE.maxPointsPerBranch * BALANCE.fractionPerPoint[branch];
      expect(solo, branch).toBeLessThan(CEILINGS[definition.ceiling]);
    }
  });
});
