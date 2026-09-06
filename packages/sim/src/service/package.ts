import {
  SERVICE_CATEGORIES,
  selectedTier,
  type CabinClass,
  type ServiceBalance,
  type ServiceCategory,
  type ServicePackageContent,
  type ServiceSelection,
} from '@tailfin/shared';

import { categoryScore, tierBalance } from './bands';

/**
 * What a service package costs, earns and scores (M8-03, App. D.2–D.4).
 *
 * One package, one cabin, one passenger. Everything here is **per passenger
 * carried**, which is the unit App. D quotes throughout and the unit App. D.4's
 * payback table subtracts in; multiplying up by a flight's load is the caller's
 * job, and M8-05's.
 *
 * ## Cost and revenue stay apart
 *
 * They are two lines, never one net figure. App. D.1 writes buy-on-board
 * catering as "−€4.20 (net revenue)" and the halves genuinely differ to
 * everything downstream: M8-01's itemised P&L wants the catering cost and the
 * ancillary revenue on their own rows, and D.4's payback table needs the cost
 * alone to divide the fare premium by. `netPerPaxMinor` is offered as the
 * difference, not as the source of truth.
 *
 * ## Money stays integer
 *
 * Minor units, integers, everywhere — the repository's money rule, with a
 * database guard behind it. The one place a fraction appears is the commercial
 * intensity multiplier, and it is rounded back to an integer immediately.
 */

/** What one passenger in one cabin costs and brings under a package. */
export interface ServiceEconomics {
  /** What the airline pays, minor units per passenger. */
  costPerPaxMinor: number;
  /** What the airline takes, minor units per passenger, intensity applied. */
  revenuePerPaxMinor: number;
  /** Revenue minus cost. Negative on a premium package, which is the point of it. */
  netPerPaxMinor: number;
  /** Minutes this package adds to (or, when negative, takes off) the turnaround. */
  turnaroundDeltaMinutes: number;
}

/** A cabin's per-category score, and what commercial intensity took off it. */
export interface ServiceScores {
  /** Each category's band position at the given execution, before the penalty. */
  byCategory: Record<ServiceCategory, number>;
  /**
   * The satisfaction the commercial dial costs, subtracted from the retail
   * category's score. Zero at rest.
   */
  intensityPenalty: number;
  /** Whether the dial is pushed past the point §15 will hold against the airline. */
  reputationAtRisk: boolean;
}

/** Round a money figure back to integer minor units, away from zero. */
function toMinor(value: number): number {
  return Math.round(value);
}

/**
 * The revenue multiplier the dial applies to onboard retail.
 *
 * Linear in the dial, so half intensity takes half the extra money. That
 * linearity is what makes App. D.2's trade legible to a player, and it is the
 * same linearity the satisfaction penalty uses — the two move together, which is
 * the acceptance criterion in one line.
 */
export function intensityRevenueMultiplier(
  balance: ServiceBalance,
  commercialIntensity: number,
): number {
  const dial = Math.min(1, Math.max(0, commercialIntensity));
  return 1 + dial * (balance.commercialIntensity.revenueMultiplierAtMax - 1);
}

/** The satisfaction the dial costs, linear in the dial for the same reason. */
export function intensitySatisfactionPenalty(
  balance: ServiceBalance,
  commercialIntensity: number,
): number {
  const dial = Math.min(1, Math.max(0, commercialIntensity));
  return dial * balance.commercialIntensity.satisfactionPenaltyAtMax;
}

/** The cabin's selection, or an empty one — a package silent about a cabin sells nothing in it. */
function selectionFor(content: ServicePackageContent, cabin: CabinClass): ServiceSelection {
  return content.perClass[cabin] ?? {};
}

/**
 * What a cabin's selection costs and earns per passenger.
 *
 * The commercial dial multiplies **onboard retail revenue only**. It is the
 * category the appendix attaches it to — what is being pushed is what is being
 * sold on board — and applying it to, say, checked-bag revenue would make the
 * dial a second baggage policy rather than the retail behaviour it describes.
 */
export function packageEconomics(
  balance: ServiceBalance,
  content: ServicePackageContent,
  cabin: CabinClass,
): ServiceEconomics {
  const selection = selectionFor(content, cabin);
  const multiplier = intensityRevenueMultiplier(balance, content.commercialIntensity);

  let costPerPaxMinor = 0;
  let revenuePerPaxMinor = 0;
  let turnaroundDeltaMinutes = 0;

  for (const category of SERVICE_CATEGORIES) {
    const rung = tierBalance(balance, category, selectedTier(selection, category));
    if (rung === undefined) continue;
    costPerPaxMinor += rung.costPerPaxMinor;
    revenuePerPaxMinor +=
      category === 'onboard_retail'
        ? toMinor(rung.revenuePerPaxMinor * multiplier)
        : rung.revenuePerPaxMinor;
    turnaroundDeltaMinutes += rung.turnaroundDeltaMinutes;
  }

  return {
    costPerPaxMinor,
    revenuePerPaxMinor,
    netPerPaxMinor: revenuePerPaxMinor - costPerPaxMinor,
    turnaroundDeltaMinutes,
  };
}

/**
 * Each category's score for a cabin, at a given execution.
 *
 * The composite — App. D.6's `w_seat·seat + w_service·bandPosition + …` — is
 * **not** assembled here. It needs the per-cabin weights M8-04 adds, and
 * inventing them now would put a second `ProductScore` in the codebase, which is
 * precisely what that issue's acceptance criteria forbid.
 *
 * The intensity penalty is reported separately as well as applied, so a payback
 * table can show what the dial cost rather than only the number after it.
 */
export function packageScores(
  balance: ServiceBalance,
  content: ServicePackageContent,
  cabin: CabinClass,
  execution: number,
): ServiceScores {
  const selection = selectionFor(content, cabin);
  const intensityPenalty = intensitySatisfactionPenalty(balance, content.commercialIntensity);

  const byCategory = {} as Record<ServiceCategory, number>;
  for (const category of SERVICE_CATEGORIES) {
    const score = categoryScore(balance, category, selectedTier(selection, category), execution);
    byCategory[category] =
      category === 'onboard_retail' ? Math.max(0, score - intensityPenalty) : score;
  }

  return {
    byCategory,
    intensityPenalty,
    reputationAtRisk: content.commercialIntensity > balance.commercialIntensity.reputationRiskAbove,
  };
}
