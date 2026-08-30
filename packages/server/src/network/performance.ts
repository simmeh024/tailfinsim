import { and, eq, gte } from 'drizzle-orm';

import type { RoutePerformanceResponse, RoutePerformanceWeek } from '@tailfin/shared';
import { gameTime, type WorldClock } from '@tailfin/sim';

import { flight, flightResult, route, world } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * What a route actually did, rolled up from its settled flights (M2-06, §14.4).
 *
 * The read side of §14.4's *"profit by route, ranked"*: a route's own
 * `flight_result` rows, aggregated over a trailing window of the world's game
 * clock. Owner-scoped — the route is resolved within the session airline, and one
 * that is not theirs is a 404 rather than an oracle (ADR-0020).
 *
 * ## Only completed scheduled flights count
 *
 * A `flight_result` exists only for a flight that arrived and settled, so a
 * cancelled flight — which never settles — is simply absent, and a ferry earns
 * nothing and is filtered out. The figures are therefore *"what the route did"*,
 * not *"what it was scheduled to do"*; capacity and the plan are other questions.
 *
 * ## The worker is what fills this
 *
 * Nothing but the worker settles a flight, so on a world with no worker every
 * figure is zero and the trend is empty — a route that reads as idle, the same
 * boundary the fleet page carries. That is correct, not broken.
 */

/** The trailing window rolled up, in game days — twelve weeks, matching the trend. */
const WINDOW_DAYS = 84;
const WEEK_DAYS = 7;
const WEEKS = WINDOW_DAYS / WEEK_DAYS;
const MS_PER_DAY = 86_400_000;

/** §15's on-time bar: an arrival within a quarter-hour of plan is on time. */
const ON_TIME_THRESHOLD_MINUTES = 15;

/** App. B.4's great-circle-to-kilometres, for available-seat-kilometres. */
const NM_TO_KM = 1.852;

/** One settled flight on the route, the shape the rollup folds. Exported for the unit test. */
export interface SettledFlight {
  revenueMinor: number;
  costMinor: number;
  netMinor: number;
  seats: number;
  passengers: number;
  spilledPassengers: number;
  blockSeconds: number;
  arrivalDelayMinutes: number;
  settledAt: Date;
}

