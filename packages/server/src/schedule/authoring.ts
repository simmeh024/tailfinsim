import { and, eq } from 'drizzle-orm';

import {
  type AuthoredLeg,
  type CreateScheduleRequest,
  type EditScheduleRequest,
  type ScheduleAuthoringProblem,
  type ScheduleCostEstimate,
  type ScheduleLegCost,
  type ScheduleView,
  AircraftSpec as AircraftSpecSchema,
  type AircraftSpec,
} from '@tailfin/shared';
import {
  type AircraftCapability,
  computeBlockTime,
  DEFAULT_FLIGHT_PROFILE,
  DEFAULT_TURNAROUND_MINUTES,
  gameTime,
  horizonFrom,
  MINUTES_PER_DAY,
  type RepeatPattern,
  routeVariableCostPerSeatMinor,
  type WorldClock,
} from '@tailfin/sim';

import { airframe, route, schedule, world } from '../db/schema';
import { openRoute } from '../network/open-route';
import { resolveLegSlots } from '../network/slots';

import { readSchedule } from './read';
import {
  createSchedule,
  deleteSchedule,
  replaceScheduleLegs,
  setScheduleActive,
  type LegInput,
} from './store';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';
import type { RouteEconomics, RouteRow } from '../network/fares';

/**
 * Turning an authored rotation into flights (M2-03, §8.2).
 *
 * A rotation is a **sequence of stops**, so the player authors legs as airport
 * pairs and the server does the rest, all against the **actual airframe**:
 *
 *   - **Finds or opens each leg's route.** A pair the airline already flies is
 *     reused; one it does not is opened, reachability/range/runway/wingspan and
 *     operating authority all checked against this aeroplane's spec — so a leg the
 *     aircraft physically cannot fly is refused, naming why.
 *   - **Adds a nonstop return** when `autoReturn` is set — from the last stop back
 *     to the first, placed as soon as the aircraft has landed and turned.
 *   - **Places the legs and prices them.** Block time comes from the airframe's
 *     cruise speed; a cost estimate per leg is surfaced (never a gate — a player
 *     may fly a loss-making route on purpose).
 */

/** How the economics of one leg's route are resolved — the network provider. */
export type RouteEconomicsProvider = (row: RouteRow) => Promise<RouteEconomics>;

/** The airframe capability the reachability and range checks run against. */
export function airframeCapability(spec: AircraftSpec): AircraftCapability {
  return {
    rangeNm: spec.rangeNm,
    takeoffRunM: spec.runwayRequirementM,
    wingspanCode: spec.wingspanCode,
    // AircraftSpec carries no ETOPS approval yet; null flies within the default
    // 60-minute diversion rule, which is every route this reference network flies.
    etopsMinutes: null,
  };
}

interface ResolvedLeg {
  routeId: string;
  originIcao: string;
  destinationIcao: string;
  greatCircleNm: number;
  /** Minute-of-day the player asked for, or null for an auto-return (placed ASAP). */
  departureMinuteLocal: number | null;
  /** Whether this save opened the route rather than reusing one the airline held. */
  opened: boolean;
}

interface Refusal {
  problem: ScheduleAuthoringProblem;
  detail: string;
}
type LegResolution = { ok: true; leg: ResolvedLeg } | ({ ok: false } & Refusal);

