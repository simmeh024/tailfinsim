import { z } from 'zod';

import { AircraftClass, AircraftSpec, WingspanCode } from './aircraft';
import { AircraftAcquisitionKind } from './aircraft-acquisition';
import { AircraftOptionCategory, CatalogueOption } from './aircraft-options';
import { AirframeStatus, MaintenanceAirframeView, MaintenanceTierView } from './maintenance';
import { RepeatPattern } from './network';
import { AirportIcaoCode, MinorUnits, MinuteOfDay, Timestamp, Uuid } from './primitives';

/**
 * The fleet a player actually owns (M4-07, App. C.6).
 *
 * `aircraft-catalogue.ts` is what a world *offers*; this is what an airline
 * *has*. Two views of it, because they answer different questions:
 *
 *   - **the list** — *"which of my aeroplanes needs a decision?"* Registration,
 *     type, where it is, whether it can fly, what it is doing with its time and
 *     what is due.
 *   - **the detail** — *"why is this aeroplane like this?"* The effective spec
 *     taken apart option by option, what it is assigned to, and where it has
 *     been.
 *
 * ## Nothing here is computed by the client
 *
 * Availability, maintenance and location are all the server's, for the reason
 * §21 gives and lint enforces: `packages/web` may not import `@tailfin/sim`, so
 * it could not re-derive an effective spec even by accident. What crosses the
 * wire is the answer, plus enough of the working to check it.
 */

/**
 * The numeric axes of `AircraftSpec`.
 *
 * The one list, defined here because it crosses the wire, and imported by
 * `@tailfin/sim`'s decomposition rather than restated there. `wingspanCode` is
 * absent deliberately — it is a letter, and moves along a scale rather than by a
 * difference, so it is reported as {@link SpecWingspanMovement}. `fleet.test.ts`
 * asserts that this list plus that one exception is exactly `AircraftSpec`, so a
 * new specification field cannot arrive without a decomposition.
 */
export const SpecAxis = z.enum([
  'maxSeats',
  'seatsTwoClass',
  'maxPayloadTonnes',
  'rangeNm',
  'cruiseSpeedKt',
  'mtowTonnes',
  'oewTonnes',
  'runwayRequirementM',
  'fuelBurnKgPerHour',
  'noiseChapter',
  'turnaroundBaselineMin',
]);
export type SpecAxis = z.infer<typeof SpecAxis>;

/**
 * The numeric charges App. C.3 makes that no specification field carries.
 *
 * Reported next to the spec because most options spend here. A lightweight cabin
 * shown as *"−1.8 t OEW"* and nothing else has hidden the comfort charge that is
 * the whole trade.
 */
export const CapabilityAxis = z.enum([
  'cargoVolumeFactor',
  'comfortDelta',
  'maintenanceCostFactor',
  'lowVisibilityCancellationFactor',
  'etopsMinutes',
]);
export type CapabilityAxis = z.infer<typeof CapabilityAxis>;

/** A capability an option switches on. Nothing in C.3 switches one off. */
export const BuildCapability = z.enum(['ulhCapable', 'unpavedCapable']);
export type BuildCapability = z.infer<typeof BuildCapability>;

export const SpecMovement = z
  .object({
    axis: SpecAxis,
    before: z.number(),
    after: z.number(),
  })
  .strict();
export type SpecMovement = z.infer<typeof SpecMovement>;

export const SpecWingspanMovement = z
  .object({ before: WingspanCode, after: WingspanCode })
  .strict();
export type SpecWingspanMovement = z.infer<typeof SpecWingspanMovement>;

/** `null` on either side is *"no ETOPS approval"*, which is not zero minutes. */
export const CapabilityMovement = z
  .object({
    axis: CapabilityAxis,
    before: z.number().nullable(),
    after: z.number().nullable(),
  })
  .strict();
export type CapabilityMovement = z.infer<typeof CapabilityMovement>;

/**
 * One contribution to an effective spec.
 *
 * M4-07's first acceptance criterion in one shape: *"effective spec shows base
 * value and delta per option, not just the total"*. `spec` is the running spec
 * after this step — a fold the engine really performed — so `base` plus every
 * step's `after − before` is the effective spec exactly, on every axis. See
 * `spec-decomposition.ts` for why that has to be a prefix fold rather than a
 * printed `specDeltas`.
 */