async function loadWorldClock(db: Database, worldId: string): Promise<WorldClock | null> {
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

/** A route's performance over the trailing window, or null if it is not this airline's. */
export async function routePerformance(
  db: Database,
  own: ResolvedPlayerAirline,
  routeId: string,
  now: Date = new Date(),
): Promise<RoutePerformanceResponse | null> {
  const [r] = await db
    .select({
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
      greatCircleNm: route.greatCircleNm,
    })
    .from(route)
    .where(and(eq(route.id, routeId), eq(route.airlineId, own.id), eq(route.worldId, own.worldId)))
    .limit(1);
  if (!r) return null;

  const clock = await loadWorldClock(db, own.worldId);
  if (clock === null) return null;
  const gameNow = gameTime(clock, now);
  const since = new Date(gameNow.getTime() - WINDOW_DAYS * MS_PER_DAY);

  // One owner-scoped read of the route's settled flights in the window. Money
  // columns are `mode: 'number'`, so the sums are done here rather than in SQL —
  // which also sidesteps the bigint-comes-back-a-string trap CLAUDE.md records.
  const rows: SettledFlight[] = await db
    .select({
      revenueMinor: flightResult.revenueMinor,
      costMinor: flightResult.costMinor,
      netMinor: flightResult.netMinor,
      seats: flightResult.seats,
      passengers: flightResult.passengers,
      spilledPassengers: flightResult.spilledPassengers,
      blockSeconds: flightResult.blockSeconds,
      arrivalDelayMinutes: flightResult.arrivalDelayMinutes,
      settledAt: flightResult.settledAt,
    })
    .from(flightResult)
    .innerJoin(flight, eq(flight.id, flightResult.flightId))
    .where(
      and(
        eq(flightResult.airlineId, own.id),
        eq(flightResult.kind, 'scheduled'),
        gte(flightResult.settledAt, since),
        eq(flight.originIcao, r.originIcao),
        eq(flight.destinationIcao, r.destinationIcao),
      ),
    );

  return summarisePerformance(routeId, rows, r.greatCircleNm, gameNow);
}

/** Fold the settled flights into the response, including the weekly trend. */
export function summarisePerformance(
  routeId: string,
  rows: readonly SettledFlight[],
  greatCircleNm: number,
  gameNow: Date,
): RoutePerformanceResponse {
  let seats = 0;
  let passengers = 0;
  let spilledPassengers = 0;
  let revenueMinor = 0;
  let costMinor = 0;
  let netMinor = 0;
  let blockSeconds = 0;
  let delaySum = 0;
  let onTime = 0;

  for (const row of rows) {
    seats += row.seats;
    passengers += row.passengers;
    spilledPassengers += row.spilledPassengers;
    revenueMinor += row.revenueMinor;
    costMinor += row.costMinor;
    netMinor += row.netMinor;
    blockSeconds += row.blockSeconds;
    delaySum += row.arrivalDelayMinutes;
    if (row.arrivalDelayMinutes <= ON_TIME_THRESHOLD_MINUTES) onTime += 1;
  }

  const flights = rows.length;
  // Available seat-kilometres: every flight on the route flies the same stage, so
  // this is the seat total times the one distance.
  const askPerSeat = greatCircleNm * NM_TO_KM;
  const ask = seats * askPerSeat;

  return {
    routeId,
    windowDays: WINDOW_DAYS,
    flights,
    seats,
    passengers,
    spilledPassengers,
    loadFactor: seats > 0 ? passengers / seats : null,
    revenueMinor,
    costMinor,
    netMinor,
    raskMinor: ask > 0 ? revenueMinor / ask : null,
    caskMinor: ask > 0 ? costMinor / ask : null,
    onTimePct: flights > 0 ? onTime / flights : null,
    avgArrivalDelayMinutes: flights > 0 ? delaySum / flights : null,
    blockHours: blockSeconds / 3600,
    trend: weeklyTrend(rows, gameNow),
  };
}

/**
 * A fixed twelve-week load-factor trend, oldest first.
 *
 * Bucketed into whole weeks back from the current game instant, so every point is
 * the same width and a week the route flew nothing is a real gap (`loadFactor`
 * null) rather than a missing point the sparkline would silently close up.
 */
function weeklyTrend(rows: readonly SettledFlight[], gameNow: Date): RoutePerformanceWeek[] {
  const seatsByWeek = new Array<number>(WEEKS).fill(0);
  const paxByWeek = new Array<number>(WEEKS).fill(0);
  const flightsByWeek = new Array<number>(WEEKS).fill(0);
  const weekMs = WEEK_DAYS * MS_PER_DAY;

  for (const row of rows) {
    const ageMs = gameNow.getTime() - row.settledAt.getTime();
    const weeksAgo = Math.floor(ageMs / weekMs);
    if (weeksAgo < 0 || weeksAgo >= WEEKS) continue;
    // `weeksAgo` counts back from now; the array is oldest-first.
    const bucket = WEEKS - 1 - weeksAgo;
    seatsByWeek[bucket]! += row.seats;
    paxByWeek[bucket]! += row.passengers;
    flightsByWeek[bucket]! += 1;
  }

  const trend: RoutePerformanceWeek[] = [];
  for (let i = 0; i < WEEKS; i += 1) {
    const weeksAgo = WEEKS - 1 - i;
    const weekStart = new Date(gameNow.getTime() - (weeksAgo + 1) * weekMs);
    const seats = seatsByWeek[i]!;
    trend.push({
      weekStart: weekStart.toISOString(),
      flights: flightsByWeek[i]!,
      loadFactor: seats > 0 ? paxByWeek[i]! / seats : null,
    });
  }
  return trend;
}