/** The owned airframe's spec, or null when the aircraft is not this airline's. */
async function loadOwnedAirframeSpec(
  db: Database,
  own: ResolvedPlayerAirline,
  airframeId: string,
): Promise<AircraftSpec | null> {
  const [row] = await db
    .select({ effectiveSpec: airframe.effectiveSpec })
    .from(airframe)
    .where(
      and(
        eq(airframe.id, airframeId),
        eq(airframe.airlineId, own.id),
        eq(airframe.worldId, own.worldId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const parsed = AircraftSpecSchema.safeParse(JSON.parse(row.effectiveSpec) as unknown);
  return parsed.success ? parsed.data : null;
}

/** The route for a pair the airline already holds, or null. */
async function existingRoute(
  db: Database,
  own: ResolvedPlayerAirline,
  originIcao: string,
  destinationIcao: string,
): Promise<{ id: string; greatCircleNm: number } | null> {
  const [row] = await db
    .select({ id: route.id, greatCircleNm: route.greatCircleNm })
    .from(route)
    .where(
      and(
        eq(route.airlineId, own.id),
        eq(route.worldId, own.worldId),
        eq(route.originIcao, originIcao),
        eq(route.destinationIcao, destinationIcao),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Turn an `openRoute` refusal into a schedule refusal, naming the leg. */
function refuseOpen(
  outcome: Extract<Awaited<ReturnType<typeof openRoute>>, { ok: false }>,
  originIcao: string,
  destinationIcao: string,
): Refusal {
  const leg = `${originIcao}→${destinationIcao}`;
  switch (outcome.kind) {
    case 'unknown-airport':
      return { problem: 'unknown_airport', detail: `No airport ${outcome.icao}.` };
    case 'same-airport':
      return { problem: 'unreachable', detail: `A leg cannot start and end at ${originIcao}.` };
    case 'unreachable':
      return {
        problem: 'unreachable',
        detail: `${leg} cannot be flown: ${outcome.reachability.detail}`,
      };
    case 'authority':
      return {
        problem: 'authority_required',
        detail: `${leg} needs the Safety & Compliance office (${outcome.reason}).`,
      };
    case 'airline-not-active':
      return { problem: 'unreachable', detail: `Your airline is ${outcome.status}.` };
    case 'duplicate':
      // The route was created concurrently; the caller re-reads it. Not reachable
      // on the ordinary path, but mapped so the type is exhaustive.
      return { problem: 'unreachable', detail: `${leg} could not be resolved; try again.` };
  }
}

/** Find or open the route for one leg, range-checked against the airframe. */
async function resolveOrOpenLeg(
  db: Database,
  own: ResolvedPlayerAirline,
  capability: AircraftCapability,
  originIcao: string,
  destinationIcao: string,
  departureMinuteLocal: number | null,
): Promise<LegResolution> {
  const held = await existingRoute(db, own, originIcao, destinationIcao);
  if (held) {
    // An existing route may have been opened for a longer-range aeroplane, so
    // range-check it against the one actually being scheduled.
    if (held.greatCircleNm >= capability.rangeNm) {
      return {
        ok: false,
        problem: 'unreachable',
        detail: `${originIcao}→${destinationIcao} is out of range: ${Math.round(held.greatCircleNm)} nm, the aircraft does ${String(capability.rangeNm)} nm.`,
      };
    }
    return {
      ok: true,
      leg: {
        routeId: held.id,
        originIcao,
        destinationIcao,
        greatCircleNm: held.greatCircleNm,
        departureMinuteLocal,
        opened: false,
      },
    };
  }

  const opened = await openRoute(db, own, { originIcao, destinationIcao }, capability);
  if (!opened.ok) {
    if (opened.kind === 'duplicate') {
      // Lost a race to open it — it exists now, so read it back.
      const now = await existingRoute(db, own, originIcao, destinationIcao);
      if (now) {
        return {
          ok: true,
          leg: {
            routeId: now.id,
            originIcao,
            destinationIcao,
            greatCircleNm: now.greatCircleNm,
            departureMinuteLocal,
            opened: false,
          },
        };
      }
    }
    return { ok: false, ...refuseOpen(opened, originIcao, destinationIcao) };
  }
  return {
    ok: true,
    leg: {
      routeId: opened.routeId,
      originIcao,
      destinationIcao,
      greatCircleNm: opened.greatCircleNm,
      departureMinuteLocal,
      opened: true,
    },
  };
}

export type PreparedLegs = { ok: true; legs: ResolvedLeg[] } | ({ ok: false } & Refusal);

/**
 * Resolve every authored leg to a route, opening what is missing, and append the
 * nonstop return when asked.
 */
export async function prepareLegs(
  db: Database,
  own: ResolvedPlayerAirline,
  capability: AircraftCapability,
  authored: readonly AuthoredLeg[],
  autoReturn: boolean,
): Promise<PreparedLegs> {
  const legs: ResolvedLeg[] = [];
  for (const leg of authored) {
    const resolution = await resolveOrOpenLeg(
      db,
      own,
      capability,
      leg.originIcao.toUpperCase(),
      leg.destinationIcao.toUpperCase(),
      leg.departureMinuteLocal,
    );
    if (!resolution.ok) return resolution;
    legs.push(resolution.leg);
  }

  if (autoReturn && legs.length > 0) {
    const first = legs[0]!;
    const last = legs[legs.length - 1]!;
    // Only when the aircraft is not already back where it started — otherwise a
    // return leg would start and end at the same airport.
    if (last.destinationIcao !== first.originIcao) {
      const resolution = await resolveOrOpenLeg(
        db,
        own,
        capability,
        last.destinationIcao,
        first.originIcao,
        null,
      );
      if (!resolution.ok) return resolution;
      legs.push(resolution.leg);
    }
  }

  return { ok: true, legs };
}

/**
 * Place resolved legs into a rotation: absolute minutes from the cycle anchor,
 * with each leg's computed block and turnaround.
 *
 * Leg 0 departs at its own minute-of-day; each later leg with a chosen time
 * departs at the first occurrence of that minute-of-day at or after the previous
 * leg has landed and turned, so a rotation that spills past midnight rolls to the
 * next day. A leg with no chosen time (the auto-return) departs as soon as it can.
 */
export function placeLegs(legs: readonly ResolvedLeg[], cruiseSpeedKt: number): LegInput[] {
  const placed: LegInput[] = [];
  let earliest = 0;
  for (const [index, leg] of legs.entries()) {
    // Whole minutes: `schedule_leg.block_minutes` is an integer column, and a leg
    // is a plan rather than a settlement — the precise block time is recomputed at
    // arrival. `computeBlockTime` returns a fractional figure, so round it here.
    const blockMinutes = Math.round(
      computeBlockTime(leg.greatCircleNm, cruiseSpeedKt, DEFAULT_FLIGHT_PROFILE).blockMinutes,
    );
    const turnaroundMinutes = DEFAULT_TURNAROUND_MINUTES;

    let departureMinute: number;
    if (leg.departureMinuteLocal === null) {
      departureMinute = earliest;
    } else {
      departureMinute = leg.departureMinuteLocal;
      if (index > 0) {
        while (departureMinute < earliest) departureMinute += MINUTES_PER_DAY;
      }
    }

    placed.push({
      originIcao: leg.originIcao,
      destinationIcao: leg.destinationIcao,
      departureMinute,
      blockMinutes,
      turnaroundMinutes,
    });
    earliest = departureMinute + blockMinutes + turnaroundMinutes;
  }
  return placed;
}

/** The variable cost and distance of each leg, surfaced for the player (§14). */
export async function estimateCost(
  own: ResolvedPlayerAirline,
  legs: readonly ResolvedLeg[],
  economicsFor: RouteEconomicsProvider,
): Promise<ScheduleCostEstimate> {
  const legCosts: ScheduleLegCost[] = [];
  let totalDistanceNm = 0;
  let totalVariableCostMinor = 0;
  let routesOpened = 0;

  for (const leg of legs) {
    const economics = await economicsFor({
      id: leg.routeId,
      worldId: own.worldId,
      airlineId: own.id,
      originIcao: leg.originIcao,
      destinationIcao: leg.destinationIcao,
      greatCircleNm: leg.greatCircleNm,
      fares: {},
    });
    const variableCostMinor = Math.round(
      routeVariableCostPerSeatMinor(
        {
          distanceNm: leg.greatCircleNm,
          aircraft: economics.aircraft,
          market: economics.market,
          originStation: economics.originStation,
          originFees: economics.originFees,
          destinationFees: economics.destinationFees,
        },
        economics.settlement,
      ).sectorCostMinor,
    );

    legCosts.push({
      originIcao: leg.originIcao,
      destinationIcao: leg.destinationIcao,
      distanceNm: leg.greatCircleNm,
      opened: leg.opened,
      variableCostMinor,
    });
    totalDistanceNm += leg.greatCircleNm;
    totalVariableCostMinor += variableCostMinor;
    if (leg.opened) routesOpened += 1;
  }

  return { legs: legCosts, totalDistanceNm, totalVariableCostMinor, routesOpened };
}

/** The wire's unbranded 1–7 weekday narrowed to the sim's literal union. */
function toSimRepeat(repeat: CreateScheduleRequest['repeat']): RepeatPattern {
  return repeat.kind === 'weekdays'
    ? { kind: 'weekdays', days: repeat.days.map((d) => d as 1 | 2 | 3 | 4 | 5 | 6 | 7) }
    : { kind: 'daily' };
}

/** The outcome of authoring a schedule, in the vocabulary the route handler maps to HTTP. */
export type AuthorScheduleResult =
  | {
      status: 'created';
      schedule: ScheduleView;
      warning: string | null;
      cost: ScheduleCostEstimate;
    }
  /** The airframe is not this airline's — a 404, not an oracle. */
  | { status: 'unknown_airframe' }
  /** The rotation cannot run (a leg is unreachable/needs authority, or it does not close…). */
  | { status: 'refused'; problem: ScheduleAuthoringProblem; detail: string };

/**
 * Author a schedule for an airline, end to end.
 *
 * The whole database side of `POST /api/schedules`: resolve the airframe and its
 * capability, find or open every leg's route against it, place the rotation,
 * validate and write it, and price it. Kept out of the route handler so the
 * handler stays a thin mapping to status codes.
 */
export async function authorSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  request: CreateScheduleRequest,
  economicsFor: RouteEconomicsProvider,
): Promise<AuthorScheduleResult> {
  const spec = await loadOwnedAirframeSpec(db, own, request.airframeId);
  if (spec === null) return { status: 'unknown_airframe' };
  const capability = airframeCapability(spec);

  const prepared = await prepareLegs(db, own, capability, request.legs, request.autoReturn);
  if (!prepared.ok)
    return { status: 'refused', problem: prepared.problem, detail: prepared.detail };

  const placed = placeLegs(prepared.legs, spec.cruiseSpeedKt);
  const result = await createSchedule(
    db,
    {
      worldId: own.worldId,
      airlineId: own.id,
      airframeId: request.airframeId,
      legs: placed,
      repeat: toSimRepeat(request.repeat),
    },
    // Slots resolved from real holdings — the M7-05 wiring the store has waited for.
    // `crewLegal` stays undefined so the database still decides crew.
    { slots: await resolveLegSlots(db, own, placed) },
  );
  if (!result.ok) {
    return { status: 'refused', problem: result.problem, detail: result.detail };
  }

  const view = await readSchedule(db, own, result.scheduleId);
  if (view === null) {
    // Written inside this same call; its absence is a bug, not a player-facing 404.
    throw new Error(`Schedule ${result.scheduleId} vanished immediately after creation`);
  }
  return {
    status: 'created',
    schedule: view,
    warning: result.warning?.detail ?? null,
    cost: await estimateCost(own, prepared.legs, economicsFor),
  };
}

/** The world's clock parameters, or null for an unknown world. */
async function worldClockOf(db: Database, worldId: string): Promise<WorldClock | null> {
  const [row] = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!row) return null;
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/** The outcome of editing a schedule's legs, mapped to HTTP by the route handler. */
export type EditScheduleResult =
  | { status: 'updated'; schedule: ScheduleView; cost: ScheduleCostEstimate }
  /** No such schedule for this airline — a 404, not an oracle. */
  | { status: 'not_found' }
  /** The new rotation cannot run, and here is exactly why. */
  | { status: 'refused'; problem: ScheduleAuthoringProblem; detail: string };

/**
 * Replace a schedule's legs and repeat, owner-scoped (M2-03 lifecycle).
 *
 * Keeps the schedule's airframe — a schedule is one airframe's rotation — and
 * checks the new legs against it exactly as authoring does. `replaceScheduleLegs`
 * reconciles the flights already on the horizon: only future, unflown ones move.
 */
export async function editSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  scheduleId: string,
  request: EditScheduleRequest,
  economicsFor: RouteEconomicsProvider,
  now: Date = new Date(),
): Promise<EditScheduleResult> {
  const [owned] = await db
    .select({ airframeId: schedule.airframeId })
    .from(schedule)
    .where(and(eq(schedule.id, scheduleId), eq(schedule.airlineId, own.id)))
    .limit(1);
  if (!owned) return { status: 'not_found' };

  const spec = await loadOwnedAirframeSpec(db, own, owned.airframeId);
  // A schedule whose airframe has since been sold cannot be range-checked; refuse
  // rather than guess with a reference aeroplane.
  if (spec === null) return { status: 'not_found' };
  const capability = airframeCapability(spec);

  const prepared = await prepareLegs(db, own, capability, request.legs, request.autoReturn);
  if (!prepared.ok)
    return { status: 'refused', problem: prepared.problem, detail: prepared.detail };

  const clock = await worldClockOf(db, own.worldId);
  if (clock === null) return { status: 'not_found' };
  const gameNow = gameTime(clock, now);

  const placed = placeLegs(prepared.legs, spec.cruiseSpeedKt);
  const outcome = await replaceScheduleLegs(
    db,
    scheduleId,
    placed,
    toSimRepeat(request.repeat),
    gameNow,
    horizonFrom(gameNow),
    // Same slot resolution as create — an edit is authored under the same rule.
    { slots: await resolveLegSlots(db, own, placed) },
  );
  if (!outcome.ok) return { status: 'refused', problem: outcome.problem, detail: outcome.detail };

  const view = await readSchedule(db, own, scheduleId);
  if (view === null) throw new Error(`Schedule ${scheduleId} vanished immediately after an edit`);
  return {
    status: 'updated',
    schedule: view,
    cost: await estimateCost(own, prepared.legs, economicsFor),
  };
}

/**
 * Pause or resume a schedule, owner-scoped. Returns the updated view, or null
 * when it is not this airline's.
 */
export async function pauseSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  scheduleId: string,
  active: boolean,
): Promise<ScheduleView | null> {
  const changed = await setScheduleActive(db, scheduleId, own.id, active);
  if (!changed) return null;
  return readSchedule(db, own, scheduleId);
}

/**
 * Delete a schedule and cancel its future flights, owner-scoped. Returns false
 * when it is not this airline's.
 */
export async function removeSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  scheduleId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const clock = await worldClockOf(db, own.worldId);
  if (clock === null) return false;
  return deleteSchedule(db, scheduleId, own.id, gameTime(clock, now));
}
