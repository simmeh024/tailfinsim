import type { ResearchPointsFormula } from '@tailfin/shared';

/**
 * §10.3's research points (M9-05).
 *
 * ```
 * RP/day = Σ(academy levels) × academyStaffQuality × (fleet flight hours ÷ scalingFactorHours)
 * ```
 *
 * Pure, like everything in `@tailfin/sim`: both free terms arrive as the
 * world's `EconomyConfig.research.pointsFormula`, and `economy-config.ts` says
 * what one unit of each means. This file holds no balance literal.
 *
 * ## Earned per flight, so that a day sums to the formula
 *
 * The formula is a daily rate over the fleet's flight hours, and the fleet's
 * flight hours are nothing but the sum of its flights' block hours. The formula
 * is linear in those hours, so crediting each flight its own share as it
 * settles —
 *
 * ```
 * RP(flight) = Σ(academy levels) × academyStaffQuality × (blockHours ÷ scalingFactorHours)
 * ```
 *
 * — sums over a game day to **exactly** §10.3's per-day figure, whatever the
 * mix of sectors. Nothing has to run at midnight to do the day's sum, so
 * nothing can miss a midnight, and a replayed arrival cannot pay twice because
 * it rides the settlement's own replay guard. The one approximation is that
 * `Σ(academy levels)` is read at each arrival rather than once a day: a level
 * commissioned at noon earns from the next arrival on, which is the more honest
 * of the two readings anyway.
 *
 * ## Size alone earns nothing
 *
 * The fleet term is **multiplied** by the academy levels, never added to them,
 * so an airline with no commissioned academy earns exactly zero however much it
 * flies. §10.3: *"A big airline that never built academies generates almost
 * none — size alone doesn't buy competence."*
 */

export interface ResearchFlightFacts {
  /** Σ of the airline's commissioned academy levels. 0 with none; a building site counts 0. */
  academyLevelSum: number;
  /** The block minutes the settlement billed. */
  blockMinutes: number;
}

export interface ResearchDayFacts {
  academyLevelSum: number;
  /** The fleet's block hours flown in the day. */
  fleetBlockHours: number;
}

function assertFormula(formula: ResearchPointsFormula): void {
  if (!(formula.academyStaffQuality > 0) || !Number.isFinite(formula.academyStaffQuality)) {
    throw new Error(
      `academyStaffQuality must be positive, got ${String(formula.academyStaffQuality)}`,
    );
  }
  if (!(formula.scalingFactorHours > 0) || !Number.isFinite(formula.scalingFactorHours)) {
    throw new Error(
      `scalingFactorHours must be positive, got ${String(formula.scalingFactorHours)}`,
    );
  }
}

function assertLevelSum(academyLevelSum: number): void {
  if (!Number.isInteger(academyLevelSum) || academyLevelSum < 0) {
    throw new Error(`academyLevelSum must be a whole number ≥ 0, got ${String(academyLevelSum)}`);
  }
}

/**
 * §10.3's formula as the design writes it: the points a day of flying earns.
 *
 * The figure the tree explains its rate with, and the figure the per-flight
 * accrual below is proved against.
 */
export function researchPointsPerDay(
  facts: ResearchDayFacts,
  formula: ResearchPointsFormula,
): number {
  assertFormula(formula);
  assertLevelSum(facts.academyLevelSum);
  if (!Number.isFinite(facts.fleetBlockHours) || facts.fleetBlockHours < 0) {
    throw new Error(`fleetBlockHours must be ≥ 0, got ${String(facts.fleetBlockHours)}`);
  }
  return (
    facts.academyLevelSum *
    formula.academyStaffQuality *
    (facts.fleetBlockHours / formula.scalingFactorHours)
  );
}

/**
 * The research points one settled flight earns its airline.
 *
 * Fractional: a short sector at a Training Room earns a fraction of a point,
 * and the server stores milli-points so that fraction is kept rather than
 * rounded away — rounding each one to nothing would starve exactly the small
 * airlines the formula is meant to be slow for, not to stop.
 */
export function researchPointsForFlight(
  facts: ResearchFlightFacts,
  formula: ResearchPointsFormula,
): number {
  if (!Number.isFinite(facts.blockMinutes) || facts.blockMinutes < 0) {
    throw new Error(`blockMinutes must be ≥ 0, got ${String(facts.blockMinutes)}`);
  }
  return researchPointsPerDay(
    { academyLevelSum: facts.academyLevelSum, fleetBlockHours: facts.blockMinutes / 60 },
    formula,
  );
}
