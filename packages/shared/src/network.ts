import { z } from 'zod';

import {
  AirportIcaoCode,
  CabinClass,
  DemandSegment,
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

/** Player-authored fields for opening a route; ownership and economics are server-resolved. */
export const OpenRouteInput = Route.pick({
  originIcao: true,
  destinationIcao: true,
}).strict();
export type OpenRouteInput = z.infer<typeof OpenRouteInput>;

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

/* --------------------------------------------- the schedule API (M2-03) ---- */

/**
 * Every way a save can be refused — the pure `ScheduleProblem` list plus the
 * refusals only the database can raise.
 *
 * `airframe_unavailable` is not a rotation rule: it means the aeroplane is in a
 * check or grounded (M4-06), which `validateRotation` cannot see because it is a
 * row rather than arithmetic. To the player it is the same kind of answer — the
 * schedule cannot run, and here is exactly why — so it rides the same channel.
 */
export const SchedulingProblem = z.enum([...ScheduleProblem.options, 'airframe_unavailable']);
export type SchedulingProblem = z.infer<typeof SchedulingProblem>;

/**
 * One leg as the player authors it: a pair of airports and a local departure time.
 *
 * A rotation is a **sequence of stops** — AMS→KEF→JFK is two authored legs — so a
 * leg names its endpoints rather than a pre-opened route. The server finds the
 * route for each pair or **opens it** (reachability, range, runway, wingspan and
 * operating authority all checked against the actual airframe), then places the
 * legs: `departureMinuteLocal` is minute-of-day (§8.2), and the server assigns
 * each leg its absolute minute from the cycle anchor and computes its block and
 * turnaround, because those are physics and the catalogue, not a client's to
 * assert.
 */
export const AuthoredLeg = z
  .object({
    originIcao: AirportIcaoCode,
    destinationIcao: AirportIcaoCode,
    departureMinuteLocal: MinuteOfDay,
  })
  .strict();
export type AuthoredLeg = z.infer<typeof AuthoredLeg>;

/**
 * `POST /api/schedules` — assign an airframe to a rotation of stops.
 *
 * `autoReturn` appends a **nonstop** leg from the last stop back to the first, so a
 * multi-stop outbound (AMS→KEF→JFK) can always come straight home (JFK→AMS) —
 * placed as soon as the aircraft has landed and turned. Its route is opened like
 * any other leg.
 */
export const CreateScheduleRequest = z
  .object({
    airframeId: Uuid,
    legs: z.array(AuthoredLeg).min(1),
    autoReturn: z.boolean().default(false),
    repeat: RepeatPattern,
  })
  .strict();
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

/** One leg of a saved rotation, with the times the server resolved for it. */
export const ScheduleLegView = z.object({
  /**
   * The route this leg flies, mapped back from its endpoints (a `schedule_leg`
   * stores the pair, not a `route_id` — the join is deliberately deferred). Null
   * when the route it was authored against has since been closed.
   */
  routeId: Uuid.nullable(),
  originIcao: AirportIcaoCode,
  destinationIcao: AirportIcaoCode,
  /** Absolute minute from the cycle anchor (00:00 UTC); may exceed a day for a late leg. */
  departureMinute: z.number().int().nonnegative(),
  blockMinutes: z.number().nonnegative(),
  turnaroundMinutes: z.number().nonnegative(),
});
export type ScheduleLegView = z.infer<typeof ScheduleLegView>;

/** A saved rotation, as the network page lists it. */
export const ScheduleView = z.object({
  id: Uuid,
  airframeId: Uuid,
  legs: z.array(ScheduleLegView).min(1),
  repeat: RepeatPattern,
  active: z.boolean(),
  /** Flights on the books this schedule has not yet flown — the horizon the worker rolled. */
  upcomingFlights: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export type ScheduleView = z.infer<typeof ScheduleView>;

/** `GET /api/schedules` — every rotation this airline runs. */
export const SchedulesResponse = z.object({
  schedules: z.array(ScheduleView),
});
export type SchedulesResponse = z.infer<typeof SchedulesResponse>;

/**
 * A saved schedule, and any warning it earned (M5-02).
 *
 * `warning` is not a refusal — §9.2's texture is that airlines roster to the
 * line, so a rotation that is legal but hard on the crew is saved and *told
 * about*, not declined. The hard rule is at departure. Null when there is
 * nothing to say.
 */
/** One leg's operating cost and distance — decision support, never a gate (§14). */
export const ScheduleLegCost = z.object({
  originIcao: AirportIcaoCode,
  destinationIcao: AirportIcaoCode,
  distanceNm: NauticalMiles,
  /** Whether this leg's route was opened by this save rather than already held. */
  opened: z.boolean(),
  /** Estimated variable cost to fly the leg once, minor units, at the reference cabin. */
  variableCostMinor: MinorUnits,
});
export type ScheduleLegCost = z.infer<typeof ScheduleLegCost>;

/**
 * What a rotation costs to fly and how far it goes (§14).
 *
 * Surfaced, not enforced — the game lets an airline fly a loss-making route on
 * purpose, so this is the "check on costs" as decision support: a multi-stop
 * routing that adds a leg adds its cost here, in the open, before the player
 * commits.
 */
export const ScheduleCostEstimate = z.object({
  legs: z.array(ScheduleLegCost),
  totalDistanceNm: NauticalMiles,
  totalVariableCostMinor: MinorUnits,
  /** Routes this save opened that the airline did not already hold. */
  routesOpened: z.number().int().nonnegative(),
});
export type ScheduleCostEstimate = z.infer<typeof ScheduleCostEstimate>;

export const CreateScheduleResponse = z.object({
  schedule: ScheduleView,
  warning: z.string().nullable(),
  cost: ScheduleCostEstimate,
});
export type CreateScheduleResponse = z.infer<typeof CreateScheduleResponse>;

/**
 * Every way authoring a schedule can be refused (M2-03).
 *
 * The rotation problems, plus the ones a leg raises when its route has to be
 * opened: an airport that does not exist, a leg the airframe cannot fly
 * (`unreachable` — range, runway, wingspan, curfew…), and a leg that needs
 * operating authority the airline has not hired.
 */
export const ScheduleAuthoringProblem = z.enum([
  ...SchedulingProblem.options,
  'unknown_airport',
  'unreachable',
  'authority_required',
]);
export type ScheduleAuthoringProblem = z.infer<typeof ScheduleAuthoringProblem>;

/** Why a schedule was refused, with the specific reason (M2-03). */
export const ScheduleRefusal = z.object({
  problem: ScheduleAuthoringProblem,
  /** Human-readable and specific: "leg 2 (KEF→JFK) is out of range: needs 3,200 nm, the aircraft does 3,000 nm". */
  detail: z.string(),
});
export type ScheduleRefusal = z.infer<typeof ScheduleRefusal>;

/**
 * `PUT /api/schedules/:id` — replace a rotation's legs and repeat.
 *
 * The airframe is not editable here — a schedule *is* one airframe's rotation, so
 * moving it to another aircraft is a different schedule. Only future, unflown
 * flights are disturbed; one already off-blocks is history. `autoReturn` behaves
 * as it does on create.
 */
export const EditScheduleRequest = z
  .object({
    legs: z.array(AuthoredLeg).min(1),
    autoReturn: z.boolean().default(false),
    repeat: RepeatPattern,
  })
  .strict();
export type EditScheduleRequest = z.infer<typeof EditScheduleRequest>;

/** `PUT /api/schedules/:id/active` — pause a rotation, or resume it. */
export const SetScheduleActiveRequest = z.object({ active: z.boolean() }).strict();
export type SetScheduleActiveRequest = z.infer<typeof SetScheduleActiveRequest>;

/* ------------------------------------------------------- fares (M3-09) ---- */

/**
 * What the player is asking to charge, per cabin (§8.3).
 *
 * Partial, like `FareTable` itself: a route flown by an all-economy aircraft has
 * no business fare and should not be forced to invent one.
 */
export const SetFaresRequest = z
  .object({
    fares: FareTable,
  })
  .strict();
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

/* --------------------------------------------------- the waterfall (M3-10) ---- */

/** One line of App. A.9's table: how much of the utility gap this factor explains. */
export const WaterfallFactor = z.object({
  /** `price`, `frequency`, `product`, `reputation`, `schedule`, … */
  factor: z.string().min(1),
  /** Your term minus theirs. Negative means they are better on this factor. */
  delta: z.number(),
});
export type WaterfallFactor = z.infer<typeof WaterfallFactor>;

export const WaterfallSegment = z.object({
  segment: DemandSegment,
  factors: z.array(WaterfallFactor),
  /**
   * The sum of `factors` — **exactly** the utility gap, with no residual.
   *
   * A.9's whole claim: *"the waterfall isn't an approximation of the result — it
   * **is** the result."* Because share is a ratio of exponentials, the gap
   * decomposes without remainder, which is why there is no "other" line here
   * and why one would be a bug rather than a rounding allowance.
   */
  netDelta: z.number(),
  /** `exp(netDelta)`, and equal to `yourShare ÷ theirShare` to twelve places. */
  shareRatio: z.number().nonnegative(),
  yourShare: z.number().min(0).max(1),
  theirShare: z.number().min(0).max(1),
});
export type WaterfallSegment = z.infer<typeof WaterfallSegment>;

/** Who there is to compare against on a route. */
export const RouteRival = z.object({
  id: z.string().min(1),
  /** Which cabins they sell, so the picker cannot offer a comparison that has no market. */
  cabins: z.array(CabinClass),
});
export type RouteRival = z.infer<typeof RouteRival>;

/**
 * `GET /api/routes/:routeId/waterfall` — why you are losing, decomposed.
 *
 * All three segments in one response. A.9's table is per segment, and the
 * interesting thing about this route is usually that the answer *differs*
 * between them — the same three airlines produce almost opposite outcomes in
 * business and leisure (A.8). Making the reader pay a round trip to discover
 * that would hide the point.
 */
export const FareWaterfallResponse = z.object({
  routeId: Uuid,
  cabin: CabinClass,
  /** Whose utility this one is measured against. */
  rivalId: z.string().min(1),
  /**
   * Everyone there is to compare against, including `rivalId` itself.
   *
   * Carried on the *success* path and not only on the refusals, because A.8's
   * own route has two rivals and the answer differs against each: the LCC beats
   * you on price, the legacy carrier beats you on product. A response that
   * named only the operator it happened to pick would let the player see one of
   * those two and never learn that the other existed.
   */
  rivals: z.array(RouteRival),
  bySegment: z.array(WaterfallSegment),
});
export type FareWaterfallResponse = z.infer<typeof FareWaterfallResponse>;

/* -------------------------------------------- route performance (M2-06) ---- */

/**
 * One bucket of a route's load-factor trend, oldest first.
 *
 * `loadFactor` is null for a week the route flew nothing — a gap, which reads
 * differently from a week that flew empty (0). The sparkline should show the
 * difference.
 */
export const RoutePerformanceWeek = z.object({
  /** Game-time start of the week bucket. */
  weekStart: Timestamp,
  flights: z.number().int().nonnegative(),
  loadFactor: z.number().min(0).max(1).nullable(),
});
export type RoutePerformanceWeek = z.infer<typeof RoutePerformanceWeek>;

/**
 * `GET /api/routes/:routeId/performance` — what a route actually did, rolled up
 * from its settled flights (§14.4).
 *
 * Only the worker produces `flight_result` rows, so on a world with no worker
 * every figure here is zero and the trend is empty — a route that reads as idle
 * rather than as a broken report, the same boundary the fleet page has. The
 * figures cover the trailing `windowDays` of the world's own clock and count
 * **completed scheduled flights only** — a cancelled flight never settles, and a
 * ferry earns nothing and is excluded.
 */
export const RoutePerformanceResponse = z.object({
  routeId: Uuid,
  /** The trailing window rolled up, in game days. */
  windowDays: z.number().int().positive(),
  flights: z.number().int().nonnegative(),
  seats: z.number().int().nonnegative(),
  passengers: z.number().int().nonnegative(),
  spilledPassengers: z.number().int().nonnegative(),
  /** Passengers ÷ seats over the window; null when nothing flew. */
  loadFactor: z.number().min(0).max(1).nullable(),
  revenueMinor: MinorUnits,
  costMinor: MinorUnits,
  /** Contribution — revenue minus the flight's own costs; period costs are not here. */
  netMinor: MinorUnits,
  /** Revenue and cost per available seat-kilometre, minor units; null when nothing flew. */
  raskMinor: z.number().nonnegative().nullable(),
  caskMinor: z.number().nonnegative().nullable(),
  /** Share of arrivals within 15 minutes of plan, 0–1; null when nothing flew. */
  onTimePct: z.number().min(0).max(1).nullable(),
  avgArrivalDelayMinutes: z.number().nullable(),
  /** Total block hours flown in the window — the numerator of aircraft utilisation. */
  blockHours: z.number().nonnegative(),
  /** A weekly load-factor trend for the sparkline, oldest first. */
  trend: z.array(RoutePerformanceWeek),
});
export type RoutePerformanceResponse = z.infer<typeof RoutePerformanceResponse>;

/* ------------------------------------------- route competition (M3-12) ---- */

/** One operator on a route's market — a rival, or you. */
export const RouteCompetitor = z.object({
  airlineId: Uuid,
  name: z.string(),
  /** `npc` carriers and rival players compete by the same mechanism (A.3). */
  kind: z.enum(['player', 'npc']),
  /** True for the airline that asked — its own line in the market. */
  isYou: z.boolean(),
  weeklyFrequency: z.number().int().nonnegative(),
  /** Headline economy fare, minor units; null when it sells no economy cabin. */
  economyFareMinor: MinorUnits.nullable(),
  /** Projected share of the market's daily demand, 0–1 (A.4). */
  share: z.number().min(0).max(1),
  /** A.3's 0–1 product composite, for a coarse quality tier. */
  productScore: z.number().min(0).max(1),
});
export type RouteCompetitor = z.infer<typeof RouteCompetitor>;

/**
 * `GET /api/routes/:routeId/competition` — who else is in this market, and how
 * much of it each takes (§8.3, A.3–A.4).
 *
 * The live answer to *"why did a competitor appear in my market?"* for one route:
 * every active airline selling the pair — NPC or player, in either direction —
 * resolved through the *same* share model the fares preview and the waterfall use,
 * so the shares here and the projection there cannot disagree. `you` are in the
 * list, so the market reads as a whole rather than as "them" against an implied
 * self.
 */
export const RouteCompetitionResponse = z.object({
  routeId: Uuid,
  /** Total daily passengers the market holds across segments. */
  marketDailyPassengers: z.number().nonnegative(),
  /** Every operator, you included, most share first. */
  operators: z.array(RouteCompetitor),
});
export type RouteCompetitionResponse = z.infer<typeof RouteCompetitionResponse>;
