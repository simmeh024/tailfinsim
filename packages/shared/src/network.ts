import { z } from 'zod';

import {
  AirportIcaoCode,
  CabinClass,
  IsoWeekday,
  MinorUnits,
  MinuteOfDay,
  NauticalMiles,
  Timestamp,
  Uuid,
} from './primitives';

/**
 * Routes and schedules.
 *
 * **Provisional.** M2-01 builds the route entity and the seven reachability
 * checks; M2-03 builds the schedule and rotation model. This is the wire
 * contract from §8.1 and §8.2.
 */

/**
 * Per-class fares (§8.3). A record keyed by cabin class rather than four named
 * fields, so adding a class is not a schema change in five places — and
 * partial, because a route flown by an all-economy aircraft has no business
 * fare and should not be forced to invent one.
 */
export const FareTable = z.partialRecord(CabinClass, MinorUnits);
export type FareTable = z.infer<typeof FareTable>;

export const Route = z.object({
  id: Uuid,
  worldId: Uuid,
  airlineId: Uuid,

  originIcao: AirportIcaoCode,
  destinationIcao: AirportIcaoCode,

  /** Great-circle distance. App. B.4 applies a 1.06 factor for actual routing. */
  greatCircleNm: NauticalMiles,

  fares: FareTable,

  active: z.boolean(),
  createdAt: Timestamp,
});
export type Route = z.infer<typeof Route>;

/** Server-assigned fields omitted so a client cannot supply its own distance. */
export const CreateRouteInput = Route.pick({
  worldId: true,
  originIcao: true,
  destinationIcao: true,
  fares: true,
});
export type CreateRouteInput = z.infer<typeof CreateRouteInput>;

/**
 * Which of the seven reachability checks failed (App. B.4).
 *
 * The doc is explicit that the UI shows exactly which check failed and "never a
 * generic unavailable", so the failure reason is part of the contract rather
 * than a log line.
 */
export const ReachabilityCheck = z.enum([
  'range',
  'runway',
  'wingspan',
  'curfew',
  'slots',
  'traffic_rights',
  'fuel_availability',
]);
export type ReachabilityCheck = z.infer<typeof ReachabilityCheck>;

export const ReachabilityResult = z.object({
  reachable: z.boolean(),
  failures: z.array(
    z.object({
      check: ReachabilityCheck,
      /** Human-readable, and specific: "needs 2,300 m, longest runway is 1,890 m". */
      detail: z.string(),
    }),
  ),
});
export type ReachabilityResult = z.infer<typeof ReachabilityResult>;

/**
 * How often a rotation runs (§8.2).
 *
 * A discriminated union rather than the array-with-a-convention this used to be.
 * "An empty list means every day" reads fine in a schema and is a trap in a
 * product: a client bug that clears the array silently turns a Saturday-only
 * rotation into a daily one, and nothing anywhere can tell the difference
 * between "every day" and "the days were lost". `daily` says what it means.
 */
export const RepeatPattern = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily') }),
  z.object({ kind: z.literal('weekdays'), days: z.array(IsoWeekday).min(1).max(7) }),
]);
export type RepeatPattern = z.infer<typeof RepeatPattern>;

/**
 * One leg of a rotation.
 *
 * A leg names a `Route` rather than repeating its endpoints, so a fare change
 * reaches every rotation that flies it and no schedule can drift out of step
 * with the route it is supposed to serve.
 *
 * `departureMinuteLocal` is local to the origin airport, not UTC, because
 * curfews and passengers' schedule preferences (App. A.3's `SchedFit` term) are
 * both local concepts.
 *
 * **The conversion to UTC has no data behind it yet.** It needs the origin
 * airport's timezone, and `Airport.timezone` is nullable precisely because
 * OurAirports ships no timezone column — so nothing populates it today. Until
 * something does, the server can only treat these as UTC. `@tailfin/sim`'s
 * rotation model works in minutes from the cycle anchor and is unaffected;
 * this is a boundary problem, not a model one.
 */
export const ScheduleLeg = z.object({
  routeId: Uuid,
  departureMinuteLocal: MinuteOfDay,
});
export type ScheduleLeg = z.infer<typeof ScheduleLeg>;

/**
 * A repeating rotation: this airframe flies these legs in this order, on these
 * days, and the sim runs it continuously (§8.2).
 *
 * **Ordered legs, not one route.** §8.2's *"assign an aircraft to a rotation"*
 * and App. F.3's minute-75 beat — add the return leg and a second round trip,
 * save it as a repeating schedule — are both about a cycle of several legs. A
 * single-route schedule cannot express one, and cannot express the constraint
 * that makes a rotation a rotation: the aircraft has to end where it started.
 */
export const Schedule = z.object({
  id: Uuid,
  worldId: Uuid,
  airlineId: Uuid,
  airframeId: Uuid,

  legs: z.array(ScheduleLeg).min(1),
  repeat: RepeatPattern,

  active: z.boolean(),
  createdAt: Timestamp,
});
export type Schedule = z.infer<typeof Schedule>;

