import { z } from 'zod';

import { CrewRank } from './economy-config';
import { Timestamp, Uuid } from './primitives';

/**
 * §10.2's personal skill trees and named crew — identity and the wire contract
 * (M9-03).
 *
 * ## The sanctioned exception, and what it is an exception *to*
 *
 * §9.1 warned against managing individuals and M5-01 made that a schema rule:
 * crew are counts in `crew_pool` and there is no crew member table. §10 names
 * itself the exception:
 *
 * > *"§9.1 warned against managing individuals. This is the sanctioned
 * > exception, and it works because it's **opt-in and inverted** — you're not
 * > forced to roster people one by one, you *choose* to invest in specific
 * > pilots because the payoff is a named, measurable asset. Micro here is a
 * > reward, not a tax."*
 *
 * So an individual arrives here, and only here, and only by **emerging from a
 * pool** once its crew are experienced enough. The pools keep doing all the
 * work: hiring, complements, duty, conversions and payroll are untouched, and an
 * airline that never opens this page plays exactly the game it played before.
 *
 * ## What a point may buy
 *
 * §10.4, and it is not negotiable: *"Boosts are **operational efficiency**,
 * never demand or money directly."* Every branch below names one of §10.4's six
 * ceilings and nothing else, so a skill point can only ever make an airline
 * cheaper or faster — never more popular. `skillBoosts` in `@tailfin/sim`
 * returns `EfficiencyBoost`es that go through the same `stackEfficiencyBoosts`
 * every other source will use, which is the first acceptance criterion made
 * structural rather than promised.
 */

/** The four branches a pilot may specialise into (§10.2). */
export const PilotBranch = z.enum([
  'performance_fuel',
  'handling_safety',
  'command_leadership',
  'type_mastery',
]);
export type PilotBranch = z.infer<typeof PilotBranch>;

/** The lighter three §10.2 gives cabin crew. */
export const CabinBranch = z.enum(['service', 'safety', 'leadership']);
export type CabinBranch = z.infer<typeof CabinBranch>;

export const SkillBranch = z.enum([...PilotBranch.options, ...CabinBranch.options]);
export type SkillBranch = z.infer<typeof SkillBranch>;
export const SKILL_BRANCHES = SkillBranch.options;

/**
 * Which of §10.4's six ceilings a branch's points feed.
 *
 * Named here rather than in the balance, because *which* quantity a branch makes
 * cheaper is design — moving Performance & Fuel off fuel burn would be a
 * redesign of §10.2's table. *How much* a point is worth is balance and lives in
 * `EconomyConfig.crew.skills`.
 *
 * Two of §10.4's ceilings are deliberately unreachable from a skill point.
 * `blockTime` is taxi and routing efficiency, which §10.3 puts under research
 * doctrine rather than under a person; and `serviceCost` is App. D's execution,
 * which §10.4 says crew training raises through a **band-capped** curve rather
 * than through a boost — *"a veteran airline is leaner, not more attractive"*.
 * Wiring either to a skill point would break a rule §10.4 calls non-negotiable.
 */
export const BoostCeiling = z.enum([
  'fuelBurn',
  'turnaroundTime',
  'maintenanceCost',
  'incidentRate',
]);
export type BoostCeiling = z.infer<typeof BoostCeiling>;

export interface SkillBranchDefinition {
  branch: SkillBranch;
  /** Which ladder may spend points here. */
  ladder: 'flight_deck' | 'cabin';
  name: string;
  /** §10.2's own description of the branch. */
  effect: string;
  /** The §10.4 ceiling its points reduce. */
  ceiling: BoostCeiling;
  /**
   * True for the one branch tied to a single aircraft family (§10.2).
   *
   * *"Deep proficiency on one family; big bonuses, **lost if you sell that
   * fleet**."* That last clause is the third acceptance criterion, and it is why
   * this flag exists rather than the branch being just another entry: the boost
   * has to be withdrawn when the airline no longer operates the family, which
   * means something has to know which branch is conditional.
   */
  familyBound: boolean;
}

