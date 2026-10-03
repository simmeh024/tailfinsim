import {
  FlightDeckRank,
  type AcademyCommissionedLevel,
  type BoostCeiling,
  type CrewRank,
  type CrewSkillBalance,
  type TrainingCaptainBalance,
  type TrainingCaptainRefusal,
} from '@tailfin/shared';

import { academyPermitsRank } from '../academy/levels';
import { type EfficiencyBoost, type SourceBoosts } from '../economy/boosts';

import { crewLadderOf } from './pools';
import { skillBoosts, type SkilledCrew } from './skills';

/**
 * §10.2's Training Captains, and the compounding loop they close (M9-04).
 *
 * > *"A max-level pilot can be converted to **Training Captain**: they stop
 * > generating full revenue value and instead multiply XP gain for everyone they
 * > fly with. This is the loop that makes long-term investment pay:*
 * >
 * > *hard routes → pilot XP → Training Captains → faster XP for everyone →
 * > deeper bench → harder routes"*
 *
 * Pure, like everything in `@tailfin/sim`: who may convert reads §10.1's ladder
 * through `academyPermitsRank`, and every number arrives in a
 * `TrainingCaptainBalance`, so this file holds no balance literal.
 *
 * ## A designation, not a promotion
 *
 * A Training Captain here is a **flag on a named member**, not a head moved from
 * the `captain` pool into a `training_captain` one. Moving the head would be a
 * promotion mechanic, and nothing in the game promotes crew yet — §10.1's rank
 * ceiling says what an academy *may* train, and `training-academy.md` records
 * promotion as unbuilt. It would also entangle a progression choice with the
 * pools' duty, reserve and availability counters, so converting a veteran could
 * strand a rotation for want of a captain. So the member stays one of their
 * pool's heads, flies as they did, and is paid as they were: payroll is
 * unchanged, and what the designation costs is the course fee and the line
 * value it gives up — which is exactly the trade §10.2 describes.
 *
 * ## Why the loop converges
 *
 * The acceptance criterion: *"The XP multiplier is capped so the loop converges
 * rather than runs away."* Two properties make it, and both are tested as
 * properties rather than examples:
 *
 *  1. **Coverage saturates.** One Training Captain covers
 *     `crewsPerTrainingCaptain` flight-deck heads. Coverage is clamped to 1, so
 *     once a base's pilots are all covered another veteran adds nothing.
 *  2. **The bonus is capped.** `maxXpBonus` is the ceiling on the *combined*
 *     bonus — Training Captains plus research doctrine — so no source, and no
 *     stack of sources, passes it.
 *
 * Together they bound XP per head per sector by `base × (1 + maxXpBonus)`, a
 * constant. A base where every pilot who reaches the top converts therefore
 * accumulates XP **linearly** at worst; the loop speeds the bench up to a
 * ceiling and then holds it there. Without the cap the multiplier would feed on
 * its own output — more Training Captains, faster XP, more Training Captains —
 * which is the exponential §10.4 calls a moat.
 *
 * ## "Everyone they fly with", in a game with no rosters
 *
 * The game never decides which pilot flew which sector (M5-01: dispatch commits
 * a count). So *"everyone they fly with"* is read at the granularity the game
 * does know: a Training Captain's **base and family**, which is the set of
 * pilots they are rostered among. The bonus at a base is proportional to how
 * much of its flight deck the Training Captains there can cover — the honest
 * pool-model reading of §10.2, and the same approximation M9-03 records for a
 * named member's own XP.
 */

/** A named member, as the Training Captain rules need to see them. */
export interface TrainingCaptainCandidate {
  rank: CrewRank;
  level: number;
  /** True when the member already holds the designation. */
  trainingCaptain: boolean;
}

/**
 * The ranks that may hold the designation: a Captain, or a pilot already hired
 * at Training Captain rank (who still has to be designated — the rank is a pay
 * grade on §9.2's complement ladder, the designation is §10.2's mechanic).
 * Design, not balance: a First Officer trains nobody to command.
 */
const COMMAND_RANKS: readonly CrewRank[] = ['captain', 'training_captain'];

