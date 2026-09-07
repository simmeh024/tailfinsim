import { and, desc, eq, gte } from 'drizzle-orm';

import type { RouteFlightsResponse } from '@tailfin/shared';
import { gameTime, type WorldClock } from '@tailfin/sim';

import { flight, flightResult, route, world } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * The flights behind a route's figures — §14.1's route → **flight** → segment
 * rung (M8-09).
 *
 * The chain the design doc spells out was missing its middle link: load factor
 * drilled to a route, and a route drilled straight to the waterfall. This is the
 * step between, and it is the one a player actually wants — *"which of these
 * departures was empty?"* is a different question from *"who took the market?"*,
 * and only the second was answerable.
 *
 * Owner-scoped by resolution (ADR-0020): another airline's route id receives the
 * endpoint's own 404, indistinguishable from one that does not exist.
 *
 * Only the worker writes a `flight_result`, so on a node without one this
 * answers `200` with an empty list — a route that reads as unflown rather than
 * as a broken report, the same boundary `routePerformance` carries.
 */

/** The trailing window, in game days. Matches the route performance rollup. */
const WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** The flights on one of this airline's routes, most recent first, or null. */
export async function routeFlights(
  db: Database,
  own: ResolvedPlayerAirline,
  routeId: string,
  now: Date = new Date(),
): Promise<RouteFlightsResponse | null> {
  const [owned] = await db
    .select({ originIcao: route.originIcao, destinationIcao: route.destinationIcao })
    .from(route)
    .where(and(eq(route.id, routeId), eq(route.airlineId, own.id), eq(route.worldId, own.worldId)))
    .limit(1);
  if (!owned) return null;

  const [clockRow] = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, own.worldId))
    .limit(1);
  if (!clockRow) return null;
  const clock: WorldClock = {
    epoch: clockRow.epoch,
    launchDate: clockRow.launchDate,
    speedMultiplier: Number(clockRow.speedMultiplier),
  };
  const gameNow = gameTime(clock, now);

  const rows = await db
    .select({
      flightId: flightResult.flightId,
      seats: flightResult.seats,
      passengers: flightResult.passengers,
      spilledPassengers: flightResult.spilledPassengers,
      revenueMinor: flightResult.revenueMinor,
      costMinor: flightResult.costMinor,
      netMinor: flightResult.netMinor,
      arrivalDelayMinutes: flightResult.arrivalDelayMinutes,
      scheduledDeparture: flight.scheduledDeparture,
      actualDeparture: flight.actualDeparture,
    })
    .from(flightResult)
    .innerJoin(flight, eq(flight.id, flightResult.flightId))
    .where(
      and(
        eq(flightResult.airlineId, own.id),
        eq(flightResult.kind, 'scheduled'),
        gte(flightResult.settledAt, new Date(gameNow.getTime() - WINDOW_DAYS * DAY_MS)),
        eq(flight.originIcao, owned.originIcao),
        eq(flight.destinationIcao, owned.destinationIcao),
      ),
    )
    .orderBy(desc(flight.scheduledDeparture));

  return {
    routeId,
    windowDays: WINDOW_DAYS,
    gameNow: gameNow.toISOString(),
    flights: rows.map((row) => ({
      flightId: row.flightId,
      departedAt: (row.actualDeparture ?? row.scheduledDeparture).toISOString(),
      seats: row.seats,
      passengers: row.passengers,
      spilledPassengers: row.spilledPassengers,
      // Null when the aeroplane offered no seats — a freighter, not an empty
      // cabin. Zero would read as the second.
      loadFactor: row.seats > 0 ? row.passengers / row.seats : null,
      revenueMinor: row.revenueMinor,
      costMinor: row.costMinor,
      netMinor: row.netMinor,
      arrivalDelayMinutes: row.arrivalDelayMinutes,
    })),
    /*
     * The last rung. App. A's waterfall is already per **segment**, so the chain
     * §14.1 describes ends there rather than needing another endpoint: it says
     * which competitor took the passengers this flight did not carry, and why.
     */
    drillDown: {
      endpoint: '/api/routes/:routeId/waterfall',
      by: 'segment',
      label: 'the competitive waterfall',
    },
  };
}
