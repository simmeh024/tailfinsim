/**
 * What the next hub costs (M7-04, App. B.5).
 *
 * A hub is where an airline bases aircraft, holds gates and stations crew. The
 * first is free at any tier; after that the price is the tier's base doubled for
 * every hub already owned:
 *
 *     HubCost = tierBase × costGrowth^(hubs_owned − 1)
 *
 * The multiplier counts **hubs owned, not hubs of that tier** — which is the whole
 * strategic point. Three cheap small hubs taken early do not just cost their own
 * $14M; they push every later flagship two doublings up the curve, so the same four
 * flagships that would have cost $375M as hubs 2–5 cost $3,000M as hubs 5–8. The
 * player can see that arithmetic before committing.
 *
 * ## Balance lives in the config, not here (invariant 3)
 *
 * The tier bases and the growth factor are `ECONOMY_CONFIG_V1.hubs` in
 * `@tailfin/shared` — the retunable §22.3 payload. {@link DEFAULT_HUB_COST} is the
 * default parameter for this pure function; the server passes the world's pinned
 * config instead.
 *
 * Fees and facilities are not modelled here: App. B.5 gives the purchase table
 * exactly but no facility-fee figures, so those belong to a later slice rather than
 * to invented numbers.
 */

import { ECONOMY_CONFIG_V1, type HubBalance, type HubTier } from '@tailfin/shared';

import { roundMinor } from './money';

export type HubCostConfig = HubBalance;

/** The shipped hub curve, as currently tuned. */
export const DEFAULT_HUB_COST: HubCostConfig = ECONOMY_CONFIG_V1.hubs;

/** Version tag, mirroring the rest — a hub bill has to stay explicable. */
export const HUB_COST_VERSION = 'v1' as const;

/**
 * The price of the next hub of `tier`, given how many the airline already owns.
 *
 * `hubsOwned` is the count **before** this purchase: 0 for the first hub (free at
 * any tier, App. B.5's "1st: free"), 1 for the second, and so on. Returns integer
 * minor units.
 */
export function hubPurchaseCost(
  tier: HubTier,
  hubsOwned: number,
  config: HubCostConfig = DEFAULT_HUB_COST,
): number {
  if (!Number.isInteger(hubsOwned) || hubsOwned < 0) {
    throw new Error(`hubsOwned must be a non-negative integer, got ${String(hubsOwned)}`);
  }
  // The first hub is free at any tier — the waiver the founding grant relies on
  // (airlineStartingPosition.freeHubAllowance). Everything after follows the curve.
  if (hubsOwned === 0) return 0;
  return roundMinor(config.tierBaseMinor[tier] * config.costGrowth ** (hubsOwned - 1));
}
