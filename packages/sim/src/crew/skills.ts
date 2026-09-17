import {
  branchesForLadder,
  skillBranchDefinition,
  SKILL_BRANCH_DEFINITIONS,
  type BoostCeiling,
  type CrewSkillBalance,
  type SkillBranch,
  type SkillPoints,
  type CrewRank,
} from '@tailfin/shared';

import { type EfficiencyBoost, stackEfficiencyBoosts, type StackedBoosts } from '../economy/boosts';

import { crewLadderOf } from './pools';

/**
 * §10.2's personal skill trees, as arithmetic (M9-03).
 *
 * Pure, like everything in `@tailfin/sim`: the branch table arrives from
 * `@tailfin/shared` and every number from a `CrewSkillBalance`, so this file
 * holds no balance literal.
 *
 * ## The acceptance criterion this file exists to make structural
 *
 * > *"Skill effects feed the same capped boost pool as research, never a
 * > separate uncapped one."*
 *
 * {@link skillBoosts} returns `EfficiencyBoost`es — the same type `block.ts`,
 * `fuel.ts`, `turnaround.ts` and `disruption.ts` already take — and
 * {@link stackAirlineSkills} puts them through `stackEfficiencyBoosts`, the one
 * function that applies §10.4's ceilings. There is deliberately **no function
 * here that returns a bare multiplier**: a caller cannot apply a skill effect
 * without going past the cap, because nothing hands one out uncapped.
 *
 * When M9-04's Training Captains and M9-05's research arrive they add entries to
 * the same arrays. Nothing about the ceiling changes, which is the whole point.
 *
 * ## And the one it exists to enforce
 *
 * > *"Type Mastery bonuses are lost if that fleet is sold."*
 *
 * {@link skillBoosts} takes the families the airline currently operates and
 * silently drops a family-bound branch whose fleet has gone. The points are not
 * refunded and not deleted — §10.2 says the bonus is *lost*, and a refund would
 * make selling a fleet a free respec. Buy the family back and they work again.
 */

/** A named crew member, as the skill model needs to see them. */
export interface SkilledCrew {
  rank: CrewRank;
  /** The family this member is rated on — Type Mastery's subject. */
  family: string;
  level: number;
  spent: SkillPoints;
}

/**
 * Total XP needed to *reach* a level.
 *
 * Level 1 is free — a member starts there. Geometric growth from
 * `baseLevelXp`, so the early levels arrive in days and the late ones take
 * seasons.
 */
export function xpForLevel(level: number, balance: CrewSkillBalance): number {
  if (level <= 1) return 0;
  let total = 0;
  let step = balance.baseLevelXp;
  for (let n = 2; n <= level; n += 1) {
    total += step;
    step *= balance.levelXpGrowth;
  }
  return Math.round(total);
}

/** The level this much XP has bought, clamped to `maxLevel`. */
export function levelForXp(xp: number, balance: CrewSkillBalance): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  let level = 1;
  while (level < balance.maxLevel && xp >= xpForLevel(level + 1, balance)) level += 1;
  return level;
}

/** XP still needed for the next level, or null at the ceiling. */
export function xpToNextLevel(xp: number, balance: CrewSkillBalance): number | null {
  const level = levelForXp(xp, balance);
  if (level >= balance.maxLevel) return null;
  return Math.max(0, xpForLevel(level + 1, balance) - Math.floor(xp));
}

/** Points a member of this level has been granted in total. */
export function pointsForLevel(level: number, balance: CrewSkillBalance): number {
  return Math.max(0, level - 1) * balance.pointsPerLevel;
}

/** Points spent across every branch. */
export function pointsSpent(spent: SkillPoints): number {
  return Object.values(spent).reduce((total, points) => total + (points ?? 0), 0);
}

/** Points earned and not yet committed. */
export function unspentPoints(
  level: number,
  spent: SkillPoints,
  balance: CrewSkillBalance,
): number {
  return Math.max(0, pointsForLevel(level, balance) - pointsSpent(spent));
}

/** Whether a rank may spend in a branch at all. */
export function branchAllowsRank(branch: SkillBranch, rank: CrewRank): boolean {
  return skillBranchDefinition(branch).ladder === crewLadderOf(rank);
}

/** The reasons a point cannot be spent, in the order a caller should report them. */
export type SkillSpendRefusal = 'no_unspent_points' | 'branch_wrong_ladder' | 'branch_full';

/**
 * May this member put a point here?
 *
 * Returns null when they may. The ladder check comes before the capacity one,
 * because *"cabin crew cannot fly the aeroplane"* is a permanent answer and
 * *"this branch is full"* is a suggestion to spend elsewhere.
 */
