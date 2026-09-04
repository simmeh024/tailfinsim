import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { RepeatPattern, ScheduleLegView, ScheduleView } from '@tailfin/shared';

import { flight, route, schedule, scheduleLeg } from '../db/schema';
import { loadAirportOffsets, localFromAbsolute } from '../network/airport-time';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * Reading schedules back for the network page (M2-03, §8.2).
 *
 * Owner-scoped throughout: a schedule is only ever selected within the resolved
 * airline, so another airline's rotation is not in the result set rather than
 * being filtered out of it.
 *
 * A `schedule_leg` stores its endpoints, not a `route_id` (the join is
 * deliberately deferred in the schema), so each leg is mapped back to the route
 * it flies by the unique `(airline, origin, destination)` pair. A leg whose route
 * has since been closed maps to `null` rather than inventing one.
 */

interface Header {
  id: string;
  airframeId: string;
  repeatKind: 'daily' | 'weekdays';
  repeatDays: number[] | null;
  active: boolean;
  createdAt: Date;
}

function repeatOf(header: Pick<Header, 'repeatKind' | 'repeatDays'>): RepeatPattern {
  return header.repeatKind === 'daily'
    ? { kind: 'daily' }
    : {
        kind: 'weekdays',
        days: (header.repeatDays ?? []).map((d) => d as 1 | 2 | 3 | 4 | 5 | 6 | 7),
      };
}

/** Every schedule this airline runs, oldest first, each with its legs and horizon count. */
export async function listSchedules(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<ScheduleView[]> {
  const headers: Header[] = await db
    .select({
      id: schedule.id,
      airframeId: schedule.airframeId,
      repeatKind: schedule.repeatKind,
      repeatDays: schedule.repeatDays,
      active: schedule.active,
      createdAt: schedule.createdAt,
    })
    .from(schedule)
    .where(and(eq(schedule.airlineId, own.id), eq(schedule.worldId, own.worldId)))
    .orderBy(schedule.createdAt);
  if (headers.length === 0) return [];

  const ids = headers.map((h) => h.id);
  const routeByPair = await routePairMap(db, own);

  const legs = await db
    .select({
      scheduleId: scheduleLeg.scheduleId,
      originIcao: scheduleLeg.originIcao,
      destinationIcao: scheduleLeg.destinationIcao,
      departureMinute: scheduleLeg.departureMinute,
      blockMinutes: scheduleLeg.blockMinutes,
      turnaroundMinutes: scheduleLeg.turnaroundMinutes,
    })
    .from(scheduleLeg)
    .where(inArray(scheduleLeg.scheduleId, ids))
    .orderBy(scheduleLeg.scheduleId, scheduleLeg.legIndex);

  // A stored departure is an absolute (UTC-anchor) minute; the player reads it in
  // the local time of the airport it leaves from (M3-04a).
  const offsets = await loadAirportOffsets(
    db,
    legs.map((leg) => leg.originIcao),
  );

  // Flights on the books this schedule has not yet flown — the horizon the worker
  // has rolled so far. Grouped rather than counted per schedule, which is the
  // pattern CLAUDE.md records for a correlated count that came back empty.
  const counts = new Map<string, number>();
  const countRows = await db
    .select({ scheduleId: flight.scheduleId, count: sql<number>`count(*)::int` })
    .from(flight)
    .where(and(inArray(flight.scheduleId, ids), isNull(flight.actualDeparture)))
    .groupBy(flight.scheduleId);
  for (const row of countRows) {
    if (row.scheduleId !== null) counts.set(row.scheduleId, row.count);
  }

  const legsBySchedule = new Map<string, ScheduleLegView[]>();
  for (const leg of legs) {
    const view: ScheduleLegView = {
      routeId: routeByPair.get(`${leg.originIcao}:${leg.destinationIcao}`) ?? null,
      originIcao: leg.originIcao,
      destinationIcao: leg.destinationIcao,
      departureMinute: localFromAbsolute(leg.departureMinute, offsets.get(leg.originIcao) ?? 0),
      blockMinutes: leg.blockMinutes,
      turnaroundMinutes: leg.turnaroundMinutes,
    };
    const bucket = legsBySchedule.get(leg.scheduleId);
    if (bucket === undefined) legsBySchedule.set(leg.scheduleId, [view]);
    else bucket.push(view);
  }

  return headers.map((header) => ({
    id: header.id,
    airframeId: header.airframeId,
    legs: legsBySchedule.get(header.id) ?? [],
    repeat: repeatOf(header),
    active: header.active,
    upcomingFlights: counts.get(header.id) ?? 0,
    createdAt: header.createdAt.toISOString(),
  }));
}

/** One schedule, or null if it is not this airline's. */
export async function readSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  scheduleId: string,
): Promise<ScheduleView | null> {
  const all = await listSchedules(db, own);
  return all.find((s) => s.id === scheduleId) ?? null;
}

/** `origin:destination` → routeId for this airline, for mapping legs back to routes. */
async function routePairMap(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<Map<string, string>> {
  const routes = await db
    .select({
      id: route.id,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
    })
    .from(route)
    .where(eq(route.airlineId, own.id));
  const map = new Map<string, string>();
  for (const r of routes) map.set(`${r.originIcao}:${r.destinationIcao}`, r.id);
  return map;
}