/** §10.2's two tables, verbatim in effect and reasoned in ceiling. */
export const SKILL_BRANCH_DEFINITIONS: readonly SkillBranchDefinition[] = [
  {
    branch: 'performance_fuel',
    ladder: 'flight_deck',
    name: 'Performance & Fuel',
    effect: 'Cost-index discipline, optimal cruise, continuous descent, tankering judgement',
    ceiling: 'fuelBurn',
    familyBound: false,
  },
  {
    branch: 'handling_safety',
    ladder: 'flight_deck',
    name: 'Handling & Safety',
    effect: 'Fewer incidents, better weather minima, diversion avoidance',
    ceiling: 'incidentRate',
    familyBound: false,
  },
  {
    branch: 'command_leadership',
    ladder: 'flight_deck',
    name: 'Command & Leadership',
    effect: 'Faster turnarounds, better crew morale on their flights, disruption recovery',
    ceiling: 'turnaroundTime',
    familyBound: false,
  },
  {
    /*
     * Maintenance cost, which is the one §10.2 does not state. The branch is
     * *"deep proficiency on one family"* with *"big bonuses"*, and the ceiling
     * it most plainly belongs to is the one an airline earns by flying one type
     * well: fewer heavy-handed cycles, better defect reporting, a fleet that
     * costs less to keep. Fuel and turnaround are already spoken for by the two
     * branches above, and putting a second branch on either would make the
     * choice between them arithmetic rather than character.
     */
    branch: 'type_mastery',
    ladder: 'flight_deck',
    name: 'Type Mastery',
    effect: 'Deep proficiency on one family — big bonuses, lost if you sell that fleet',
    ceiling: 'maintenanceCost',
    familyBound: true,
  },
  {
    /*
     * §10.4 forbids a boost that makes an airline *more attractive*, and service
     * quality is exactly that — so this branch cannot feed a demand term. It
     * feeds the **cost** of turning the aeroplane instead: a cabin crew who work
     * well together clear and reset a cabin faster. The service-execution half
     * of §10.4's sentence is band-capped and belongs to App. D, not here.
     */
    branch: 'service',
    ladder: 'cabin',
    name: 'Service',
    effect: 'Cabin service standards, and a cabin that resets faster between sectors',
    ceiling: 'turnaroundTime',
    familyBound: false,
  },
  {
    branch: 'safety',
    ladder: 'cabin',
    name: 'Safety',
    effect: 'Emergency drills, evacuation discipline, fewer cabin incidents',
    ceiling: 'incidentRate',
    familyBound: false,
  },
  {
    branch: 'leadership',
    ladder: 'cabin',
    name: 'Leadership',
    effect: 'The path to Purser — crew cohesion and disruption handling',
    ceiling: 'turnaroundTime',
    familyBound: false,
  },
];

export function skillBranchDefinition(branch: SkillBranch): SkillBranchDefinition {
  const found = SKILL_BRANCH_DEFINITIONS.find((row) => row.branch === branch);
  /* istanbul ignore next -- the enum and the table are held in step by a test. */
  if (!found) throw new Error(`No skill branch definition for ${branch}`);
  return found;
}

/** The branches a given ladder may spend points in. */
export function branchesForLadder(ladder: 'flight_deck' | 'cabin'): SkillBranchDefinition[] {
  return SKILL_BRANCH_DEFINITIONS.filter((row) => row.ladder === ladder);
}

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * Points spent, by branch.
 *
 * A partial record rather than a full one: a member who has spent nothing sends
 * `{}`, and a branch absent from the map means zero rather than being a state of
 * its own.
 */
export const SkillPoints = z.partialRecord(SkillBranch, z.number().int().nonnegative());
export type SkillPoints = z.infer<typeof SkillPoints>;

/**
 * What a named crew member has done — §10.2's *"visible history"*.
 *
 * *"hours, types, notable flights, incidents handled"*. Three of those four are
 * here; **notable flights are deliberately absent**, because nothing in the game
 * decides what makes a flight notable and inventing a rule for it would be a
 * §18-shaped decision taken inside a crew page. `typesFlown` carries the family
 * rather than the designation, for the reason `crew_pool.family` does: a rating
 * is a property of a family, and a member must survive a catalogue version that
 * no longer lists the type they were rated on.
 */
export const CrewCareer = z
  .object({
    /** Block hours flown since being named. Not the pool's history before that. */
    blockHours: z.number().nonnegative(),
    sectors: z.number().int().nonnegative(),
    /** Families this member has been rated on, in the order they were acquired. */
    typesFlown: z.array(z.string().min(1)),
    /** Disruptions flown through and completed — §10.2's *"incidents handled"*. */
    incidentsHandled: z.number().int().nonnegative(),
  })
  .strict();
