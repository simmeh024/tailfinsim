import {
  ECONOMY_CONFIG_V1,
  SERVICE_CATEGORIES,
  type ServiceBalance,
  type ServiceCategory,
  type ServiceTierBalance,
} from '@tailfin/shared';

/**
 * The tier-band rule (M8-03, App. D.1).
 *
 * > **Tier sets the ceiling. Execution decides where you land inside it.**
 *
 * This module is that sentence, and nothing else. Given a tier and how well the
 * airline executes it, it answers where inside the tier's band the service lands
 * — and it cannot answer anything outside that band, which is the whole point:
 *
 * > A **perfectly executed Tier 2** tops out at 0.42. A **badly executed Tier 3**
 * > floors at 0.45. The hot meal still wins.
 *
 * ## Execution arrives, it is not computed here
 *
 * `execution` is a 0–1 input. Deriving it from crew service skill, morale,
 * catering vendor quality and crew-to-passenger ratio — App. D.1's weakest-link
 * formula — is **M8-04**, and deliberately not here. Keeping the two apart is
 * what lets the band rule be proven at the extremes: pass 1 to every tier and 0
 * to every tier and the ladders must still not cross, whatever the eventual
 * formula puts in between.
 *
 * ## No balance literal
 *
 * Every band comes from the world's pinned `EconomyConfig.service`, as
 * `packages/sim`'s standing rule requires. This file contains arithmetic and one
 * clamp.
 */

/** The shipped catalogue. A slice of the seed, like every other `DEFAULT_*`. */
export const DEFAULT_SERVICE: ServiceBalance = ECONOMY_CONFIG_V1.service;

/** Clamp to the unit interval, so a caller's out-of-range execution cannot escape a band. */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Where inside a band an execution value lands — linear from floor to ceiling.
 *
 * Linear because the band is already the non-linear part: the *jump* between
 * tiers is where the money buys score, and within a tier the appendix describes
 * execution as simply deciding *"whether you're getting full value from the
 * money you're already spending"*. A curve here would be a second balance
 * decision hidden in code.
 */
export function bandPosition(band: { min: number; max: number }, execution: number): number {
  return band.min + (band.max - band.min) * unit(execution);
}

/** The balance for one rung, or undefined when the ladder does not go that high. */
export function tierBalance(
  balance: ServiceBalance,
  category: ServiceCategory,
  tier: number,
): ServiceTierBalance | undefined {
  return balance.categories[category].tiers[tier];
}

/**
 * A category's score: the tier's band, positioned by execution.
 *
 * An unknown tier scores **0** rather than throwing. The configurator refuses an
 * off-ladder selection at write time (`validateServicePackage`), so reaching
 * here with one means a package outlived a catalogue that shrank — and the
 * honest reading of "a service this build no longer has" is that the passenger
 * did not receive it, not that the flight cannot be scored.
 */
export function categoryScore(
  balance: ServiceBalance,
  category: ServiceCategory,
  tier: number,
  execution: number,
): number {
  const rung = tierBalance(balance, category, tier);
  return rung === undefined ? 0 : bandPosition(rung.scoreBand, execution);
}

/** A ladder's bands crossing — the thing App. D.1 forbids. */
export interface BandOverlap {
  category: ServiceCategory;
  /** The higher tier, whose floor is at or below the tier below it's ceiling. */
  tier: number;
  lowerCeiling: number;
  higherFloor: number;
}

/**
 * Every place a ladder's bands touch or cross.
 *
 * The economy schema refuses such a payload, so against a stored config this is
 * always empty — which is the point of having it: it is the assertion that the
 * schema's guarantee is the one the appendix asked for, stated where the
 * simulation can check it rather than only where zod can. It also gives a test a
 * way to prove the rule at both extremes of execution rather than on the numbers
 * alone, since a band that does not overlap cannot be made to by any execution
 * value; {@link ladderCrossings} is that check.
 */
export function bandOverlaps(balance: ServiceBalance): BandOverlap[] {
  const overlaps: BandOverlap[] = [];
  for (const category of SERVICE_CATEGORIES) {
    const tiers = balance.categories[category].tiers;
    for (let tier = 1; tier < tiers.length; tier += 1) {
      const below = tiers[tier - 1];
      const here = tiers[tier];
      if (below === undefined || here === undefined) continue;
      if (here.scoreBand.min <= below.scoreBand.max) {
        overlaps.push({
          category,
          tier,
          lowerCeiling: below.scoreBand.max,
          higherFloor: here.scoreBand.min,
        });
      }
    }
  }
  return overlaps;
}

/** A lower tier scoring at or above a higher one — the failure, stated in outcomes. */
export interface LadderCrossing {
  category: ServiceCategory;
  lowerTier: number;
  higherTier: number;
  /** The lower tier's score at the execution that flatters it most. */
  lowerScore: number;
  /** The higher tier's score at the execution that flatters it least. */
  higherScore: number;
}

/**
 * Every pair of tiers where spending more can fail to score more.
 *
 * The acceptance test in outcome terms rather than in interval terms: for each
 * category, the **best** any tier can be executed against the **worst** every
 * tier above it can be executed. If a perfectly run Tier 2 ever reaches a
 * botched Tier 3, App. D.1's promise is broken however tidy the intervals look.
 *
 * Every pair, not only adjacent ones — an overlap check on neighbours would miss
 * a ladder where tier 4's floor sat under tier 2's ceiling while each neighbour
 * pair was fine.
 */
export function ladderCrossings(balance: ServiceBalance): LadderCrossing[] {
  const crossings: LadderCrossing[] = [];
  for (const category of SERVICE_CATEGORIES) {
    // The *balance's* ladder, not `maxTier`'s. Reading the length from
    // `SERVICE_LADDERS` walked tiers the payload does not price, scored them 0,
    // and reported a crossing against every one of them — a check that fails
    // loudest exactly when it is given a smaller catalogue than it expected.
    const top = balance.categories[category].tiers.length - 1;
    for (let lower = 0; lower < top; lower += 1) {
      // Perfectly executed: the top of its band.
      const lowerScore = categoryScore(balance, category, lower, 1);
      for (let higher = lower + 1; higher <= top; higher += 1) {
        // Badly executed: the bottom of its band.
        const higherScore = categoryScore(balance, category, higher, 0);
        if (lowerScore >= higherScore) {
          crossings.push({
            category,
            lowerTier: lower,
            higherTier: higher,
            lowerScore,
            higherScore,
          });
        }
      }
    }
  }
  return crossings;
}