/**
 * May this member be made a Training Captain? Null when they may.
 *
 * Ordered **most permanent first**, so the answer the page shows is the one the
 * player cannot route around: facts about the *person* (their ladder, their
 * rank, whether they already hold it, their level) before facts about the
 * *base* (whether an academy exists there and how far it has been built). A
 * purser is told they will never convert rather than told to build an academy,
 * and a level-12 captain is told to keep flying rather than sent to commission
 * a Centre of Excellence that would not change the answer.
 *
 * `academyLevelAtMembersBase` is null when no academy row exists at the
 * member's crew base. A building site — level 0, the first level still under
 * construction — is `no_academy` as well: nothing is commissioned there, and
 * §10.1's *"a base without one"* is the reading that holds until it is.
 *
 * The level-5 requirement is **not** written here as a number. It is read
 * through `academyPermitsRank(level, 'training_captain')`, so it stays §10.1's
 * *"Centre of Excellence … own Training Captains"* and moves if the ladder does.
 */
export function trainingCaptainRefusal(
  member: TrainingCaptainCandidate,
  academyLevelAtMembersBase: AcademyCommissionedLevel | null,
  balances: { skills: Pick<CrewSkillBalance, 'maxLevel'> },
): TrainingCaptainRefusal | null {
  if (crewLadderOf(member.rank) !== 'flight_deck') return 'not_flight_deck';
  if (!COMMAND_RANKS.includes(member.rank)) return 'not_command_rank';
  if (member.trainingCaptain) return 'already_training_captain';
  if (member.level < balances.skills.maxLevel) return 'below_max_level';
  if (academyLevelAtMembersBase === null || academyLevelAtMembersBase < 1) return 'no_academy';
  if (!academyPermitsRank(academyLevelAtMembersBase, 'training_captain')) return 'academy_level';
  return null;
}

/** Whether a rank is on the flight deck — the ranks a Training Captain trains. */
export function isFlightDeckRank(rank: CrewRank): boolean {
  return (FlightDeckRank.options as readonly string[]).includes(rank);
}

// ---------------------------------------------------------------------------
// The XP multiplier
// ---------------------------------------------------------------------------

export interface TrainingXpInput {
  /** Designated Training Captains at the base, on the family. */
  trainingCaptains: number;
  /** Flight-deck heads at the base on the family — what coverage is measured against. */
  flightDeckHeads: number;
  /**
   * The XP bonus research doctrine adds (§10.3's Crew Development branch).
   *
   * Zero until M9-05/M9-06 wire it. It is a parameter now so the cap below is
   * the cap on **both**, which is the only arrangement in which the cap means
   * anything: two sources each clamped separately would sum past it.
   */
  doctrineXpFraction?: number;
}

export interface TrainingXpMultiplier {
  /** What a flight-deck head's XP is multiplied by: `1 + bonus`. */
  multiplier: number;
  /** The combined bonus after the cap. */
  bonus: number;
  /** 0–1: the share of the heads the Training Captains can cover. */
  coverage: number;
  /** The Training Captains' share, before the cap. */
  fromTrainingCaptains: number;
  /** The doctrine's share, before the cap. */
  fromDoctrine: number;
  /** True when `maxXpBonus` clipped the sum. */
  capped: boolean;
}

