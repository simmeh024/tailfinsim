import { z } from 'zod';

import { Timestamp, Uuid } from './primitives';

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

/** One grade a station offers for a service line, and how full it is. */
export const GroundVendorOfferView = z.object({
  grade: HandlerGrade,
  /** Contract slots at this grade. */
  capacity: z.number().int().nonnegative(),
  /** How many are already taken by airlines in this world — capacity minus this is free. */
  taken: z.number().int().nonnegative(),
  reliability: z.number(),
  speedFactor: z.number(),
  quality: z.number(),
});
export type GroundVendorOfferView = z.infer<typeof GroundVendorOfferView>;

/** An airline's active contract for one service line at a station. */
export const GroundContractView = z.object({
  id: Uuid,
  serviceLine: GroundServiceLine,
  grade: HandlerGrade,
  /**
   * Game time the term ends, or null for a legacy contract signed before terms
   * existed. The worker lapses the contract back to walk-up handling at this
   * instant (§9.3).
   */
  termEnd: Timestamp.nullable(),
  /**
   * Whether the term is close enough to lapsing to warn about — §9.3's alert
   * "before it lapses". Computed against the world's game clock, so it is true
   * once a contract is inside the warning window (or already overdue for the
   * worker's next sweep).
   */
  expiring: z.boolean(),
});
export type GroundContractView = z.infer<typeof GroundContractView>;

/** One service line at a station: what it offers, and what the airline has signed. */
export const GroundServiceLineView = z.object({
  serviceLine: GroundServiceLine,
  contracted: GroundContractView.nullable(),
  offers: z.array(GroundVendorOfferView),
});
export type GroundServiceLineView = z.infer<typeof GroundServiceLineView>;

/** `GET /api/ground/:icao` — a station's vendors and this airline's contracts there. */
export const GroundStationResponse = z.object({
  icao: z.string(),
  lines: z.array(GroundServiceLineView),
});
export type GroundStationResponse = z.infer<typeof GroundStationResponse>;

/** One of an airline's contracts, named with the station it is at. */
export const GroundContractAlert = z.object({
  id: Uuid,
  icao: z.string(),
  serviceLine: GroundServiceLine,
  grade: HandlerGrade,
  termEnd: Timestamp.nullable(),
  expiring: z.boolean(),
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
