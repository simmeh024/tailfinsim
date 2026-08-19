import { and, eq, isNotNull, or } from 'drizzle-orm';

import {
  airframeLocation,
  ferryRequired,
  type Movement,
  computeBlockTime,
  DEFAULT_FLIGHT_PROFILE,
  type FlightProfile,
  haversineNm,
} from '@tailfin/sim';

import { airport, flight } from '../db/schema';
import { scheduleEvent } from '../sim/event-queue';

import { arrivalKey } from './settle';

import type { Database } from '../db/client';

/**
 * Positioning an aircraft, and the ferry that does it (M2-07, §7.2).
 *
 * Two questions, and the second only exists because of the first:
 *
 *   1. **Where is this airframe?** Derived from where it has flown, never stored.
 *   2. **What would it cost to start a rotation somewhere else?** A ferry: no
 *      passengers, no revenue, every cost of a real flight.
 *
 * ## Where the delivery airport comes from
 *
 * It does not, yet. M4-04 owns ordering — *"buy new: … wait weeks of real time
 * for delivery"* — and the airport an aircraft is delivered to is part of that
 * order. Until it exists there is no row to read a delivery from, so it arrives
 * as a parameter here rather than as a stub, the same way M2-04 took congestion
 * and M2-05 took cruise speed.
 *
 * What that means in practice: an airframe with no flight history has no known
 * position, and this says so rather than guessing at one. A guess would be worse
 * than an absence — it would let a rotation validate against a place the aircraft
 * has never been.
 */

/** Every flight this airframe has flown, in the order it flew them. */
async function movementsFor(db: Database, airframeId: string): Promise<Movement[]> {
  const rows = await db
    .select({
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      diversionIcao: flight.diversionIcao,
    })
    .from(flight)
    .where(
      and(
        eq(flight.airframeId, airframeId),
        // Only flights that actually moved the aircraft. A flight still sitting
        // in `scheduled` has not taken it anywhere, and counting it would report
        // the aircraft at an airport it has not reached yet — which is precisely
        // the teleportation this module exists to catch.
        or(isNotNull(flight.actualArrival), eq(flight.phase, 'turnaround')),
      ),
    )
    .orderBy(flight.actualArrival, flight.scheduledDeparture);

  return rows;
}

export type Location =
  | { known: true; icao: string }
  /** No delivery given and nothing flown — M4-04 has not put this aircraft anywhere. */
  | { known: false };

/**
 * Where an airframe is now.
 *
 * `deliveredTo` is the airport it entered the world at, from its order. Omit it
 * and the position is only knowable if the aircraft has flown; an airframe that
 * has done neither is honestly unknown.
 */
export async function locateAirframe(
  db: Database,
  airframeId: string,
  deliveredTo?: string,
): Promise<Location> {
  const movements = await movementsFor(db, airframeId);

  if (deliveredTo === undefined) {
    const last = movements.at(-1);
    if (last === undefined) return { known: false };
    return { known: true, icao: last.diversionIcao ?? last.destinationIcao };
  }

  return { known: true, icao: airframeLocation(deliveredTo, movements) };
}

export interface FerryRequest {
  worldId: string;
  airlineId: string;
  airframeId: string;
  /** Where the aircraft is. Usually {@link locateAirframe}'s answer. */
  fromIcao: string;
  /** Where it needs to be. */
  toIcao: string;
  /** Game-time off-blocks. */
  departAt: Date;
  cruiseSpeedKt: number;
  profile?: FlightProfile;
}

export type FerryOutcome =
  | { status: 'created'; flightId: string; blockMinutes: number }
  /** Already there. Not an error — the caller asked whether one was needed. */
  | { status: 'not-needed' };

/**
 * Create a ferry flight, and schedule its arrival.
 *
 * A real flight in every respect the cost model cares about: it burns fuel, pays
 * crew, accrues maintenance, and is charged a landing fee. The only difference is
 * that `kind` is `ferry`, which is what stops it ever booking revenue —
 * `settleFlight` refuses, and a check constraint refuses underneath that.
 *
 * `materialisationKey` is left null. A ferry belongs to no rotation and no cycle,
 * which is exactly the case the column's own note describes: *"null for a flight
 * that came from somewhere other than a schedule"*. The consequence is that
 * ferries are **not** deduplicated by the database, so asking for the same one
 * twice creates two — a caller that might do that should check
 * {@link locateAirframe} first, which is why this returns `not-needed` rather
 * than creating a zero-length leg.
 */
export async function createFerryFlight(
  db: Database,
  request: FerryRequest,
): Promise<FerryOutcome> {
  const { worldId, airlineId, airframeId, fromIcao, toIcao, departAt, cruiseSpeedKt } = request;

  const leg = ferryRequired(fromIcao, toIcao);
  if (leg === null) return { status: 'not-needed' };

  const ends = await db
    .select({ icao: airport.icaoCode, lat: airport.latitude, lon: airport.longitude })
    .from(airport)
    .where(or(eq(airport.icaoCode, fromIcao), eq(airport.icaoCode, toIcao)));

  const from = ends.find((a) => a.icao === fromIcao);
  const to = ends.find((a) => a.icao === toIcao);
  if (!from || !to) {
    throw new Error(`Cannot ferry: no coordinates for ${!from ? fromIcao : toIcao}`);
  }

  const distanceNm = haversineNm(from.lat, from.lon, to.lat, to.lon);
  const block = computeBlockTime(
    distanceNm,
    cruiseSpeedKt,
    request.profile ?? DEFAULT_FLIGHT_PROFILE,
  );
  const arriveAt = new Date(departAt.getTime() + block.blockMinutes * 60_000);

  const [created] = await db
    .insert(flight)
    .values({
      worldId,
      airlineId,
      airframeId,
      kind: 'ferry',
      originIcao: fromIcao,
      destinationIcao: toIcao,
      scheduledDeparture: departAt,
      estimatedArrival: arriveAt,
      // An empty cabin, stated rather than left to a default: a ferry carries
      // nobody, and `settleFlight` refuses one that claims otherwise.
      load: '{}',
      cargoKg: 0,
    })
    .returning({ id: flight.id });

  if (!created) throw new Error('Ferry flight was not created');

  await scheduleEvent(db, {
    worldId,
    type: 'FLIGHT_ARRIVE',
    fireAt: arriveAt,
    payload: { flightId: created.id },
    idempotencyKey: arrivalKey(created.id),
  });

  return { status: 'created', flightId: created.id, blockMinutes: block.blockMinutes };
}

/**
 * The ferry a rotation would need before it could run, if any.
 *
 * The question a schedule editor actually wants answered. `validateRotation`
 * says *no*; this says *not yet, and here is what it would take* — which is the
 * difference between a rule and a usable interface.
 */
export async function ferryForRotation(
  db: Database,
  airframeId: string,
  startsAtIcao: string,
  deliveredTo?: string,
): Promise<{ needed: false } | { needed: true; fromIcao: string; toIcao: string }> {
  const location = await locateAirframe(db, airframeId, deliveredTo);
  if (!location.known) return { needed: false };

  const leg = ferryRequired(location.icao, startsAtIcao);
  return leg === null
    ? { needed: false }
    : { needed: true, fromIcao: leg.originIcao, toIcao: leg.destinationIcao };
}
