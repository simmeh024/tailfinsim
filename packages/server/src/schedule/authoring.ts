import { and, eq } from 'drizzle-orm';

import type {
  AuthoredLeg,
  CreateScheduleRequest,
  ScheduleView,
  SchedulingProblem,
} from '@tailfin/shared';
import {
  computeBlockTime,
  DEFAULT_FLIGHT_PROFILE,
  DEFAULT_TURNAROUND_MINUTES,
  MINUTES_PER_DAY,
  type RepeatPattern,
} from '@tailfin/sim';

import { airframe, route } from '../db/schema';

import { readSchedule } from './read';
import { createSchedule, type LegInput } from './store';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * Turning an authored rotation into the store's leg shape (M2-03, §8.2).
 *
 * The player names routes they hold and a local departure time for each leg; the
 * server owns everything else. Two things happen here:
 *
 *   - **Every route is resolved within the owner.** A leg naming a route the
 *     airline does not hold resolves to nothing, and the caller answers 404 —
 *     the same non-oracle behaviour the route endpoints set (ADR-0020). Ownership
 *     is resolved, never verified.
 *   - **The legs are placed into a rotation.** Each leg's block and turnaround
 *     are computed rather than accepted — they are physics and the §22.5
 *     catalogue, not a number a client should assert — and its absolute minute
 *     from the cycle anchor is derived so a leg that cannot follow the previous
 *     one the same day rolls to the next.
 */

/**
 * A reference narrowbody's cruise speed, matching `network/economics`'s
 * placeholder until M4's catalogue can answer per airframe. Block time is the
 * only thing this file reads it for; the money side has its own copy.
 */
const REFERENCE_CRUISE_KT = 447;

interface ResolvedLeg {
  routeId: string;
  originIcao: string;
  destinationIcao: string;
  greatCircleNm: number;
  departureMinuteLocal: number;
}

/**
 * Resolve each authored leg's route within the owner, in order.
 *
 * Null if any leg names a route the airline does not hold in this world — the
 * whole rotation is refused rather than silently dropping the leg, because a
 * rotation missing a leg is a different rotation.
 */
async function resolveAuthoredLegs(
  db: Database,
  own: ResolvedPlayerAirline,
  legs: readonly AuthoredLeg[],
): Promise<ResolvedLeg[] | null> {
  const resolved: ResolvedLeg[] = [];
  for (const leg of legs) {
    const [row] = await db
      .select({
        id: route.id,
        originIcao: route.originIcao,
        destinationIcao: route.destinationIcao,
        greatCircleNm: route.greatCircleNm,
      })
      .from(route)
      .where(
        and(eq(route.id, leg.routeId), eq(route.airlineId, own.id), eq(route.worldId, own.worldId)),
      )
      .limit(1);
    if (!row) return null;
    resolved.push({
      routeId: row.id,
      originIcao: row.originIcao,
      destinationIcao: row.destinationIcao,
      greatCircleNm: row.greatCircleNm,
      departureMinuteLocal: leg.departureMinuteLocal,
    });
  }
  return resolved;
}

/**
 * Place resolved legs into a rotation: absolute minutes from the cycle anchor,
 * with each leg's computed block and turnaround.
 *
 * Pure and deterministic. Leg 0 departs at its own minute-of-day from the
 * anchor; each later leg departs at the first occurrence of its minute-of-day
 * that is at or after the previous leg's on-blocks-plus-turnaround, so a rotation
 * that spills past midnight is placed on the following day rather than earlier in
 * the same one. `validateRotation` then has the final say on whether the result
 * closes, turns in time and fits a cycle.
 */
export function placeLegs(legs: readonly ResolvedLeg[]): LegInput[] {
  const placed: LegInput[] = [];
  let earliest = 0;
  for (const [index, leg] of legs.entries()) {
    const blockMinutes = computeBlockTime(
      leg.greatCircleNm,
      REFERENCE_CRUISE_KT,
      DEFAULT_FLIGHT_PROFILE,
    ).blockMinutes;
    const turnaroundMinutes = DEFAULT_TURNAROUND_MINUTES;

    let departureMinute = leg.departureMinuteLocal;
    if (index > 0) {
      while (departureMinute < earliest) departureMinute += MINUTES_PER_DAY;
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

/** Whether an airframe is the airline's, in this world. */
async function ownsAirframe(
  db: Database,
  own: ResolvedPlayerAirline,
  airframeId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: airframe.id })
    .from(airframe)
    .where(
      and(
        eq(airframe.id, airframeId),
        eq(airframe.airlineId, own.id),
        eq(airframe.worldId, own.worldId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The wire's unbranded 1–7 weekday narrowed to the sim's literal union. */
function toSimRepeat(repeat: CreateScheduleRequest['repeat']): RepeatPattern {
  return repeat.kind === 'weekdays'
    ? { kind: 'weekdays', days: repeat.days.map((d) => d as 1 | 2 | 3 | 4 | 5 | 6 | 7) }
    : { kind: 'daily' };
}

/** The outcome of authoring a schedule, in the vocabulary the route handler maps to HTTP. */
export type AuthorScheduleResult =
  | { status: 'created'; schedule: ScheduleView; warning: string | null }
  /** The airframe or a route is not this airline's — a 404, not an oracle. */
  | { status: 'unknown_airframe' }
  | { status: 'unknown_route' }
  /** The rotation cannot run, and here is exactly why (M2-03). */
  | { status: 'refused'; problem: SchedulingProblem; detail: string };

/**
 * Author a schedule for an airline, end to end.
 *
 * The whole database side of `POST /api/schedules`, kept out of the route handler
 * so the handler is a thin mapping to status codes — the pattern every other
 * endpoint in the codebase follows. Ownership of the airframe and every route is
 * resolved here, the legs are placed, and `createSchedule` validates and writes.
 */
export async function authorSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  request: CreateScheduleRequest,
): Promise<AuthorScheduleResult> {
  if (!(await ownsAirframe(db, own, request.airframeId))) {
    return { status: 'unknown_airframe' };
  }

  const resolved = await resolveAuthoredLegs(db, own, request.legs);
  if (resolved === null) return { status: 'unknown_route' };

  const result = await createSchedule(db, {
    worldId: own.worldId,
    airlineId: own.id,
    airframeId: request.airframeId,
    legs: placeLegs(resolved),
    repeat: toSimRepeat(request.repeat),
  });
  if (!result.ok) {
    return { status: 'refused', problem: result.problem, detail: result.detail };
  }

  const schedule = await readSchedule(db, own, result.scheduleId);
  if (schedule === null) {
    // Written inside this same call; its absence is a bug, not a player-facing 404.
    throw new Error(`Schedule ${result.scheduleId} vanished immediately after creation`);
  }
  return { status: 'created', schedule, warning: result.warning?.detail ?? null };
}
