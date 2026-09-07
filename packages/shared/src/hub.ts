import { z } from 'zod';

import { AirportTier, SlotLevel } from './airport';
import { HubFacilityKind, HubTier } from './economy-config';
import {
  AirportIataCode,
  AirportIcaoCode,
  AirportIdent,
  CountryCode,
  MinorUnits,
  Timestamp,
  Uuid,
} from './primitives';

/**
 * Hubs — the wire contract (M7-04, App. B.5).
 *
 * A hub is where an airline bases aircraft, holds gates and stations crew. The
 * purchase *curve* lives in `@tailfin/sim` and its coefficients in the economy
 * config; this is only the shape of what crosses the HTTP boundary.
 *
 * ## Every price on these types is server-decided
 *
 * The client never computes a hub price, and never sends one it invented. It is
 * told what the next hub costs, it shows that, and it echoes the figure back on
 * the purchase so the server can refuse a stale one. That echo is App. B.5's
 * *"the player can see the arithmetic before committing"* turned into something
 * the server enforces rather than something the UI promises — see
 * {@link PurchaseHubRequest}.
 */

export { HubFacilityKind, HubTier };

/**
 * The priced tier of a hub, pinned when it is bought.
 *
 * B.3 classifies airports into **five** tiers and App. B.5 prices **four**, so
 * `regional` has no price of its own and is charged at the `small` base — the
 * cheapest band, for the least capable airport. The band is stored on the hub
 * rather than re-read from the airport, because a later reference-data refresh
 * may reclassify the airport and a hub's bill has to stay explicable: the fee an
 * airline pays is the one it agreed to, not the one today's tier implies.
 */
export function hubTierForAirport(tier: AirportTier): HubTier {
  return tier === 'regional' ? 'small' : tier;
}

/** One facility a hub has opened, or could. */
export const HubFacilityView = z.object({
  kind: HubFacilityKind,
  /** Null when it is not open — the two costs then say what opening it would take. */
  openedAt: Timestamp.nullable(),
  openingCostMinor: MinorUnits.nonnegative(),
  annualFeeMinor: MinorUnits.nonnegative(),
  /**
   * Why this facility cannot be opened right now, or null when it can.
   *
   * `already_open` and `requires_maintenance_line` are the only two: App. B.5
   * orders the maintenance line before heavy check capability, and nothing else
   * gates a facility beyond having the cash.
   */
  blockedBy: z.enum(['already_open', 'requires_maintenance_line']).nullable(),
});
export type HubFacilityView = z.infer<typeof HubFacilityView>;

/** One hub an airline owns. */
export const HubView = z.object({
  id: Uuid,
  airportIdent: AirportIdent,
  airportIcao: AirportIcaoCode.nullable(),
  airportIata: AirportIataCode.nullable(),
  airportName: z.string().min(1),
  tier: HubTier,
  /** True only when consumed from the world's free-hub starting allowance. */
  founderGrant: z.boolean(),
  /** What this hub cost when it was bought. Zero for the founder grant. */
  purchaseCostMinor: MinorUnits.nonnegative(),
  /** Game time the hub opened, so a world reset moves it with everything else. */
  openedAt: Timestamp,
  /** The hub's own annual fee, before any facility. */
  annualFeeMinor: MinorUnits.nonnegative(),
  /** Hub fee plus every open facility's fee — what this hub bills a year. */
  totalAnnualFeeMinor: MinorUnits.nonnegative(),
  facilities: z.array(HubFacilityView),
});
export type HubView = z.infer<typeof HubView>;

/**
 * What the *next* hub would cost at each tier, given how many are already owned.
 *
 * The whole point of App. B.5 is that this is one curve across all tiers, so the
 * client is given all four prices rather than the one it asked about: "every
 * cheap hub you buy makes every future flagship twice as expensive" is only
 * legible if the flagship price is on screen while the small one is being
 * considered.
 */