function assertCount(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be zero or more, got ${String(value)}`);
  }
}

/**
 * §10.2's *"multiply XP gain for everyone they fly with"*, with the ceiling
 * that makes the loop converge.
 *
 *     coverage = heads ≤ 0 ? 0 : min(1, trainingCaptains × crewsPerTrainingCaptain / heads)
 *     bonus    = min(maxXpBonus, xpBonusAtFullCoverage × coverage + doctrineXpFraction)
 *
 * **Coverage, not a count.** A bonus per Training Captain would make two of them
 * at a ten-pilot base worth twice one, though one already covers everybody; it
 * would also make a single Training Captain worth as much at a 400-pilot hub as
 * at a 12-pilot outstation. Coverage is what a training department actually
 * provides, and clamping it at 1 is the first half of convergence.
 *
 * **Linear in coverage, then capped.** Not a diminishing curve: §10.4's
 * multiplicative stacking exists to keep a *lone* boost worth its face value,
 * and the same argument applies — the first Training Captain at a base should
 * be worth exactly their share. The cap is the second half of convergence.
 *
 * A base with no pilots has nothing to cover and gets no bonus rather than a
 * division by zero.
 */
export function trainingXpMultiplier(
  input: TrainingXpInput,
  balance: TrainingCaptainBalance,
): TrainingXpMultiplier {
  const doctrine = input.doctrineXpFraction ?? 0;
  assertCount(input.trainingCaptains, 'Training Captains');
  assertCount(input.flightDeckHeads, 'Flight-deck heads');
  assertCount(doctrine, 'Doctrine XP fraction');

  const coverage =
    input.flightDeckHeads <= 0
      ? 0
      : Math.min(
          1,
          (input.trainingCaptains * balance.crewsPerTrainingCaptain) / input.flightDeckHeads,
        );
  const fromTrainingCaptains = balance.xpBonusAtFullCoverage * coverage;
  const uncapped = fromTrainingCaptains + doctrine;
  const bonus = Math.min(balance.maxXpBonus, uncapped);

  return {
    multiplier: 1 + bonus,
    bonus,
    coverage,
    fromTrainingCaptains,
    fromDoctrine: doctrine,
    capped: uncapped > balance.maxXpBonus,
  };
}

/**
 * A head's XP for a sector, once the multiplier has been applied. Whole XP, as
 * `flightXp` itself rounds, and never less than the unmultiplied figure.
 */
export function trainedXpPerHead(xpPerHead: number, training: TrainingXpMultiplier): number {
  return Math.max(xpPerHead, Math.round(xpPerHead * training.multiplier));
}

// ---------------------------------------------------------------------------
// The line value a Training Captain gives up
// ---------------------------------------------------------------------------

/** A named member, with whether they hold the designation. */
export interface RosterCrew extends SkilledCrew {
  trainingCaptain: boolean;
}

/** The roster's skill points, split into the two sources §10.4's resolver stacks. */
export interface CrewBoostSources {
  /** Line pilots' and cabin crew's points, at full strength (M9-03). */
  skills: SourceBoosts;
  /** Training Captains' own points, at `lineContributionFactor` (M9-04). */
  trainingCaptains: SourceBoosts;
  /** How many members put something into each ceiling, per source, for the readout. */
  contributors: {
    skills: Record<BoostCeiling, number>;
    trainingCaptains: Record<BoostCeiling, number>;
  };
}

function emptyCeilings<T>(make: () => T): Record<BoostCeiling, T> {
  return {
    fuelBurn: make(),
    turnaroundTime: make(),
    maintenanceCost: make(),
    incidentRate: make(),
  };
}

/**
 * Every named member's points, split into §10.4's `skills` and
 * `trainingCaptains` sources.
 *
 * §10.2: a Training Captain *"stop[s] generating full revenue value"*. Their
 * skill points are still theirs — a converted Performance & Fuel veteran still
 * knows how to fly a continuous descent — but they spend their duty training
 * other pilots and fly fewer sectors as the operating one, so what their points
 * buy reaches the line at `lineContributionFactor`. Scaling the **fractions**
 * rather than the points keeps the member's allocation untouched: return them
 * to the line and the same points are worth their face value again.
 *
 * Nothing here stacks or caps. The two sources go to `resolveEfficiencyBoosts`
 * together with everything else the airline holds, so §10.4's ceiling is
 * applied once across all of them — returning a stacked figure per source would
 * invite the caller to add two capped numbers, which is the failure the
 * resolver exists to make impossible.
 */
export function crewBoostSources(
  crew: readonly RosterCrew[],
  operatedFamilies: readonly string[],
  skills: CrewSkillBalance,
  training: TrainingCaptainBalance,
): CrewBoostSources {
  const line = emptyCeilings<EfficiencyBoost[]>(() => []);
  const trainers = emptyCeilings<EfficiencyBoost[]>(() => []);
  const contributors = {
    skills: emptyCeilings(() => 0),
    trainingCaptains: emptyCeilings(() => 0),
  };

  crew.forEach((member, index) => {
    const prefix = member.trainingCaptain
      ? `trainingCaptain:${String(index)}`
      : `skill:${String(index)}`;
    const own = skillBoosts(member, operatedFamilies, skills, prefix);
    const factor = member.trainingCaptain ? training.lineContributionFactor : 1;
    const target = member.trainingCaptain ? trainers : line;
    const counts = member.trainingCaptain ? contributors.trainingCaptains : contributors.skills;

    for (const ceiling of Object.keys(own) as BoostCeiling[]) {
      const scaled = own[ceiling]
        .map((boost) => ({ id: boost.id, fraction: boost.fraction * factor }))
        // A line contribution of zero gives nothing, and an entry worth nothing
        // would count somebody as contributing to a ceiling they do not touch.
        .filter((boost) => boost.fraction > 0);
      if (scaled.length === 0) continue;
      target[ceiling].push(...scaled);
      counts[ceiling] += 1;
    }
  });

  return { skills: line, trainingCaptains: trainers, contributors };
}
