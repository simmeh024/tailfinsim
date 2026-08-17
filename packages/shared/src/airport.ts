import { z } from 'zod';

import {
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
 * **Provisional.** No `airport` table exists yet — M1-01 imports the
 * OurAirports dataset and M1-02/M1-03 add tiers and catchment. This is the wire
 * contract those milestones must satisfy, written from the design doc rather
 * than invented, so the reconciliation is a comparison rather than a
 * negotiation. Where the dataset cannot supply a field, it is nullable here.
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
  identifier: z.string().min(1).max(7),
  lengthFt: z.number().int().positive(),
  widthFt: z.number().int().positive().nullable(),
  surface: RunwaySurface,
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
  /** The stable key. IATA is absent for thousands of airports; ICAO is not. */
  icao: AirportIcaoCode,
  iata: AirportIataCode.nullable(),

  name: z.string().min(1),
  city: z.string().min(1).nullable(),
  country: CountryCode,
  region: z.string().nullable(),

  latitude: Latitude,
  longitude: Longitude,
  elevationFt: z.number().int(),
  /** IANA zone, e.g. `Europe/Amsterdam`. Needed for curfews and local departure times. */
  timezone: z.string().min(1),

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
