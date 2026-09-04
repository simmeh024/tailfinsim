import { z } from 'zod';

import { MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * Ground handling — the wire contract (M5-06, §9.3).
 *
 * The service lines and handler grades live here, in `@tailfin/shared`, so the
 * one definition is shared by the sim that models a grade's behaviour, the server
 * that stores contracts against it, and the client that shows both. A station's
 * *vendors* are derived (see `@tailfin/sim`'s `stationVendors`); what an airline
 * *signs* against them is a contract, and that is what crosses this boundary.
 */

/** The service lines a station's ground work divides into (§9.3). */
export const GroundServiceLine = z.enum([
  'ramp_baggage',
  'fuelling',
  'catering',
  'cleaning',
  'pushback',
  'deicing',
]);
export type GroundServiceLine = z.infer<typeof GroundServiceLine>;
export const GROUND_SERVICE_LINES = GroundServiceLine.options;

/** A handler's quality tier — the named bundle of §9.3's trade. */
export const HandlerGrade = z.enum(['budget', 'standard', 'premium']);
export type HandlerGrade = z.infer<typeof HandlerGrade>;
export const HANDLER_GRADES = HandlerGrade.options;

/**
 * One grade a station offers for a service line, and how full it is.
 *
 * All five of §9.3's numbers, since M5-06's price landed — *price · reliability ·
 * speed · quality · capacity*. `priceIndex` was the missing one, and without it
 * the offer told a player that the budget handler was slower and clumsier while
 * saying nothing about the only reason to take it.
 */
export const GroundVendorOfferView = z.object({
  grade: HandlerGrade,
  /** Contract slots at this grade. */
  capacity: z.number().int().nonnegative(),
  /** How many are already taken by airlines in this world — capacity minus this is free. */
  taken: z.number().int().nonnegative(),
  reliability: z.number(),
  speedFactor: z.number(),
  quality: z.number(),
  /**
   * What a turn costs here relative to the standard grade. The absolute money is
   * the world's economy config; this is the multiplier on it.
   */
  priceIndex: z.number(),
  /** Departures this grade's vendor would require over a full term (§9.3). */
  committedDepartures: z.number().int().nonnegative(),
  /** What breaking the whole term would cost, before the pro-rata for time served. */
  fullTermPenaltyMinor: MinorUnits.nonnegative(),
});
export type GroundVendorOfferView = z.infer<typeof GroundVendorOfferView>;

/** How a service line at a station is being handled. */
export const GroundHandlingKind = z.enum(['vendor', 'self']);
export type GroundHandlingKind = z.infer<typeof GroundHandlingKind>;

/**
 * Handling the line yourself, as an option on the station (§9.3).
 *
 * §9.3 asks for self-handling *"requiring a station and headcount"*, and both
 * halves are here: `available` is false without a hub at this airport — the
 * station — and `requiredHeadcount` is what the airport needs staffed. The trade
 * against a vendor is fixed monthly payroll against a per-turn fee, so it is the
 * volume through the station that decides which is cheaper.
 */
export const GroundSelfHandlingOffer = z.object({
  /** Whether the airline may open self-handling here at all. */
  available: z.boolean(),
  /** Why not, when it may not. `null` when it may. */
  unavailableReason: z.literal('needs_hub').nullable(),
  /** Heads this station needs to be handled properly, from its tier. */
  requiredHeadcount: z.number().int().nonnegative(),
  /** What one head costs a month. Payable whether or not anything flies. */
  salaryPerHeadMinor: MinorUnits.nonnegative(),
});
export type GroundSelfHandlingOffer = z.infer<typeof GroundSelfHandlingOffer>;

/**
 * How an airline is handling one service line at a station: a vendor's contract,
 * or its own people.
 *
 * One view with a `kind` discriminator rather than two, because a client asking
 * *"who is working my turns here"* has one question and three answers, and the
 * third — nothing arranged at all — is this being absent.
 */
export const GroundContractView = z.object({
  id: Uuid,
  serviceLine: GroundServiceLine,
  kind: GroundHandlingKind,
  /** The vendor's grade. **Null when the airline handles the line itself.** */
  grade: HandlerGrade.nullable(),
  /** Heads employed here. Null for a vendor contract. */
  headcount: z.number().int().nonnegative().nullable(),
  /**
   * Heads employed over heads the station needs, 0–1 and capped there. Null for a
   * vendor contract.
   *
   * Below 1 is an understaffed operation, and it is deliberately possible: it
   * costs less and the handling is worse, which is §9.2's cost-cutting trade
   * moved onto the ramp.
   */
  staffing: z.number().nullable(),
  /**
   * Game time the term ends, or null for a legacy contract signed before terms
   * existed — and null for self-handling, which has no term because there is no
   * counterparty to have agreed one. The worker lapses a vendor contract back to
   * walk-up handling at this instant (§9.3).
   */
  termEnd: Timestamp.nullable(),
  /**
   * Whether the term is close enough to lapsing to warn about — §9.3's alert
   * "before it lapses". Computed against the world's game clock, so it is true
   * once a contract is inside the warning window (or already overdue for the
   * worker's next sweep). Always false for self-handling.
   */
  expiring: z.boolean(),
  /** Departures the term commits to (§9.3). Null for self-handling. */
  committedDepartures: z.number().int().nonnegative().nullable(),
  /**
   * What walking away **right now** would cost, pro-rated to what is left of the
   * term. Zero for self-handling, which costs nothing to close beyond the payroll
   * it stops.
   */
  earlyTerminationPenaltyMinor: MinorUnits.nonnegative(),
});
export type GroundContractView = z.infer<typeof GroundContractView>;

/** One service line at a station: what it offers, and what the airline has arranged. */
export const GroundServiceLineView = z.object({
  serviceLine: GroundServiceLine,
  /** The airline's own arrangement, or null when it is handled walk-up. */
  contracted: GroundContractView.nullable(),
  offers: z.array(GroundVendorOfferView),
  /** Handling it yourself, and whether this airline may (§9.3). */
  selfHandling: GroundSelfHandlingOffer,
  /**
   * What a turn on this line costs with nothing arranged, relative to standard.
   *
   * Above 1: handling bought on the day is dearer than handling bought on a term,
   * which is why signing anything — even the budget handler — is worth doing.
   */
  walkUpPriceIndex: z.number(),
});
export type GroundServiceLineView = z.infer<typeof GroundServiceLineView>;

/** `GET /api/ground/:icao` — a station's vendors and this airline's contracts there. */
export const GroundStationResponse = z.object({
  icao: z.string(),
  lines: z.array(GroundServiceLineView),
});
export type GroundStationResponse = z.infer<typeof GroundStationResponse>;

/**
 * One of an airline's arrangements, named with the station it is at.
 *
 * Carries the two things a player needs warning about and cannot see from one
 * station's page: a term about to lapse, and a **volume commitment it is not
 * going to meet**. The second is the more expensive surprise — a shortfall is
 * billed at the end of the term, by which time nothing can be done about it.
 */
export const GroundContractAlert = z.object({
  id: Uuid,
  icao: z.string(),
  serviceLine: GroundServiceLine,
  kind: GroundHandlingKind,
  grade: HandlerGrade.nullable(),
  headcount: z.number().int().nonnegative().nullable(),
  staffing: z.number().nullable(),
  termEnd: Timestamp.nullable(),
  expiring: z.boolean(),
  /** Departures the term commits to. Null for self-handling. */
  committedDepartures: z.number().int().nonnegative().nullable(),
  /** Departures actually flown out of this station inside the term so far. */
  departuresFlown: z.number().int().nonnegative().nullable(),
  /**
   * What the shortfall would cost if the term ended now, in minor units.
   *
   * Zero once the commitment is met, and zero for self-handling. A live figure
   * rather than a stored one: it falls as the airline flies, which is the whole
   * point of surfacing it before the term closes.
   */
  shortfallFeeMinor: MinorUnits.nonnegative(),
  /** What walking away right now would cost. Zero for self-handling. */
  earlyTerminationPenaltyMinor: MinorUnits.nonnegative(),
});
export type GroundContractAlert = z.infer<typeof GroundContractAlert>;

/**
 * `GET /api/ground/contracts` — every active contract this airline holds, across
 * all stations, so the ones about to lapse are one call rather than a sweep of the
 * network. `expiring` is the alert §9.3 asks for surfaced before a term runs out.
 */
export const GroundContractsResponse = z.object({
  contracts: z.array(GroundContractAlert),
});
export type GroundContractsResponse = z.infer<typeof GroundContractsResponse>;

/** `POST /api/ground/:icao/contracts` — sign a handler for a service line. */
export const SignContractRequest = z
  .object({
    serviceLine: GroundServiceLine,
    grade: HandlerGrade,
  })
  .strict();
export type SignContractRequest = z.infer<typeof SignContractRequest>;

/**
 * `POST /api/ground/:icao/self-handling` — handle a line with your own people.
 *
 * Also the way to change the headcount of an operation already open: one request
 * that says what the staffing should be, rather than an open and a separate
 * resize. §9.3 requires a station for it, so this is refused without a hub here.
 */
export const OpenSelfHandlingRequest = z
  .object({
    serviceLine: GroundServiceLine,
    /** Heads to employ. Zero is not a staffing level — close the operation instead. */
    headcount: z.number().int().positive().max(10_000),
  })
  .strict();
export type OpenSelfHandlingRequest = z.infer<typeof OpenSelfHandlingRequest>;