export const CreateScheduleInput = Schedule.pick({
  worldId: true,
  airframeId: true,
  legs: true,
  repeat: true,
});
export type CreateScheduleInput = z.infer<typeof CreateScheduleInput>;

/**
 * Why a rotation was refused (M2-03).
 *
 * Part of the contract for the same reason `ReachabilityCheck` is: a player told
 * only that their schedule is invalid has nine things to check and no way to
 * know which. The server's `@tailfin/sim` `RotationProblem` is this list.
 */
export const ScheduleProblem = z.enum([
  'empty',
  'no_repeat_days',
  'leg_order',
  'not_positioned',
  'does_not_close',
  'turn_too_short',
  'cycle_overrun',
  'no_slot',
  'crew_illegal',
]);
export type ScheduleProblem = z.infer<typeof ScheduleProblem>;

export const ScheduleValidation = z.discriminatedUnion('valid', [
  z.object({ valid: z.literal(true) }),
  z.object({
    valid: z.literal(false),
    problem: ScheduleProblem,
    /** Human-readable, and specific: "leg 2 departs LFPG, but leg 1 leaves the aircraft at EGLL". */
    detail: z.string(),
  }),
]);
export type ScheduleValidation = z.infer<typeof ScheduleValidation>;

/* ------------------------------------------------------- fares (M3-09) ---- */

/**
 * What the player is asking to charge, per cabin (§8.3).
 *
 * Partial, like `FareTable` itself: a route flown by an all-economy aircraft has
 * no business fare and should not be forced to invent one.
 */
export const SetFaresRequest = z.object({
  fares: FareTable,
});
export type SetFaresRequest = z.infer<typeof SetFaresRequest>;

/**
 * Why a fare was refused, with the number the player needs (App. A.10).
 *
 * M3-09's acceptance criterion is that the rejection *"explains the floor
 * value"*. A refusal that says only "too low" leaves the player guessing at a
 * limit the server already knows — §14.1's dead-end number in another costume —
 * so the floor, the shortfall and the cost it was drawn from are all on the
 * wire.
 */
export const FareFloorViolation = z.object({
  cabin: CabinClass,
  fareMinor: MinorUnits,
  /** The lowest fare A.10 permits on this route. */
  floorMinor: MinorUnits,
  shortfallMinor: MinorUnits,
  /** What one seat costs to fly, which is what the floor is a share of. */
  variableCostPerSeatMinor: MinorUnits,
  /** A.10's 0.6, on the wire so the client never hardcodes it. */
  ratio: z.number().positive(),
});
export type FareFloorViolation = z.infer<typeof FareFloorViolation>;

export const SetFaresResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), fares: FareTable }),
  z.object({ ok: z.literal(false), violations: z.array(FareFloorViolation).min(1) }),
]);
export type SetFaresResponse = z.infer<typeof SetFaresResponse>;

/** One operator's standing in a cabin's market, as the pricing panel shows it. */
export const CabinMarketPosition = z.object({
  cabin: CabinClass,
  yourFareMinor: MinorUnits.nullable(),
  /** The mean across operators — A.3's `PriceRel` denominator. */
  marketAverageMinor: MinorUnits,
  /** `yourFare ÷ marketAverage`. 1.0 is charging exactly the market rate. */
  priceRel: z.number().nonnegative().nullable(),
  floorMinor: MinorUnits,
  /**
   * Projected share of this cabin's demand, 0–1.
   *
   * A.4's share — demand **won**, before capacity clears it. Deliberately not
   * booked ÷ pool: that is a load factor wearing a share's name, and it reads
   * as 0.14 for a monopolist with a small aeroplane. A pricing panel is asking
   * "how much of this market do I take at this price", and capacity is a
   * separate question the spill figures already answer.
   */
  projectedShare: z.number().min(0).max(1).nullable(),
  seats: z.number().int().nonnegative(),
});
export type CabinMarketPosition = z.infer<typeof CabinMarketPosition>;

/**
 * `POST /api/routes/:routeId/fares/preview` — what would happen if you saved.
 *
 * Computed on the **server**, running the same `@tailfin/sim` code that resolves
 * the market for real. Invariant 1 forbids the client computing an economic
 * outcome, and `packages/web` may not import `@tailfin/sim` at all — so a
 * preview that agreed with resolution by construction is the only kind
 * available, which is exactly what M3-09 asks for.
 */
export const FarePreviewResponse = z.object({
  routeId: Uuid,
  positions: z.array(CabinMarketPosition),
  /** Projected passengers a day across every cabin, at these fares. */
  projectedPassengers: z.number().nonnegative(),
  /** And at the fares currently saved, so the panel can show the delta. */
  currentPassengers: z.number().nonnegative(),
});
export type FarePreviewResponse = z.infer<typeof FarePreviewResponse>;
