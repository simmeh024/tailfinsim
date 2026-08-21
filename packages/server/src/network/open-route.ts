/**
 * Opening a route (M2-01a, App. B.4).
 *
 * M2-01 built the seven reachability checks as a pure function and M3-09 built
 * the table a fare lives in. This is the thing that joins them: the operation
 * that turns two airport codes into a row a player can price.
 *
 * ## The refusal is the feature
 *
 * B.4 is explicit that a player is told **which** check failed and *"never a
 * generic unavailable"*, and `ReachabilityCheck` has been on the wire in
 * `@tailfin/shared` since M2-01 waiting for something to send it. A route
 * refused for range and a route refused for a curfew are different problems
 * with different fixes, and collapsing them into "cannot open" throws away the
 * only part of the answer a player can act on.
 *
 * ## Distance is the server's
 *
 * `CreateRouteInput` omits `greatCircleNm` deliberately — *"server-assigned
 * fields omitted so a client cannot supply its own distance"* — because
 * distance decides the range check, the fare floor and the block time. A client
 * that could name it could open any route and price it against any cost.
 *
 * ## What is real and what is a reference value
 *
 * The same split M3-09 states, for the same reason:
 *
 * - **Real**: position, elevation, country and longest runway, all from the
 *   OurAirports import.
 * - **Reference**: the aircraft, because there is no fleet (M4); and max
 *   wingspan code and curfew hours, because `airport` has neither (M7).
 *
 * So a route opened today is checked against real geography with a
 * representative narrowbody. The range and runway checks mean something; the
 * wingspan and curfew checks pass by construction and will start biting when
 * M7 gives airports their own limits.
 */

import { eq, inArray } from 'drizzle-orm';

import { checkReachability, haversineNm } from '@tailfin/sim';
import type { AircraftCapability, AirportCapability, Reachability } from '@tailfin/sim';

import { airline, airport, route, runway } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * A representative narrowbody, until M4's catalogue can answer.
 *
 * Deliberately the same aeroplane `economics.ts` prices against, so the route a
 * player can open is the route they are quoted a floor for. Two different
 * reference aircraft would be worse than one wrong one.
 */
export const REFERENCE_CAPABILITY: AircraftCapability = {
  rangeNm: 3_000,
  takeoffRunM: 2_100,
  wingspanCode: 'C',
  etopsMinutes: null,
};

/** Airport limits `airport` cannot supply yet (M7). */
const REFERENCE_LIMITS = {
  /** Code E admits everything up to a 777. Effectively "not modelled yet". */
  maxWingspanCode: 'E',
  /** No curfew. Real curfews are M7-04's, and B.4's check is ready for them. */
  hours: null,
} as const;

export type OpenRouteResult =
  | { ok: true; routeId: string; greatCircleNm: number }
  | { ok: false; kind: 'airline-not-active'; status: 'restricted' | 'ceased' }
  | { ok: false; kind: 'unknown-airport'; icao: string }
  | { ok: false; kind: 'same-airport' }
  | { ok: false; kind: 'duplicate' }
  | { ok: false; kind: 'unreachable'; reachability: Extract<Reachability, { ok: false }> };

interface AirportRow {
  icao: string;
  latitude: number;
  longitude: number;
  elevationFt: number | null;
  isoCountry: string;
  longestRunwayM: number;
}

/**
 * Both endpoints in one round trip, with each one's longest usable runway.
 *
 * Closed runways are excluded — a 4,000 m runway that is shut is not a runway —
 * and the length comes back in feet from OurAirports, so it is converted once,
 * here, rather than at each use.
 */
async function endpointsFor(
  db: Database,
  icaos: readonly string[],
): Promise<Map<string, AirportRow>> {
  const airports = await db
    .select({
      icao: airport.icaoCode,
      latitude: airport.latitude,
      longitude: airport.longitude,
      elevationFt: airport.elevationFt,
      isoCountry: airport.isoCountry,
    })
    .from(airport)
    .where(inArray(airport.icaoCode, [...icaos]));

  const runways = await db
    .select({
      airportIcao: airport.icaoCode,
      lengthFt: runway.lengthFt,
      closed: runway.closed,
    })
    .from(runway)
    .innerJoin(airport, eq(airport.id, runway.airportId))
    .where(inArray(airport.icaoCode, [...icaos]));

  const longest = new Map<string, number>();
  for (const r of runways) {
    if (r.closed || r.lengthFt === null || r.airportIcao === null) continue;
    const metres = r.lengthFt * 0.3048;
    longest.set(r.airportIcao, Math.max(longest.get(r.airportIcao) ?? 0, metres));
  }

  const result = new Map<string, AirportRow>();
  for (const a of airports) {
    if (a.icao === null) continue;
    result.set(a.icao, { ...a, icao: a.icao, longestRunwayM: longest.get(a.icao) ?? 0 });
  }
  return result;
}

