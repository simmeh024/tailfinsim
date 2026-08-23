import type { CrewRegulationBalance } from '@tailfin/shared';

import { coversRank, requiredComplement, type Complement, type CrewRank } from './complement';

/**
 * Crew pools, and why a mixed fleet hurts (§9.2, M5-01).
 *
 * ## Counts, never people
 *
 * A pool is a **number of heads at a rank, rated on a family, at a base**. There
 * is no crew member row anywhere in M5-01, and that is the acceptance criterion
 * rather than a shortcut: *"the player interacts with pool sizes and policies,
 * never with individual rosters"*. Hand-rostering four hundred flight attendants
 * is the failure mode the issue names, and the cheapest way never to build it is
 * to have nothing to roster.
 *
 * Individual hours and proficiency are M9. Nothing here should grow a person.
 *
 * ## Fragmentation is arithmetic, not a penalty
 *
 * There is no "commonality malus" coefficient here, and there should not be. A
 * crew member rated on the A320neo family simply is not in the 737 MAX pool, so
 * an airline flying both needs two sets of Captains to cover the same number of
 * departures. The shortfall falls out of the counting; inventing a multiplier on
 * top would be charging twice for one effect and would hide where it came from.
 *
 * `fragmentation` exists only to **show** the player what the arithmetic already
 * did, because §9.2's complaint is that a mixed fleet *"quietly wrecks your
 * utilisation"* — and quiet is the part an interface has to fix.
 */

/** How many heads of one rank, rated on one family, at one base. */
export interface CrewPool {
  /** The aircraft family the pool is rated on — never a single type (§9.2). */
  family: string;
  rank: CrewRank;
  /** Heads on strength, including any currently unavailable. */
  headcount: number;
  /**
   * Heads not available to roster — in conversion training, mostly.
   *
   * Held here rather than subtracted at write time so the player can see that
   * their crew exist but are in a classroom, which is the whole point of
   * conversion having a duration.
   */
  unavailable: number;
}

/** Heads that can actually be rostered right now. */
export function availableHeads(pool: CrewPool): number {
  return Math.max(0, pool.headcount - pool.unavailable);
}

export interface ComplementShortfall {
  rank: CrewRank;
  /** How many the flight needs. */
  needed: number;
  /** How many the family's pools can actually field. */
  available: number;
}

export type ComplementCheck =
  | { ok: true; complement: Complement }
  | { ok: false; complement: Complement; shortfalls: readonly ComplementShortfall[] };

/**
 * Can this family's crew fly this flight?
 *
 * Greedy from the **most junior rank that covers the slot upward**, which is the
 * only ordering that does not manufacture a shortage. Filling a Captain slot from
 * the Training Captain pool first would leave Captains idle and report a
 * shortfall of Training Captains on the next flight that wanted one; taking the
 * juniormost adequate head keeps seniority in reserve for the slots that actually
 * require it.
 *
 * Reports **every** unmet rank rather than the first, because the answer a player
 * needs is "hire two Captains and a Purser", not "hire a Captain" three times.
 */
export function checkComplement(
  input: { seats: number; blockMinutes: number },
  pools: readonly CrewPool[],
  family: string,
  regulation?: CrewRegulationBalance,
): ComplementCheck {
  const complement = requiredComplement(input, regulation);

  // A working copy: heads consumed by one slot are not available to the next.
  const remaining = pools
    .filter((pool) => pool.family === family)
    .map((pool) => ({ rank: pool.rank, heads: availableHeads(pool) }));

  const shortfalls: ComplementShortfall[] = [];
  for (const slot of [...complement.flightDeck, ...complement.cabin]) {
    const eligible = remaining
      .filter((pool) => coversRank(pool.rank, slot.rank))
      .sort((a, b) => seniorityOf(a.rank) - seniorityOf(b.rank));

    let outstanding = slot.count;
    for (const pool of eligible) {
      if (outstanding === 0) break;
      const taken = Math.min(pool.heads, outstanding);
      pool.heads -= taken;
      outstanding -= taken;
    }
    if (outstanding > 0) {
      shortfalls.push({ rank: slot.rank, needed: slot.count, available: slot.count - outstanding });
    }
  }

  return shortfalls.length === 0 ? { ok: true, complement } : { ok: false, complement, shortfalls };
}

/** Position in whichever ladder the rank belongs to. Used only for ordering. */
function seniorityOf(rank: CrewRank): number {
  const deck = ['cadet', 'first_officer', 'senior_first_officer', 'captain', 'training_captain'];
  const cabin = ['cabin_crew', 'senior_cabin_crew', 'purser', 'cabin_service_manager'];
  const inDeck = deck.indexOf(rank);
  return inDeck >= 0 ? inDeck : cabin.indexOf(rank);
}

export interface FragmentationReport {
  /** Families the airline holds crew for. */
  families: readonly string[];
  /** Heads available, summed across every family. */
  totalAvailable: number;
  /**
   * The largest single family's available heads.
   *
   * The useful comparison against `totalAvailable`: it is what the airline could
   * field if the whole fleet were one family, and the gap is the cost of not.
   */
  largestFamilyAvailable: number;
  /**
   * Available heads that are *not* in the largest family.
   *
   * Not wasted crew — they fly their own aeroplanes. It is the number that cannot
   * be pooled, which is what fleet commonality buys back.
   */
  strandedHeads: number;
}

/**
 * What a mixed fleet costs, stated rather than implied.
 *
 * Reports one family as unfragmented (`strandedHeads: 0`) rather than as a
 * special case, and an airline with no crew at all as zeroes rather than
 * throwing — an empty pool is the state every new airline starts in, not an
 * error.
 */
export function fragmentation(pools: readonly CrewPool[]): FragmentationReport {
  const byFamily = new Map<string, number>();
  for (const pool of pools) {
    byFamily.set(pool.family, (byFamily.get(pool.family) ?? 0) + availableHeads(pool));
  }

  const families = [...byFamily.keys()].sort();
  const totalAvailable = [...byFamily.values()].reduce((n, heads) => n + heads, 0);
  const largestFamilyAvailable = families.length === 0 ? 0 : Math.max(...byFamily.values());

  return {
    families,
    totalAvailable,
    largestFamilyAvailable,
    strandedHeads: totalAvailable - largestFamilyAvailable,
  };
}
