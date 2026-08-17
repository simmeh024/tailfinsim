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
 * A repeating rotation: this airframe flies this route at this local time on
 * these weekdays, and the sim runs it continuously (§8.2).
 *
 * `departureMinuteLocal` is local to the origin airport, not UTC, because
 * curfews and passengers' schedule preferences (App. A.3's SchedFit term) are
 * both local concepts. Converting to UTC is the server's job and needs the
 * airport's timezone.
 */
export const Schedule = z.object({
  id: Uuid,
  worldId: Uuid,
  airlineId: Uuid,
  routeId: Uuid,
  airframeId: Uuid,

  departureMinuteLocal: MinuteOfDay,
  /** Empty means every day. */
  weekdays: z.array(IsoWeekday).max(7),

  active: z.boolean(),
  createdAt: Timestamp,
});
export type Schedule = z.infer<typeof Schedule>;

export const CreateScheduleInput = Schedule.pick({
  worldId: true,
  routeId: true,
  airframeId: true,
  departureMinuteLocal: true,
  weekdays: true,
});
export type CreateScheduleInput = z.infer<typeof CreateScheduleInput>;
