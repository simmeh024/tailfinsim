import { and, eq } from 'drizzle-orm';

import type { AuthoredLeg } from '@tailfin/shared';
import {
  computeBlockTime,
  DEFAULT_FLIGHT_PROFILE,
  DEFAULT_TURNAROUND_MINUTES,
  MINUTES_PER_DAY,
} from '@tailfin/sim';

import { route } from '../db/schema';

import type { LegInput } from './store';
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
export async function resolveAuthoredLegs(
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
