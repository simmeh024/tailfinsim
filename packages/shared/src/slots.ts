import { z } from 'zod';

/**
 * Airport slots (M7-05, §"Slots").
 *
 * A coordinated (IATA Level 3) airport's day is 24 hourly **bands**, and an
 * airline holds a band to be allowed to schedule departures in it. This is the
 * client's view of one airport's slot picture: how full each band is, and which
 * ones you hold. Uncoordinated airports carry no bands — `coordinated` is false
 * and scheduling there is free.
 */

/** One hour of a coordinated airport's day, and where it stands for you. */
export const AirportSlotBand = z.object({
  /** The hour, 0–23. */
  band: z.number().int().min(0).max(23),
  /** How many airlines may hold this band. */
  capacity: z.number().int().nonnegative(),
  /** How many hold it now, you included. */
  held: z.number().int().nonnegative(),
  /** Whether you are one of them. */
  heldByYou: z.boolean(),
  /** Free slots left: `max(capacity − held, 0)`. */
  available: z.number().int().nonnegative(),
});
export type AirportSlotBand = z.infer<typeof AirportSlotBand>;

/**
 * `GET /api/airports/:icao/slots` — one airport's slot picture for you.
 *
 * `bands` is empty at an uncoordinated airport, where nothing is scarce and a
 * schedule needs no slot; the client shows that as "no coordination" rather than
 * as an empty grid.
 */
export const AirportSlotsResponse = z.object({
  icao: z.string().min(1),
  name: z.string(),
  /** True at an IATA Level 3 airport — the only level a held slot is required at. */
  coordinated: z.boolean(),
  /** The IATA designation: 1 free, 2 schedules-facilitated, 3 coordinated, null uncoordinated. */
  slotLevel: z.number().int().nullable(),
  bands: z.array(AirportSlotBand),
});
export type AirportSlotsResponse = z.infer<typeof AirportSlotsResponse>;

/** Why claiming a slot was refused (M7-05). */
export const SlotClaimProblem = z.enum(['not_coordinated', 'band_full', 'invalid_band']);
export type SlotClaimProblem = z.infer<typeof SlotClaimProblem>;
