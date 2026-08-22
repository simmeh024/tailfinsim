import { z } from 'zod';

import { MaintenanceProfile } from './aircraft';
import { MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * Maintenance, as a player sees it (M4-06, §7.3).
 *
 * The contract exists to answer one question well: **what do I have to do about
 * my fleet, and when.** §7.3's first bullet is *"flight hours and cycles
 * accumulate; A/C/D-check tiers with escalating downtime"*, and this is the
 * readout of that — remaining hours *and* remaining cycles per tier, plus which
 * of the two is actually binding, because *"210 cycles from an A-check"* is a
 * plan and *"an A-check soonish"* is not.
 */

/** §7.3's three tiers. */
export const CheckTier = z.enum(['a', 'c', 'd']);
export type CheckTier = z.infer<typeof CheckTier>;

/** Whether the aeroplane can fly, and why not (M4-06). */
export const AirframeStatus = z.enum(['in_service', 'in_check', 'grounded']);
export type AirframeStatus = z.infer<typeof AirframeStatus>;

export const MaintenanceTierView = z
  .object({
    tier: CheckTier,
    /** Negative once overdue, which is how the UI can show "180 hours over". */
    hoursRemaining: z.number(),
    cyclesRemaining: z.number(),
    /**
     * Which limit will fall first, and therefore the one to quote.
     *
     * The difference between types: a turboprop flying short sectors runs out of
     * cycles, a long-haul widebody runs out of hours.
     */
    binding: z.enum(['hours', 'cycles']),
    /** `0` fresh, `1` at the limit, above `1` overdue. */
    usedFraction: z.number().nonnegative(),
    due: z.boolean(),
    costMinor: MinorUnits.nonnegative(),
    downtimeDays: z.number().positive(),
  })
  .strict();
export type MaintenanceTierView = z.infer<typeof MaintenanceTierView>;

export const MaintenanceAirframeView = z
  .object({
    airframeId: Uuid,
    registration: z.string().min(1),
    typeDesignation: z.string().min(1),
    maintenanceProfile: MaintenanceProfile,
    status: AirframeStatus,
    /** The tier being worked, when one is. */
    checkTier: CheckTier.nullable(),
    /** Game-time instant the running check finishes. */
    checkCompletesAt: Timestamp.nullable(),
    totalHours: z.number().nonnegative(),
    totalCycles: z.number().int().nonnegative(),
    /**
     * The technical-fault probability this airframe carries into a flight.
     *
     * Shown rather than hidden, because §7.3's second bullet is a *consequence*
     * chain — *"skipped maintenance → reliability decay → delays and
     * cancellations → reputation damage"* — and a player who cannot see the
     * middle link experiences the last one as bad luck. This is the number
     * M2-08's `DisruptionRisk.technical` is fed.
     */
    technicalRisk: z.number().min(0).max(1),
    airworthy: z.boolean(),
    /** Tiers due or overdue, heaviest first — the order to do them in. */
    dueTiers: z.array(CheckTier),
    tiers: z.array(MaintenanceTierView),
  })
  .strict();
export type MaintenanceAirframeView = z.infer<typeof MaintenanceAirframeView>;

export const MaintenanceResponse = z
  .object({
    /** Most urgent first: grounded, then due, then closest to due. */
    airframes: z.array(MaintenanceAirframeView),
  })
  .strict();
export type MaintenanceResponse = z.infer<typeof MaintenanceResponse>;

/** Book a check. The tier is the player's choice; everything else is the server's. */
export const BookCheckInput = z
  .object({
    airframeId: Uuid,
    tier: CheckTier,
  })
  .strict();
export type BookCheckInput = z.infer<typeof BookCheckInput>;

export const BookCheckResponse = z
  .object({
    airframeId: Uuid,
    tier: CheckTier,
    costMinor: MinorUnits.nonnegative(),
    /** Game-time instant the aeroplane returns to service. */
    completesAt: Timestamp,
  })
  .strict();
export type BookCheckResponse = z.infer<typeof BookCheckResponse>;
