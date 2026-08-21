import { z } from 'zod';

import { MinorUnits, NauticalMiles, Uuid } from './primitives';

/**
 * Aircraft types and individual airframes, following App. C.6's data model.
 *
 * M4-01 built the catalogue against this contract and M4-03 adds the options
 * configurator.
 *
 * The load-bearing idea from App. C.6, encoded here: **everything downstream
 * reads `effectiveSpec` and nothing special-cases options.** Reachability
 * (App. B.4), fuel burn, fees and demand all consume the computed spec, never
 * the base spec plus a pile of conditionals. That is what stops the options
 * system becoming unmaintainable, so `AircraftSpec` is deliberately one shape
 * used for both.
 */

export const AircraftSpec = z.object({
  /**
   * Maximum certified seats. A cabin config may fit fewer (§6.1).
   *
   * Zero for a freighter, which is a real answer rather than a missing one —
   * see `maxPayloadTonnes`.
   */
  maxSeats: z.number().int().nonnegative(),
  /**
   * Seats in the two-class layout App. C.2 quotes.
   *
   * C.2's "Seats" column is a range for most types — "162–189" — and the two
   * numbers mean different things: the lower is what a normal airline actually
   * fits, the upper is what the certificate allows. Both are needed, because
   * §6.1's cabin builder works between them and A.6's allocation cares about
   * the seats on offer rather than the ones that would fit.
   *
   * Zero for a freighter.
   */
  seatsTwoClass: z.number().int().nonnegative(),
  /**
   * Structural payload limit in tonnes.
   *
   * The number C.2 puts in the Seats column for freighters — "102 t payload".
   * Carried for every type, because §12's belly cargo needs it on passenger
   * aircraft too.
   */
  maxPayloadTonnes: z.number().positive(),
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
export const AircraftRestriction = z.object({
  /** The in-game date the restriction begins. */
  at: z.iso.date(),
  /** What tightens. §7.2b: *"noise quota bans, emissions charges, curfew exclusions"*. */
  kind: z.enum(['noise_quota', 'emissions_charge', 'curfew_exclusion']),
  /** One sentence, so a player told their fleet is restricted can be told why. */
  note: z.string().min(1),
});
export type AircraftRestriction = z.infer<typeof AircraftRestriction>;

export const AircraftEraDates = z.object({
  firstFlight: z.iso.date().nullable(),
  /** Orderable by everyone from this date. `null` = announced but not yet certified. */
  entryIntoService: z.iso.date().nullable(),
  /** No new-build after this date; used market only. */
  productionEnd: z.iso.date().nullable(),
  /** Hard date — the type may no longer be operated at all. */
  outOfService: z.iso.date().nullable(),
  /**
   * Progressive restrictions, in date order (§7.2b).
   *
   * *"Retirement pressure is real too: noise regulations, emissions rules, and
   * fuel price shocks progressively strangle old types rather than deleting
   * them. Your beloved fleet becomes uneconomic before it becomes illegal."*
   * That is why these are separate from `outOfService` — the hard date is the
   * end, and these are the squeeze before it.
   */
  restrictionDates: z.array(AircraftRestriction).default([]),
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

  /**
   * Which maintenance programme this type follows (§7.3, M4-06).
   *
   * An identifier, not a schedule. §7.3 is two bullets and gives no intervals,
   * so the catalogue says *which* programme a type is on and M4-06 decides what
   * that means. Inventing eighteen sets of check intervals here would be
   * authoring data the design doc does not have, and doing it in the milestone
   * that does not own the subject.
   */
  maintenanceProfile: z.enum(['turboprop', 'regional_jet', 'narrowbody', 'widebody', 'freighter']),

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