export const BuildStepView = z
  .object({
    /** The option that made this step, or `null` for the cabin fitted (§6.1). */
    optionId: z.string().min(1).nullable(),
    /** Words rather than an id, because this is a readout a player reasons with. */
    label: z.string().min(1),
    category: AircraftOptionCategory.nullable(),
    /** One sentence, App. C.3's own. Null for the cabin, which has no C.3 row. */
    summary: z.string().min(1).nullable(),
    spec: AircraftSpec,
    /** Only the axes this step moved. An option that moved none is still a step. */
    movements: z.array(SpecMovement),
    wingspan: SpecWingspanMovement.nullable(),
    capabilityMovements: z.array(CapabilityMovement),
    capabilitiesGained: z.array(BuildCapability),
    /** Added to the price, in minor units. Zero for the cabin. */
    priceMinor: MinorUnits,
    /** Weeks added to delivery. C.3 rule 2. Zero for the cabin. */
    leadTimeWeeks: z.number().int().nonnegative(),
  })
  .strict();
export type BuildStepView = z.infer<typeof BuildStepView>;

/** The capability totals a build ends on — App. C.4's bottom row. */
export const BuildCapabilities = z
  .object({
    cargoVolumeFactor: z.number().nonnegative(),
    comfortDelta: z.number(),
    maintenanceCostFactor: z.number().positive(),
    lowVisibilityCancellationFactor: z.number().positive(),
    /** Certified diversion minutes, or `null` for the default 60-minute rule. */
    etopsMinutes: z.number().positive().nullable(),
    ulhCapable: z.boolean(),
    unpavedCapable: z.boolean(),
  })
  .strict();
export type BuildCapabilities = z.infer<typeof BuildCapabilities>;

export const EffectiveSpecView = z
  .object({
    /** The type's published base spec, before the cabin and before any option. */
    base: AircraftSpec,
    /** In the order the engine folded them: cabin first if any, then options by id. */
    steps: z.array(BuildStepView),
    /** The total — the `effective_spec` every other system reads (App. C.6). */
    effective: AircraftSpec,
    capabilities: BuildCapabilities,
    /** List price plus every option. Zero for a type the catalogue does not price. */
    priceMinor: MinorUnits,
    leadTimeWeeks: z.number().int().nonnegative(),
  })
  .strict();
export type EffectiveSpecView = z.infer<typeof EffectiveSpecView>;

/**
 * How hard this aeroplane is working — block hours a day (§11's fleet panel).
 *
 * The window and the hours are both carried, not just the rate, because a rate
 * on its own is a number a player cannot check. §2488's onboarding warning
 * *"you aren't using the three you have"* is only actionable if *"6 block hours a
 * day"* can be traced to the flights that produced it.
 *
 * Flown, not planned. What a schedule *intends* is in `assignments`; this is what
 * the aeroplane did.
 */
export const FleetUtilisation = z
  .object({
    /** Trailing game days measured. Shorter than the full window for a new arrival. */
    windowDays: z.number().positive(),
    /** Block hours flown in that window. */
    blockHours: z.number().nonnegative(),
    blockHoursPerDay: z.number().nonnegative(),
  })
  .strict();
export type FleetUtilisation = z.infer<typeof FleetUtilisation>;

/**
 * One row of the fleet table.
 *
 * The task's column list — *"registration, type, livery thumbnail, base, status,
 * hours, utilisation, next check"* — with one substitution, stated rather than
 * smuggled: **`locationIcao` is where the aeroplane is, not a base it is assigned
 * to.** Tailfin has no aircraft base. §9.2's base is a *crew* base and §17 makes
 * it an unlockable hub facility, neither of which is built, and `positioning.ts`
 * is explicit that an aircraft's position is derived from its flights and must
 * never be stored. Inventing an assignable base column would be inventing a
 * mechanic — and a column that affected nothing would be a dead end (invariant
 * 4). Where it *is* answers the same operational question today.
 */
export const FleetAirframeView = z
  .object({
    airframeId: Uuid,
    registration: z.string().min(1),

    typeDesignation: z.string().min(1),
    family: z.string().min(1),
    manufacturer: z.string().min(1),
    aircraftClass: AircraftClass,

    /**
     * The livery sprite for this airframe, rendered **server-side**.
     *
     * Always `null` today, and that is the honest answer rather than a stub: a
     * livery is an M6-01 layered document rendered to a cached raster by M6-06.
     * The contract now exists, but saved documents and that renderer do not —
     * nothing writes `airframe.livery_id`. The field is here
     * so the client renders a URL the server decided rather than composing a
     * livery itself, which is M4-07's second acceptance criterion as a property
     * of the contract instead of a convention. M6-06 fills it and the client does
     * not change.
     */
    liveryId: Uuid.nullable(),
    liveryThumbnailUrl: z.string().min(1).nullable(),

    /**
     * Where it is now, folded from its flights.
     *
     * `null` when nothing is known — no delivery airport and nothing flown. An
     * absence rather than a guess, because a guessed position lets a rotation
     * validate against an airport the aeroplane has never seen.
     */
    locationIcao: AirportIcaoCode.nullable(),

    status: AirframeStatus,
    /** The tier being worked, when `status` is `in_check`. */
    checkTier: MaintenanceTierView.shape.tier.nullable(),
    checkCompletesAt: Timestamp.nullable(),
    airworthy: z.boolean(),
    /** M2-08's `DisruptionRisk.technical`, which M4-06 moves. */
    technicalRisk: z.number().min(0).max(1),

    ownership: z.enum(['owned', 'leased', 'financed']),
    hours: z.number().nonnegative(),
    cycles: z.number().int().nonnegative(),
    /**
     * Airframe age in years, from its build date.
     *
     * `null` for an airframe with no `built_at` — every one delivered before
     * M4-05 added the column. Not silently the delivery date: a used aeroplane
     * bought at twelve years old would then read as new, which is the one thing
     * age is for.
     */
    ageYears: z.number().nonnegative().nullable(),

    utilisation: FleetUtilisation.nullable(),
    /** The tier falling due soonest. Null only for a fleet with no programme. */
    nextCheck: MaintenanceTierView.nullable(),
    /** Active schedules flying this airframe. The detail view names them. */
    activeScheduleCount: z.number().int().nonnegative(),
  })
  .strict();
