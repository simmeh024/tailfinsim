import { z } from 'zod';

import { MinorUnits, NauticalMiles, Uuid } from './primitives';

/**
 * Aircraft types and individual airframes, following App. C.6's data model.
 *
 * **Provisional.** M4-01 builds the catalogue and M4-03 the options
 * configurator; this is the wire contract they must satisfy.
 *
 * The load-bearing idea from App. C.6, encoded here: **everything downstream
 * reads `effectiveSpec` and nothing special-cases options.** Reachability
 * (App. B.4), fuel burn, fees and demand all consume the computed spec, never
 * the base spec plus a pile of conditionals. That is what stops the options
 * system becoming unmaintainable, so `AircraftSpec` is deliberately one shape
 * used for both.
 */

export const AircraftSpec = z.object({
  /** Maximum certified seats. A cabin config may fit fewer (§6.1). */
  maxSeats: z.number().int().positive(),
  rangeNm: NauticalMiles,
  cruiseSpeedKt: z.number().positive(),
  mtowTonnes: z.number().positive(),
  /** Operating empty weight — the other half of the belly-cargo payload sum (§12.1). */
  oewTonnes: z.number().positive(),
  /** Required takeoff length at MTOW, sea level, ISA. App. B.4 adjusts for payload and elevation. */
  runwayRequirementM: z.number().int().positive(),
  fuelBurnKgPerHour: z.number().positive(),
  /** ICAO aerodrome reference code letter, matched against an airport's `maxWingspanCode`. */
  wingspanCode: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
  /** ICAO Chapter number. Higher is quieter; drives noise-quota exclusion (§7.2b). */
  noiseChapter: z.number().int().positive(),
  /** Baseline minutes on stand before cabin config and ground handling adjust it (§8.2). */
  turnaroundBaselineMin: z.number().int().positive(),
});
export type AircraftSpec = z.infer<typeof AircraftSpec>;

/**
 * The four dates that gate a type's existence (§7.2b). An aircraft simply does
 * not exist in a world whose clock has not reached it.
 */
export const AircraftEraDates = z.object({
  firstFlight: z.iso.date().nullable(),
  /** Orderable by everyone from this date. `null` = announced but not yet certified. */
  entryIntoService: z.iso.date().nullable(),
  /** No new-build after this date; used market only. */
  productionEnd: z.iso.date().nullable(),
  /** Hard date — the type may no longer be operated at all. */
  outOfService: z.iso.date().nullable(),
});
export type AircraftEraDates = z.infer<typeof AircraftEraDates>;

export const AircraftClass = z.enum([
  'turboprop_regional',
  'regional_jet',
  'narrowbody',
  'widebody',
  'widebody_ulh',
  'freighter',
]);
export type AircraftClass = z.infer<typeof AircraftClass>;

export const AircraftType = z.object({
  /** e.g. `A321neo`, `ATR 72-600`. The catalogue key. */
  designation: z.string().min(1),
  /** Crew type ratings are per family, not per type — the teeth behind fleet commonality (§9.2). */
  family: z.string().min(1),
  manufacturer: z.string().min(1),
  class: AircraftClass,

  baseSpec: AircraftSpec,
  eraDates: AircraftEraDates,

  /** `null` when a type is used-market only — the doc shows this as "—" (App. C.2). */
  listPrice: MinorUnits.nullable(),
  monthlyLeaseRate: MinorUnits.nullable(),

  availableOptionIds: z.array(z.string()).default([]),
});
export type AircraftType = z.infer<typeof AircraftType>;

/**
 * One physical aircraft.
 *
 * App. C.6's point is that an airframe is "an individual object with a history,
 * rather than an interchangeable unit of capacity" — hence the registration,
 * hours, cycles and build config living here rather than on the type.
 */
export const Airframe = z.object({
  id: Uuid,
  worldId: Uuid,
  airlineId: Uuid,

  typeDesignation: z.string().min(1),
  /** Player-defined prefix, auto-incremented per airframe (§5.2), e.g. `PH-TFA`. */
  registration: z.string().min(2).max(10),

  buildOptionIds: z.array(z.string()).default([]),
  cabinConfigId: Uuid.nullable(),
  liveryId: Uuid.nullable(),

  /**
   * Base spec plus option deltas plus cabin weight, recomputed on any change.
   * Everything downstream reads only this (App. C.6).
   */
  effectiveSpec: AircraftSpec,

  hours: z.number().nonnegative(),
  cycles: z.number().int().nonnegative(),

  ownership: z.enum(['owned', 'leased', 'financed']),
});
export type Airframe = z.infer<typeof Airframe>;
