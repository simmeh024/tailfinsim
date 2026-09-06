import type { DemandSegment } from '@tailfin/shared';

import { DEFAULT_LOGIT, type LogitConfig } from '../demand/logit';
import { DEMAND_SEGMENTS } from '../demand/modulation';

/**
 * Does the service spend pay back? (M8-05, App. D.4.)
 *
 * > Service spending only earns its money through the `ProductScore` term in
 * > Appendix A. That is fully calculable, so the game should just tell the player.
 *
 * That is the whole idea, and the reason this file is arithmetic rather than a
 * model: the answer already exists inside App. A.3's utility function, and
 * nobody had ever solved it for the question a player actually asks.
 *
 * ## The two steps
 *
 * A better product raises a segment's utility:
 *
 * ```
 * utilityGain(s) = β_product(s) · Δ ProductScore
 * ```
 *
 * And a higher fare lowers it, through `PriceRel` — fare over the market
 * average. So the fare premium the improvement *supports* is the one that gives
 * exactly that utility back:
 *
 * ```
 * β_price(s) · (Δfare / averageFare) = utilityGain(s)
 *
 * farePremium(s) = utilityGain(s) · averageFare / β_price(s)
 * ```
 *
 * Charge less than that and the product has bought share; charge more and it has
 * bought nothing. `net` is the premium plus whatever the package *earns* per
 * passenger, less what it costs.
 *
 * ## Why the answer differs so violently by segment
 *
 * App. A.3's coefficients are the entire game balance, and the two that matter
 * here point opposite ways: business weights product 2.2 and price 1.1; leisure
 * weights product 0.8 and price 3.0. So the same package supports a premium
 * **seven and a half times larger** in business than in leisure — not because
 * the service is better, but because of who is sitting in the seat.
 *
 * > The identical package loses €7.54 a head on leisure and makes €24.08 a head
 * > on business.
 *
 * ## The same coefficients as demand resolution, not a copy
 *
 * M8-05's third acceptance criterion is that this *"uses the same sim code as
 * demand resolution"*. The `LogitConfig` here is the one `demand/logit.ts`
 * takes — the world's pinned `demand.logit`, not a second table — so a retune
 * moves the payback table and the passengers it predicts together. A copy would
 * eventually tell a player a package pays back while the allocator quietly
 * disagreed.
 */

/** What one segment makes of a service change, per passenger. */
export interface PaybackRow {
  segment: DemandSegment;
  /** `β_product(s) × Δproduct` — the utility the improvement adds. */
  utilityGain: number;
  /** The fare rise that gives exactly that utility back, in minor units. */
  farePremiumSupportedMinor: number;
  /** Premium plus ancillary revenue, less cost. Negative means it does not pay. */
  netPerPaxMinor: number;
}

export interface PaybackInput {
  /** The change in `ProductScore` the package buys, −1 to 1. */
  productDelta: number;
  /** What the package costs per passenger carried, minor units. */
  costPerPaxMinor: number;
  /**
   * What it earns per passenger, minor units.
   *
   * App. D.4's worked example has none — it prices a pure spend — but App. D.3's
   * budget configuration is mostly *revenue*, and a payback table that ignored
   * it would tell a buy-on-board airline its catering was a loss.
   */
  revenuePerPaxMinor: number;
  /** The market's average fare on the route, minor units. `PriceRel`'s denominator. */
  averageFareMinor: number;
}

/**
 * The table App. D.4 says the configurator must show.
 *
 * One row per segment, in `DEMAND_SEGMENTS` order so the table is stable. Money
 * comes back in integer minor units, rounded once at the end — the intermediate
 * utility is a real number and rounding it early would show a player a premium
 * that does not add up to the net beside it.
 */
export function servicePayback(
  input: PaybackInput,
  logit: LogitConfig = DEFAULT_LOGIT,
): PaybackRow[] {
  return DEMAND_SEGMENTS.map((segment) => {
    const beta = logit.beta[segment];
    const utilityGain = beta.product * input.productDelta;
    // A segment that does not care about price at all would support an unbounded
    // premium, which is a division by zero rather than a business opportunity.
    const premium = beta.price === 0 ? 0 : (utilityGain * input.averageFareMinor) / beta.price;
    const farePremiumSupportedMinor = Math.round(premium);
    return {
      segment,
      utilityGain,
      farePremiumSupportedMinor,
      netPerPaxMinor: Math.round(premium + input.revenuePerPaxMinor - input.costPerPaxMinor),
    };
  });
}

/**
 * The payback weighted by who is actually on the route.
 *
 * App. D.4 is emphatic that the table is computed *"against the actual segment
 * mix of the routes the aircraft flies"*, and this is why: a package that loses
 * €7.54 on leisure and makes €24.08 on business is a good idea or a bad one
 * entirely depending on the split. A route that is 10% business loses money on
 * it; one that is 40% business does not.
 *
 * Shares that do not sum to 1 are normalised rather than refused — a caller
 * holding a real demand pool has three numbers that sum to 1 by construction,
 * and a caller previewing a hypothetical should not have to arrange that.
 */
export function weightedNetPerPaxMinor(
  rows: readonly PaybackRow[],
  segmentShare: Readonly<Partial<Record<DemandSegment, number>>>,
): number {
  let weighted = 0;
  let total = 0;
  for (const row of rows) {
    const share = segmentShare[row.segment] ?? 0;
    if (share <= 0) continue;
    weighted += row.netPerPaxMinor * share;
    total += share;
  }
  return total <= 0 ? 0 : Math.round(weighted / total);
}