export type FleetAirframeView = z.infer<typeof FleetAirframeView>;

export const FleetAirframesResponse = z
  .object({
    /** Most urgent first: cannot fly, then due, then closest to due. */
    airframes: z.array(FleetAirframeView),
  })
  .strict();
export type FleetAirframesResponse = z.infer<typeof FleetAirframesResponse>;

/** One leg of a rotation this airframe is assigned to (§8.2). */
export const AirframeAssignmentLeg = z
  .object({
    legIndex: z.number().int().nonnegative(),
    originIcao: AirportIcaoCode,
    destinationIcao: AirportIcaoCode,
    /** Minutes past midnight, local to the origin (see `ScheduleLeg`). */
    departureMinute: MinuteOfDay,
    blockMinutes: z.number().int().positive(),
    turnaroundMinutes: z.number().int().nonnegative(),
  })
  .strict();
export type AirframeAssignmentLeg = z.infer<typeof AirframeAssignmentLeg>;

export const AirframeAssignment = z
  .object({
    scheduleId: Uuid,
    /** A paused schedule keeps its legs and stops producing flights. */
    active: z.boolean(),
    /** §8.2's own pattern, not a second spelling of it. */
    repeat: RepeatPattern,
    legs: z.array(AirframeAssignmentLeg),
    /** The pattern's own block time, so a plan can be compared with what flew. */
    dailyBlockMinutes: z.number().int().nonnegative(),
  })
  .strict();
export type AirframeAssignment = z.infer<typeof AirframeAssignment>;

/** App. C.6's `owner_history[]` — the history that follows a used airframe. */
export const AirframeOwnerHistoryEntry = z
  .object({
    ownerLabel: z.string().min(1),
    acquiredAt: Timestamp,
    releasedAt: Timestamp.nullable(),
  })
  .strict();
export type AirframeOwnerHistoryEntry = z.infer<typeof AirframeOwnerHistoryEntry>;

export const AirframeProvenance = z
  .object({
    /** When the airframe was built. Null before M4-05 added the column. */
    builtAt: Timestamp.nullable(),
    /** Real time: factory lead times are wall-clock weeks (§7.2). */
    deliveredAt: Timestamp,
    deliveredToIcao: AirportIcaoCode,
    /** How it was acquired — new, leased or bought used (M4-04). */
    acquisitionKind: AircraftAcquisitionKind,
    ownerHistory: z.array(AirframeOwnerHistoryEntry),
  })
  .strict();
export type AirframeProvenance = z.infer<typeof AirframeProvenance>;

export const AirframeDetailResponse = z
  .object({
    airframe: FleetAirframeView,
    spec: EffectiveSpecView,
    /**
     * The options fitted, as rows.
     *
     * Sent alongside the decomposition rather than folded into it because a step
     * is *what an option did to this aeroplane* and an option row is *what it is*
     * — the same distinction the catalogue draws, and the client joins them on
     * `optionId`.
     */
    options: z.array(CatalogueOption),
    /**
     * The cabin fitted, or `null`.
     *
     * The id only, and always `null` today: §6.1's cabin builder is M6's, so
     * nothing writes `airframe.cabin_config_id` yet. Reported rather than
     * omitted because "no cabin fitted" is a real state a player should be able
     * to see, and the decomposition already handles a cabin the moment one
     * exists.
     */
    cabinConfigId: Uuid.nullable(),
    assignments: z.array(AirframeAssignment),
    /** The full check position, the same shape `/api/fleet/maintenance` returns. */
    maintenance: MaintenanceAirframeView,
    provenance: AirframeProvenance,
  })
  .strict();
export type AirframeDetailResponse = z.infer<typeof AirframeDetailResponse>;
