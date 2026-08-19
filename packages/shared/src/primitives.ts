import { z } from 'zod';

/**
 * Scalars every other schema is built from.
 *
 * These exist so that "an airline IATA code" is one definition rather than a
 * regex copied into six files. Two things they encode that are easy to get
 * wrong:
 *
 *   - Airline and airport codes are **different lengths**. Airline IATA is two
 *     characters, airport IATA is three; airline ICAO is three, airport ICAO is
 *     four. Using one `IataCode` for both is a bug waiting to happen.
 *   - Money crosses the wire as **integer minor units**, never a decimal
 *     string or a float. See `MinorUnits`.
 */

/** Every entity id is a UUID (see `packages/server/src/db/schema.ts`). */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/**
 * Timestamps cross the wire as ISO 8601 with an offset, not as `Date`.
 * `JSON.parse` has no date type, so a `Date` on one side is always a string on
 * the other; making that explicit stops the two drifting.
 */
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/** Two characters, letters or digits — e.g. `KL`, `U2`, `4Y`. */
export const AirlineIataCode = z
  .string()
  .regex(/^[A-Z0-9]{2}$/, 'must be 2 uppercase alphanumerics');
export type AirlineIataCode = z.infer<typeof AirlineIataCode>;

/** Three letters — e.g. `KLM`, `BAW`. */
export const AirlineIcaoCode = z.string().regex(/^[A-Z]{3}$/, 'must be 3 uppercase letters');
export type AirlineIcaoCode = z.infer<typeof AirlineIcaoCode>;

/** Three letters — e.g. `AMS`, `LHR`. */
export const AirportIataCode = z.string().regex(/^[A-Z]{3}$/, 'must be 3 uppercase letters');
export type AirportIataCode = z.infer<typeof AirportIataCode>;

/** Four letters — e.g. `EHAM`, `EGLL`. The stable key for an airport. */
export const AirportIcaoCode = z.string().regex(/^[A-Z]{4}$/, 'must be 4 uppercase letters');
export type AirportIcaoCode = z.infer<typeof AirportIcaoCode>;

/** ISO 3166-1 alpha-2 — e.g. `NL`, `GB`. */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code');
export type CountryCode = z.infer<typeof CountryCode>;

/**
 * The 0.00–1.00 reputation scale used consistently across the design doc
 * (§15, App. A.3, F.4, E.6). New airlines start at 0.35; the world median sits
 * near 0.50.
 *
 * Stored as `numeric(3,2)` and therefore read from Postgres as a *string*;
 * converting to a number is the server's job at the boundary, which is exactly
 * the sort of seam these schemas exist to make explicit.
 */
export const Reputation = z.number().min(0).max(1);
export type Reputation = z.infer<typeof Reputation>;

/**
 * Money, as an integer count of the currency's minor unit (cents).
 *
 * Never a float: currency arithmetic in binary floating point loses money in
 * ways that are painful to reconcile. JSON numbers are IEEE-754 doubles, so
 * integers are exact up to 2^53 − 1 — about 90 trillion minor units, far beyond
 * any plausible balance. Bounded explicitly so a value that would silently lose
 * precision is rejected rather than rounded.
 *
 * *Which* currency is still open: §24 lists it as design debt and M8-02
 * resolves it. Nothing here assumes one.
 */
export const MinorUnits = z
  .number()
  .int('money must be an integer number of minor units')
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export type MinorUnits = z.infer<typeof MinorUnits>;

export const Latitude = z.number().min(-90).max(90);
export type Latitude = z.infer<typeof Latitude>;

export const Longitude = z.number().min(-180).max(180);
export type Longitude = z.infer<typeof Longitude>;

/** Nautical miles. The doc uses nm for distance throughout App. B and C. */
export const NauticalMiles = z.number().nonnegative();
export type NauticalMiles = z.infer<typeof NauticalMiles>;

/** Minutes past midnight, 0–1439. Used for curfews and departure times. */
export const MinuteOfDay = z.number().int().min(0).max(1439);
export type MinuteOfDay = z.infer<typeof MinuteOfDay>;

/** 1 = Monday … 7 = Sunday (ISO 8601 weekday numbering). */
export const IsoWeekday = z.number().int().min(1).max(7);
export type IsoWeekday = z.infer<typeof IsoWeekday>;

/**
 * Cabin classes (§6.2). `premium_economy` is spelled out rather than
 * abbreviated so it never collides with `economy` in a prefix match.
 */
/**
 * App. A.2's three passenger segments.
 *
 * *"The split is what makes different strategies viable."* Each wants something
 * different and ignores something different — business buys frequency and
 * ignores price, leisure buys price and ignores everything else, VFR buys price
 * but is sticky to a familiar carrier — so a route's mix decides which airline
 * can win it. A.3's utility model runs once per segment for that reason.
 *
 * Not to be confused with {@link CabinClass}. A business *traveller* often sits
 * in economy; the segment is why they are flying, the cabin is what they bought.
 */
export const DemandSegment = z.enum(['business', 'leisure', 'vfr']);
export type DemandSegment = z.infer<typeof DemandSegment>;

export const CabinClass = z.enum(['economy', 'premium_economy', 'business', 'first']);
export type CabinClass = z.infer<typeof CabinClass>;
