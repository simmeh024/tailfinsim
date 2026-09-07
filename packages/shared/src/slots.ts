import { z } from 'zod';

import { Uuid } from './primitives';

/**
 * Airport slots (M7-05, §"Slots").
 *
 * A coordinated (IATA Level 3) airport's day is 24 hourly **bands**, and an
 * airline holds a band to be allowed to schedule departures in it. This is the
 * client's view of one airport's slot picture: how full each band is, and which
 * ones you hold. Uncoordinated airports carry no bands — `coordinated` is false
 * and scheduling there is free.
 */

/**
 * How contested an hour is (M7-05).
 *
 * A coordinated airport is not equally scarce all day. The client needs this to
 * explain *why* 03:00 is obtainable and 08:00 is not, which is the difference
 * between a grid that teaches and a grid that just refuses.
 */
export const SlotBandShape = z.enum(['peak', 'shoulder', 'off_peak']);
export type SlotBandShape = z.infer<typeof SlotBandShape>;

/**
 * One airline holding one band.
 *
 * Named rather than counted, because slots are *"the scarce resource of the
 * shared world"* (§8.1) and a scarce resource you cannot attribute is just a
 * closed door. Identity only — name and codes are already public on every
 * competing airline; nothing commercial is disclosed.
 */
export const SlotHolder = z.object({
  airlineId: Uuid,
  name: z.string().min(1),
  iataCode: z.string().nullable(),
  /** True for the airline asking. Saves the client a comparison it would get wrong once. */
  isYou: z.boolean(),
});
export type SlotHolder = z.infer<typeof SlotHolder>;

/** One hour of a coordinated airport's day, and where it stands for you. */
export const AirportSlotBand = z.object({
  /** The hour, 0–23. */
  band: z.number().int().min(0).max(23),
  /**
   * How many airlines may hold this band **once every release wave has landed**.
   *
   * The eventual ceiling, not today's. `released` is what can be claimed now.
   */
  capacity: z.number().int().nonnegative(),
  /**
   * How many of `capacity` are open today (§21's release waves).
   *
   * Lower than `capacity` in a young world. It can also be lower than `held` in a
   * world whose slots were claimed before the waves existed — a wave only ever
   * adds, and no holding is ever revoked.
   */
  released: z.number().int().nonnegative(),
  /** How contested this hour is, and therefore why it is easy or impossible. */
  shape: SlotBandShape,
  /** How many hold it now, you included. */
  held: z.number().int().nonnegative(),
  /** Whether you are one of them. */
  heldByYou: z.boolean(),
  /** Free slots left: `max(released − held, 0)`. */
  available: z.number().int().nonnegative(),
  /** Who holds it. Every airline in the world, not only you. */
  holders: z.array(SlotHolder),
});
export type AirportSlotBand = z.infer<typeof AirportSlotBand>;

/**
 * When the rest of this airport's capacity opens (§21, open question 3).
 *
 * Published rather than merely documented: *"first-come-first-served creates a
 * permanent land grab"* is only answered if a player can see that waiting is not
 * futile. A newcomer who can read "60% released, the rest on game day 90" knows
 * the board is not already carved up.
 */
export const SlotReleaseSchedule = z.object({
  /** Game days since the world's epoch. */
  worldAgeGameDays: z.number().int().nonnegative(),
  /** Cumulative fraction of every band's capacity open today, 0–1. */
  releasedFraction: z.number().min(0).max(1),
  /** The next wave, or null once the last has landed. */
  nextWaveAtGameDay: z.number().int().nonnegative().nullable(),
  nextWaveFraction: z.number().min(0).max(1).nullable(),
  /** Game days until it opens, or null when there is nothing left to come. */
  nextWaveInGameDays: z.number().int().nonnegative().nullable(),
});
export type SlotReleaseSchedule = z.infer<typeof SlotReleaseSchedule>;

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
  /** Null at an uncoordinated airport, where nothing is released because nothing is scarce. */
  releases: SlotReleaseSchedule.nullable(),
});
export type AirportSlotsResponse = z.infer<typeof AirportSlotsResponse>;

/** Why claiming a slot was refused (M7-05). */
export const SlotClaimProblem = z.enum(['not_coordinated', 'band_full', 'invalid_band']);
export type SlotClaimProblem = z.infer<typeof SlotClaimProblem>;