export function canSpendPoint(
  crew: SkilledCrew,
  branch: SkillBranch,
  balance: CrewSkillBalance,
): SkillSpendRefusal | null {
  if (!branchAllowsRank(branch, crew.rank)) return 'branch_wrong_ladder';
  if ((crew.spent[branch] ?? 0) >= balance.maxPointsPerBranch) return 'branch_full';
  if (unspentPoints(crew.level, crew.spent, balance) <= 0) return 'no_unspent_points';
  return null;
}

/**
 * What one member's points remove, by §10.4 ceiling, as unstacked boosts.
 *
 * `operatedFamilies` is what the third acceptance criterion turns on: a
 * family-bound branch contributes nothing when the airline no longer flies that
 * family. Passing an empty list is therefore *"this airline operates nothing"*
 * and correctly silences Type Mastery, rather than being a missing argument.
 */
export function skillBoosts(
  crew: SkilledCrew,
  operatedFamilies: readonly string[],
  balance: CrewSkillBalance,
  idPrefix = 'skill',
): Record<BoostCeiling, EfficiencyBoost[]> {
  const out: Record<BoostCeiling, EfficiencyBoost[]> = {
    fuelBurn: [],
    turnaroundTime: [],
    maintenanceCost: [],
    incidentRate: [],
  };

  for (const definition of SKILL_BRANCH_DEFINITIONS) {
    const points = crew.spent[definition.branch] ?? 0;
    if (points <= 0) continue;
    // A member cannot legitimately hold points on the other ladder, but a row
    // written before a rank changed could. Ignored rather than trusted.
    if (definition.ladder !== crewLadderOf(crew.rank)) continue;
    if (definition.familyBound && !operatedFamilies.includes(crew.family)) continue;

    const capped = Math.min(points, balance.maxPointsPerBranch);
    out[definition.ceiling].push({
      id: `${idPrefix}:${definition.branch}`,
      fraction: capped * balance.fractionPerPoint[definition.branch],
    });
  }

  return out;
}

/** Whether a member's family-bound points are doing anything right now. */
export function typeMasteryActive(crew: SkilledCrew, operatedFamilies: readonly string[]): boolean {
  return operatedFamilies.includes(crew.family);
}

export interface AirlineSkillBoosts {
  /** Stacked and capped, per §10.4 ceiling. */
  stacked: Record<BoostCeiling, StackedBoosts>;
  /** How many members contributed to each, for the readout. */
  contributors: Record<BoostCeiling, number>;
  /** The unstacked entries, for anything that wants to stack them with others. */
  boosts: Record<BoostCeiling, EfficiencyBoost[]>;
}

/**
 * Every named member's points, stacked into the airline's four ceilings.
 *
 * `ceilings` is the world's own `EconomyConfig.boosts.ceilings`, so a retune
 * moves the cap without a deploy.
 *
 * Multiplicative stacking is `stackEfficiencyBoosts`'s, not this function's:
 * two crew each worth 4% give 7.84%, not 8%, and the ceiling clamps whatever is
 * left. That is §10.4's *"diminishing returns before the cap"*, and the reason
 * a tenth veteran is worth measurably less than the first.
 */
export function stackAirlineSkills(
  crew: readonly SkilledCrew[],
  operatedFamilies: readonly string[],
  balance: CrewSkillBalance,
  ceilings: Record<BoostCeiling, number>,
): AirlineSkillBoosts {
  const boosts: Record<BoostCeiling, EfficiencyBoost[]> = {
    fuelBurn: [],
    turnaroundTime: [],
    maintenanceCost: [],
    incidentRate: [],
  };
  const contributors: Record<BoostCeiling, number> = {
    fuelBurn: 0,
    turnaroundTime: 0,
    maintenanceCost: 0,
    incidentRate: 0,
  };

  crew.forEach((member, index) => {
    const own = skillBoosts(member, operatedFamilies, balance, `skill:${String(index)}`);
    for (const ceiling of Object.keys(boosts) as BoostCeiling[]) {
      if (own[ceiling].length === 0) continue;
      boosts[ceiling].push(...own[ceiling]);
      contributors[ceiling] += 1;
    }
  });

  const stacked = {} as Record<BoostCeiling, StackedBoosts>;
  for (const ceiling of Object.keys(boosts) as BoostCeiling[]) {
    stacked[ceiling] = stackEfficiencyBoosts(boosts[ceiling], ceilings[ceiling]);
  }

  return { stacked, contributors, boosts };
}

/** Every branch a rank may spend in, for the pilot card's tree. */
export function treeFor(rank: CrewRank) {
  return branchesForLadder(crewLadderOf(rank));
}