export type CrewCareer = z.infer<typeof CrewCareer>;

export const CrewMemberView = z
  .object({
    id: Uuid,
    /** Given name and surname, generated once and stable for ever. */
    name: z.string().min(1),
    rank: CrewRank,
    /** The family this member is rated on — and Type Mastery's subject. */
    family: z.string().min(1),
    crewBaseId: Uuid,
    airportIcao: z.string().length(4),
    level: z.number().int().nonnegative(),
    xp: z.number().int().nonnegative(),
    /** XP still needed to reach the next level. Null at the top. */
    xpToNextLevel: z.number().int().nonnegative().nullable(),
    spent: SkillPoints,
    /** Points earned and not yet spent. The thing the page exists to spend. */
    unspentPoints: z.number().int().nonnegative(),
    career: CrewCareer,
    /** Game time this member was named. */
    namedAt: Timestamp,
    /**
     * False when the airline no longer operates this member's family (§10.2).
     *
     * Their Type Mastery points are **kept but inert** — the third acceptance
     * criterion. Not refunded and not deleted: §10.2 says the bonus is *lost*
     * when the fleet goes, and a refund would make selling a fleet a free
     * respec. Buy the family back and the points work again.
     */
    typeMasteryActive: z.boolean(),
  })
  .strict();
export type CrewMemberView = z.infer<typeof CrewMemberView>;

/** One branch as the pilot card shows it. */
export const SkillBranchView = z
  .object({
    branch: SkillBranch,
    name: z.string().min(1),
    effect: z.string().min(1),
    ceiling: BoostCeiling,
    familyBound: z.boolean(),
    spent: z.number().int().nonnegative(),
    maxPoints: z.number().int().positive(),
    /** What this branch currently removes, 0-1, before stacking and the cap. */
    fraction: z.number().min(0).max(1),
    /** False for a family-bound branch whose fleet has gone. */
    active: z.boolean(),
  })
  .strict();
export type SkillBranchView = z.infer<typeof SkillBranchView>;

/**
 * What the airline's named crew are worth in total, after §10.4's ceilings.
 *
 * The **stacked and capped** figure, not a sum — so the page shows what the
 * airline actually gets rather than what its points would be worth if the
 * ceilings did not exist. `capped` is what makes the ceiling visible, which is
 * §10.4's *"a year-one player must never face an unbeatable wall"* made legible
 * to the veteran as well.
 */
export const AirlineBoostView = z
  .object({
    ceiling: BoostCeiling,
    /** The reduction actually applied, 0-1. */
    fraction: z.number().min(0).max(1),
    /** §10.4's ceiling for this quantity. */
    maxFraction: z.number().min(0).max(1),
    capped: z.boolean(),
    /** How many named crew contributed. */
    contributors: z.number().int().nonnegative(),
  })
  .strict();
export type AirlineBoostView = z.infer<typeof AirlineBoostView>;

export const CrewRosterResponse = z
  .object({
    members: z.array(CrewMemberView),
    /** Every branch, so the card can render a tree rather than only what is spent. */
    branches: z.array(SkillBranchView).default([]),
    boosts: z.array(AirlineBoostView),
    /**
     * Families the airline currently operates — what Type Mastery is checked
     * against, sent so the page can say *why* a branch went inert.
     */
    operatedFamilies: z.array(z.string().min(1)),
    /** The level at which a pool's crew start being named. */
    namedFromLevel: z.number().int().positive(),
  })
  .strict();
export type CrewRosterResponse = z.infer<typeof CrewRosterResponse>;

/**
 * Spending a point.
 *
 * One at a time, deliberately. §10.2 calls the points *"mostly irreversible"*,
 * and a bulk allocation makes a mis-click expensive in a way a single spend does
 * not — the same argument the rebrand confirmation makes.
 */
export const AllocateSkillPointInput = z.object({ branch: SkillBranch }).strict();
export type AllocateSkillPointInput = z.infer<typeof AllocateSkillPointInput>;

/** The closed set of reasons a roster request is refused. */
export const CrewSkillRefusal = z.enum([
  'member_absent',
  'no_unspent_points',
  'branch_wrong_ladder',
  'branch_full',
]);
export type CrewSkillRefusal = z.infer<typeof CrewSkillRefusal>;