export const NextHubPricing = z.object({
  hubsOwned: z.number().int().nonnegative(),
  small: MinorUnits.nonnegative(),
  medium: MinorUnits.nonnegative(),
  large: MinorUnits.nonnegative(),
  flagship: MinorUnits.nonnegative(),
});
export type NextHubPricing = z.infer<typeof NextHubPricing>;

export const HubsResponse = z.object({
  hubs: z.array(HubView),
  /** Hub fee plus facility fees, summed across every hub. */
  totalAnnualFeeMinor: MinorUnits.nonnegative(),
  nextHub: NextHubPricing,
});
export type HubsResponse = z.infer<typeof HubsResponse>;

/**
 * How contested an airport's slots are, as a fact rather than a warning.
 *
 * App. B.5's self-balancing argument for the free flagship hub is *"slot scarcity
 * is brutal at Level 3 airports"*, and until M7-05 there was nothing to measure —
 * the founding desk could only say so qualitatively. There is now a real slot
 * model, so a candidate carries real numbers and the prose is the client's
 * problem.
 */
export const HubSlotScarcity = z.object({
  slotLevel: SlotLevel.nullable(),
  /** True only at IATA Level 3, where a holding is required before you may depart. */
  coordinated: z.boolean(),
  /** Airlines that may hold any one hourly band here. Zero when uncoordinated. */
  capacityPerBand: z.number().int().nonnegative(),
  /** Hourly bands, of 24, with no room left for another airline. */
  bandsFull: z.number().int().nonnegative(),
});
export type HubSlotScarcity = z.infer<typeof HubSlotScarcity>;

/**
 * An airport the airline could take as its next hub, priced.
 *
 * Everything an informed refusal needs is on this one object: what it costs to
 * buy, what it costs every year afterwards, and how hard it will be to get a
 * departure slot. That is the third acceptance criterion of M7-04 — a free
 * flagship is permitted, but not by accident.
 */
export const HubCandidate = z.object({
  ident: AirportIdent,
  icao: AirportIcaoCode.nullable(),
  iata: AirportIataCode.nullable(),
  name: z.string().min(1),
  city: z.string().min(1).nullable(),
  country: CountryCode,
  airportTier: AirportTier,
  tier: HubTier,
  /** What this airport costs as the airline's next hub, on today's curve. */
  purchaseCostMinor: MinorUnits.nonnegative(),
  /** The hub's own annual fee at this tier, before any facility. */
  annualFeeMinor: MinorUnits.nonnegative(),
  slots: HubSlotScarcity,
  /** True when the airline already has a hub here — it cannot be bought twice. */
  alreadyHeld: z.boolean(),
});
export type HubCandidate = z.infer<typeof HubCandidate>;

export const HubCandidateListResponse = z.object({
  airports: z.array(HubCandidate),
  query: z.string(),
  nextHub: NextHubPricing,
});
export type HubCandidateListResponse = z.infer<typeof HubCandidateListResponse>;

/**
 * Buy a hub at an airport.
 *
 * `expectedCostMinor` is not belt-and-braces. App. B.5's curve counts **hubs
 * owned**, so the price on screen is only correct until the airline buys
 * something else — and an airline whose second browser tab bought a small hub
 * while this one was reading about a flagship would otherwise be charged double
 * without ever seeing the new figure. Echoing the quoted price back makes the
 * server refuse that with `409 hub_cost_changed` and re-quote, which is what
 * *"the player can see the arithmetic before committing"* has to mean when the
 * arithmetic can move underneath them.
 */
export const PurchaseHubRequest = z
  .object({
    airportIdent: AirportIdent,
    expectedCostMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type PurchaseHubRequest = z.infer<typeof PurchaseHubRequest>;

/** Open one facility at a hub. The cost is the server's; the kind is the client's. */
export const OpenHubFacilityRequest = z
  .object({
    kind: HubFacilityKind,
    expectedCostMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type OpenHubFacilityRequest = z.infer<typeof OpenHubFacilityRequest>;

/** Both writes answer with the whole hub list, so a client never has to re-fetch. */
export const HubMutationResponse = HubsResponse;
export type HubMutationResponse = z.infer<typeof HubMutationResponse>;
