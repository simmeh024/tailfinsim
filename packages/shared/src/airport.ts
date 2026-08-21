import { z } from 'zod';

import {
  AirportIdent,
  AirportIataCode,
  AirportIcaoCode,
  CountryCode,
  Latitude,
  Longitude,
  MinorUnits,
  MinuteOfDay,
} from './primitives';

/**
 * An airport, following the record in App. B.2 field for field.
 *
 * **Partly provisional.** M1-01 imported the OurAirports dataset, M1-02 added
 * `tier`/`slotLevel`, and M1-03 added catchment. `capacity`, exact `fees`,
 * `curfew` and `constraints` still have no table columns. Consumers that need
 * the implemented subset use `AirportSummary` or a narrower purpose-built
 * contract rather than pretending the complete App. B.2 record exists.
 *
 * ## What M1-01 changed, and why
 *
 * Four fields were written non-nullable from the design doc and turned out to be
 * unfillable. Counts are from the 2026-08-17 dataset, 85,915 airports:
 *
 *   - **`icao` is nullable, and is not the key.** The original comment here read
 *     "IATA is absent for thousands of airports; ICAO is not". The reverse is
 *     closer to the truth: only **10,444** rows carry an official ICAO code,
 *     against 9,052 with IATA. The universal identifier is OurAirports' own
 *     `ident` — present, unique and non-blank on every row — which is an ICAO
 *     code where one exists and a national or synthetic code otherwise. App. B.1
 *     says "everything with an ICAO code"; taken literally that would discard 88%
 *     of the world's aerodromes, so it is read as "everything with an
 *     identifier".
 *   - **`elevationFt` is nullable.** 14,905 rows have no elevation. It is an
 *     input to the takeoff-length check in B.4, so a missing value must read as
 *     "unknown" rather than as sea level.
 *   - **`timezone` is nullable.** OurAirports has no timezone column at all.
 *     Curfews (B.2) and local departure times need it, so it will have to come
 *     from a lat/lon lookup against the IANA database — a separate piece of work,
 *     and one nothing depends on yet.
 *   - **`Runway.lengthFt` is nullable.** 292 runway rows have no length and 6
 *     are zero or negative. A runway of unknown length cannot be assumed usable.
 */

/** IATA slot designation. Level 3 is the scarce, contested case (§8.1, App. B.3). */
export const SlotLevel = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type SlotLevel = z.infer<typeof SlotLevel>;

export const AirportTier = z.enum(['flagship', 'large', 'medium', 'small', 'regional']);
export type AirportTier = z.infer<typeof AirportTier>;

export const RunwaySurface = z.enum(['asphalt', 'concrete', 'gravel', 'grass', 'water', 'other']);
export type RunwaySurface = z.infer<typeof RunwaySurface>;

/** ILS precision category. `null` means no instrument approach. */
export const IlsCategory = z.enum(['I', 'II', 'IIIa', 'IIIb', 'IIIc']).nullable();
export type IlsCategory = z.infer<typeof IlsCategory>;

export const Runway = z.object({
  identifier: z.string().min(1).max(16),
  /** Null where the source has no length. Unknown is not the same as unusable — but it is not usable either. */
  lengthFt: z.number().int().positive().nullable(),
  widthFt: z.number().int().positive().nullable(),
  surface: RunwaySurface,
  /** OurAirports carries no ILS data, so this is null for every imported runway. */
  ilsCategory: IlsCategory,
});
export type Runway = z.infer<typeof Runway>;

/** Feeds the gravity model in App. A.2 — the only reason catchment exists. */
export const Catchment = z.object({
  population: z.number().int().nonnegative(),
  wealthIndex: z.number().nonnegative(),
  tourismIndex: z.number().nonnegative(),
  businessIndex: z.number().nonnegative(),
});
export type Catchment = z.infer<typeof Catchment>;

export const AirportCapacity = z.object({
  movementsPerHour: z.number().int().positive(),
  contactGates: z.number().int().nonnegative(),
  remoteStands: z.number().int().nonnegative(),
  cargoStands: z.number().int().nonnegative(),
});
export type AirportCapacity = z.infer<typeof AirportCapacity>;

export const AirportFees = z.object({
  landingPerTonne: MinorUnits,
  paxFee: MinorUnits,
  parkingPerHour: MinorUnits,
  gateLeaseAnnual: MinorUnits,
});
export type AirportFees = z.infer<typeof AirportFees>;

/**
 * A curfew that crosses midnight is the normal case, not the exception — 23:00
 * to 06:00 is typical. So `start` may be greater than `end` and consumers must
 * handle the wrap. Stated here because getting it wrong silently permits
 * overnight departures at noise-restricted airports (§8.2).
 */
export const Curfew = z.object({
  startMinute: MinuteOfDay,
  endMinute: MinuteOfDay,
  /** Free-form for now; §18 event authoring will formalise exemptions. */
  exemptions: z.array(z.string()).default([]),
});
export type Curfew = z.infer<typeof Curfew>;

export const AirportConstraints = z.object({
  /** ICAO aerodrome reference code letter A–F. */
  maxWingspanCode: z.enum(['A', 'B', 'C', 'D', 'E', 'F']).nullable(),
  noiseQuota: z.number().nonnegative().nullable(),
  customs: z.boolean(),
  fuelAvailable: z.boolean(),
});
export type AirportConstraints = z.infer<typeof AirportConstraints>;

export const Airport = z.object({
  /**
   * The stable key — OurAirports' `ident`. Unique and present on every row,
   * which is true of neither ICAO nor IATA.
   */
  ident: AirportIdent,
  /** Only ~12% of aerodromes have an officially assigned ICAO code. */
  icao: AirportIcaoCode.nullable(),
  iata: AirportIataCode.nullable(),

  name: z.string().min(1),
  city: z.string().min(1).nullable(),
  country: CountryCode,
  region: z.string().nullable(),

  latitude: Latitude,
  longitude: Longitude,
  /** Null means unknown, never sea level — it feeds the takeoff-length check in B.4. */
  elevationFt: z.number().int().nullable(),
  /** IANA zone, e.g. `Europe/Amsterdam`. Needed for curfews and local departure times, and not yet sourced. */
  timezone: z.string().min(1).nullable(),

  runways: z.array(Runway),
  tier: AirportTier,
  slotLevel: SlotLevel,

  catchment: Catchment,
  capacity: AirportCapacity,
  fees: AirportFees,
  curfew: Curfew.nullable(),
  constraints: AirportConstraints,

  /** Era gating (§7.2b applied to airports). `null` means "always"/"still open". */
  openedOn: z.iso.date().nullable(),
  closedOn: z.iso.date().nullable(),
});
export type Airport = z.infer<typeof Airport>;

/**
 * The subset the route picker and map need. App. B.1 loads every airport —
 * roughly 4,000 with scheduled service — so the list endpoint must not ship the
 * full record for each one.
 */
export const AirportSummary = Airport.pick({
  ident: true,
  icao: true,
  iata: true,
  name: true,
  city: true,
  country: true,
  latitude: true,
  longitude: true,
  tier: true,
});
export type AirportSummary = z.infer<typeof AirportSummary>;
