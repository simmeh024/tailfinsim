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
 * ## Fees and facilities (added by M7-04's second half)
 *
 * App. B.5 gives the purchase table exactly but only says annual facility fees
 * *"scale with tier"* and that each facility has *"its own cost"*, with no figures
 * for either. Those figures are therefore tuned rather than transcribed, and they
 * live where every tuned number does — `ECONOMY_CONFIG_V1.hubs`, with the reasoning
 * beside them. What this module owns is the arithmetic, which is the doc's:
 * facility prices are fractions of the same `tierBaseMinor` the purchase curve
 * uses, so "scales with tier" is the definition and not a second table to keep in
 * step.
 */

import {
  ECONOMY_CONFIG_V1,
  type HubBalance,
  type HubFacilityKind,
  type HubTier,
} from '@tailfin/shared';

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

/**
 * What a hub of `tier` costs to hold for a year, before any facility.
 *
 * The other half of App. B.5's self-balancing argument for the free first hub:
 * acquisition is waived, upkeep is not, and *"a flagship hub bleeds you monthly
 * from day one"*. Unlike the purchase price this does not move with how many hubs
 * are owned — it is a property of the airport's tier alone, which is why an
 * airline can be told it exactly before it commits.
 */
export function hubAnnualFee(tier: HubTier, config: HubCostConfig = DEFAULT_HUB_COST): number {
  return config.annualFeeMinor[tier];
}

/** What one facility costs to open at a hub of `tier`, and to hold for a year after. */
export function hubFacilityCost(
  kind: HubFacilityKind,
  tier: HubTier,
  config: HubCostConfig = DEFAULT_HUB_COST,
): { openingMinor: number; annualFeeMinor: number } {
  const base = config.tierBaseMinor[tier];
  const facility = config.facilities[kind];
  return {
    openingMinor: roundMinor(base * facility.openingCostFraction),
    annualFeeMinor: roundMinor(base * facility.annualFeeFraction),
  };
}

/**
 * A hub's whole annual bill: the hub's own fee plus every facility it has open.
 *
 * `openFacilities` is what the hub actually holds, so a hub with nothing built
 * bills only {@link hubAnnualFee}. Duplicate kinds are counted once — the database
 * cannot hold two of the same facility at one hub, and silently charging twice for
 * a caller's mistake would be the wrong way to find that out.
 */
export function hubAnnualUpkeep(
  tier: HubTier,
  openFacilities: Iterable<HubFacilityKind>,
  config: HubCostConfig = DEFAULT_HUB_COST,
): number {
  let total = hubAnnualFee(tier, config);
  for (const kind of new Set(openFacilities)) {
    total += hubFacilityCost(kind, tier, config).annualFeeMinor;
  }
  return total;
}

/**
 * One month of {@link hubAnnualUpkeep}, which is how the fee is actually billed.
 *
 * App. B.5 states the fee annually and then describes it *"bleeding you
 * monthly"*, so the config holds the year and the biller divides. Rounding is
 * applied to the monthly figure rather than accumulated across a year: an airline
 * pays twelve identical instalments, and twelve of them may differ from the annual
 * figure by up to eleven minor units. That is the right way round — a month's bill
 * an airline can predict matters more than an annual total nothing charges.
 */
export function hubMonthlyUpkeep(
  tier: HubTier,
  openFacilities: Iterable<HubFacilityKind>,
  config: HubCostConfig = DEFAULT_HUB_COST,
): number {
  return roundMinor(hubAnnualUpkeep(tier, openFacilities, config) / MONTHS_PER_YEAR);
}

const MONTHS_PER_YEAR = 12;