function capabilityOf(row: AirportRow): AirportCapability {
  return {
    icao: row.icao,
    longestRunwayM: row.longestRunwayM,
    // OurAirports leaves elevation null for a few thousand fields. Sea level is
    // the optimistic assumption, and it is the right one: refusing a route
    // because a dataset has a hole would be blaming the player for our data.
    elevationFt: row.elevationFt ?? 0,
    maxWingspanCode: REFERENCE_LIMITS.maxWingspanCode,
    hours: REFERENCE_LIMITS.hours,
    countryCode: row.isoCountry,
  };
}

/**
 * Open a route for an airline, or say precisely why not.
 *
 * The airline has already been resolved from the authenticated request by
 * AIR-05's context boundary. It is not accepted from the route input, so this
 * operation cannot target somebody else's airline.
 */
export async function openRoute(
  db: Database,
  own: ResolvedPlayerAirline,
  input: { originIcao: string; destinationIcao: string },
): Promise<OpenRouteResult> {
  const originIcao = input.originIcao.trim().toUpperCase();
  const destinationIcao = input.destinationIcao.trim().toUpperCase();

  if (originIcao === destinationIcao) {
    return { ok: false, kind: 'same-airport' };
  }

  const endpoints = await endpointsFor(db, [originIcao, destinationIcao]);
  const from = endpoints.get(originIcao);
  const to = endpoints.get(destinationIcao);
  if (!from) return { ok: false, kind: 'unknown-airport', icao: originIcao };
  if (!to) return { ok: false, kind: 'unknown-airport', icao: destinationIcao };

  const greatCircleNm = haversineNm(from.latitude, from.longitude, to.latitude, to.longitude);

  const reachability = checkReachability(
    REFERENCE_CAPABILITY,
    capabilityOf(from),
    capabilityOf(to),
    {
      distanceNm: greatCircleNm,
      // A mid-morning departure and a plausible arrival. Real schedule times are
      // M2-03's and are checked there; this is the "can this pair be served at
      // all" question, not "does this particular rotation fit".
      departureMinute: 9 * 60,
      arrivalMinute: 12 * 60,
      // Overwater routing is M2-07's to compute from the path and the diversion
      // airports along it. Until then a sector is assumed never far from one,
      // which is true for the short-haul network this reference aircraft can fly.
      diversionMinutes: 0,
      hasTrafficRights: true,
      hasSlot: true,
    },
  );

  if (!reachability.ok) {
    return { ok: false, kind: 'unreachable', reachability };
  }

  return db.transaction(async (tx): Promise<OpenRouteResult> => {
    // Serialize with AIR-09 cessation. If route opening wins the lock, a
    // following cessation deactivates the new instruction; if cessation wins,
    // this recheck refuses the stale request context.
    const states = await tx
      .select({ status: airline.status })
      .from(airline)
      .where(eq(airline.id, own.id))
      .limit(1)
      .for('update');
    const status = states[0]?.status;
    if (status !== 'active') {
      if (status === 'restricted' || status === 'ceased') {
        return { ok: false, kind: 'airline-not-active', status };
      }
      throw new Error(`Resolved airline ${own.id} vanished while opening a route`);
    }

    // The unique constraint decides, not a lookup: two requests racing would
    // both pass a check-then-insert, and `route_airline_pair_key` cannot be raced.
    const inserted = await tx
      .insert(route)
      .values({
        worldId: own.worldId,
        airlineId: own.id,
        originIcao,
        destinationIcao,
        greatCircleNm,
        fares: '{}',
      })
      .onConflictDoNothing()
      .returning({ id: route.id });

    const created = inserted[0];
    if (!created) return { ok: false, kind: 'duplicate' };

    return { ok: true, routeId: created.id, greatCircleNm };
  });
}
