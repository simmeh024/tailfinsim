/**
 * What a stand costs to hold (M7-06, App. B.6).
 *
 * The other half of `route/gates.ts`. That module answers *how many stands does
 * this operation need*; this one answers *what does holding one cost*, and the
 * split is the same one `route/slots.ts` and this directory already make — a
 * requirement is a rule, a price is balance.
 *
 * ## Balance lives in the config, not here (invariant 3)
 *
 * Every number is `ECONOMY_CONFIG_V1.gates` in `@tailfin/shared`, the retunable
 * §22.3 payload. {@link DEFAULT_GATE_COST} is the default parameter for these
 * pure functions; the server passes the world's pinned config instead.
 *
 * ## One quoted price, and multipliers off it
 *
 * App. B.6 states one absolute figure — a preferentially leased contact gate at
 * $18,000 a month — and describes everything else relatively. So does this: the
 * stand kind and the contract are multipliers, which makes *"a remote stand is
 * 35% of a contact gate"* the definition rather than a second price list to keep
 * in step with the first. `hub-cost.ts` prices a facility the same way and for
 * the same reason.
 *
 * ## An annual figure billed monthly, exactly like a hub
 *
 * App. B.6 quotes leases *per month* and the config stores them *per year*,
 * which looks backwards until you notice that {@link hubAnnualFee} has the same
 * shape. The year is the retunable quantity; the month is what a player is
 * charged, and rounding on the monthly figure gives twelve identical instalments
 * rather than eleven identical ones and a remainder.
 */

import {
  ECONOMY_CONFIG_V1,
  type AirportTier,
  type GateBalance,
  type GateContract,
  type StandKind,
} from '@tailfin/shared';

import { roundMinor } from './money';

export type GateCostConfig = GateBalance;

/** The shipped stand prices, as currently tuned. */
export const DEFAULT_GATE_COST: GateCostConfig = ECONOMY_CONFIG_V1.gates;

/** Version tag, mirroring the rest — a gate bill has to stay explicable. */
export const GATE_COST_VERSION = 'v1' as const;

const MONTHS_PER_YEAR = 12;

/**
 * What one stand of `kind`, held on `contract`, costs for a year at a `tier` airport.
 *
 * Zero for a common-use stand, which is not leased: it is paid a turn at a time
 * through {@link commonUseTurnFee}. That zero is load-bearing rather than a
 * degenerate case — it is what makes "fly through twice a week, pay walk-up"
 * cheaper than a lease, which is the decision App. B.6's contract table exists
 * to create.
 */
export function standAnnualFee(
  kind: StandKind,
  contract: GateContract,
  tier: AirportTier,
  config: GateCostConfig = DEFAULT_GATE_COST,
): number {
  const base = config.contactGateAnnualFeeMinor[tier];
  return roundMinor(base * config.standFactor[kind] * config.contractFactor[contract]);
}

/**
 * One month of {@link standAnnualFee}, which is how a lease is actually billed.
 *
 * Rounded on the month rather than accumulated across the year, for the reason
 * `hubMonthlyUpkeep` gives: a month an airline can predict is worth more than an
 * annual total nothing charges.
 */
export function standMonthlyFee(
  kind: StandKind,
  contract: GateContract,
  tier: AirportTier,
  config: GateCostConfig = DEFAULT_GATE_COST,
): number {
  return roundMinor(standAnnualFee(kind, contract, tier, config) / MONTHS_PER_YEAR);
}

/**
 * What one turn costs on a common-use stand — the alternative to holding a lease.
 *
 * A fraction of a *month* of the same stand's preferential lease, so the
 * crossover moves with the price rather than needing its own tier table. At the
 * shipped 0.014 a flagship contact turn is $252 and a lease starts paying at
 * about 71 turns a month.
 *
 * Quoted per stand **kind**, because a walk-up onto a remote stand is cheaper
 * than a walk-up onto a jet bridge for exactly the reason the lease is.
 */
export function commonUseTurnFee(
  kind: StandKind,
  tier: AirportTier,
  config: GateCostConfig = DEFAULT_GATE_COST,
): number {
  const monthly = standMonthlyFee(kind, 'preferential', tier, config);
  return roundMinor(monthly * config.commonUseTurnFeeFraction);
}

/**
 * How many turns a month a lease needs before it beats paying per turn.
 *
 * Decision support (§14), never a gate: the server publishes it beside the offer
 * so a player can see what they are buying, in the same spirit as App. B.5's
 * *"the player can see the arithmetic before committing"*. `Infinity` when a
 * walk-up is free, which is a configuration a world may choose and not an error.
 */
export function leaseBreakevenTurnsPerMonth(
  kind: StandKind,
  contract: GateContract,
  tier: AirportTier,
  config: GateCostConfig = DEFAULT_GATE_COST,
): number {
  const perTurn = commonUseTurnFee(kind, tier, config);
  if (perTurn <= 0) return Number.POSITIVE_INFINITY;
  return standMonthlyFee(kind, contract, tier, config) / perTurn;
}

/**
 * A whole airport's monthly bill for one airline's leased stands.
 *
 * Summed per stand rather than by multiplying a count, because an airline's
 * holdings at one airport are deliberately heterogeneous — App. B.6's worked
 * example holds a contact gate *and* an overnight position, at prices an order of
 * magnitude apart, and a count times an average would report neither.
 */
export function standsMonthlyFee(
  stands: Iterable<{ kind: StandKind; contract: GateContract }>,
  tier: AirportTier,
  config: GateCostConfig = DEFAULT_GATE_COST,
): number {
  let total = 0;
  for (const stand of stands) {
    total += standMonthlyFee(stand.kind, stand.contract, tier, config);
  }
  return total;
}
