import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { airlineMapColour } from '@tailfin/shared';

import { airframe, airline, airlineHub, airport, flight, route } from '../db/schema';

import type { Database } from '../db/client';

/**
 * The player's own overlay on the world map (M7): their hubs and their routes,
 * positioned so the client can draw them straight onto the globe.
 *
 * World state, not reference data, so it is scoped to one airline. Routes carry
 * ICAO codes rather than airport ids, so origin and destination are each joined to
 * `airport` (by `ident`) to resolve a position; a route whose endpoint no longer
 * resolves is left out rather than drawn to nowhere. Positions are `[lon, lat]`,
 * ready for deck.gl.
 *
 * `traffic` widens that to the whole world: every *active* route flown by any
 * carrier in the same world — the player's own and the NPCs' — so the map can draw
 * a FlightRadar-style plane on each and name the airline behind it when one is
 * clicked. Each row is flagged `own` so the client can colour its own flights apart
 * from the competition's without a second request.
 */
export interface WorldHub {
  position: [number, number];
  icao: string;
  name: string;
}

export interface WorldMapRoute {
  id: string;
  source: [number, number];
  target: [number, number];
  originIcao: string;
  destinationIcao: string;
  originName: string;
  destinationName: string;
}

/** An active route flown by some carrier in the world — the basis of a plane icon. */
export interface WorldMapTrafficRoute extends WorldMapRoute {
  airlineId: string;
  airlineName: string;
  /** True for the player's own route, false for an NPC (or another player's). */
  own: boolean;
  /** The carrier's brand colour (`#RRGGBB`), for the plane/mark and its route line (M7-02). */
  colour: string;
}

/**
 * One aeroplane that is actually in the air right now (WORLD-10).
 *
 * ## Why this is not `traffic`
 *
 * `traffic` is every *active route* in the world, and the map drew one plane on
 * each of them riding a looping animation phase — whether or not an aeroplane
 * was flying that leg, or ever had. `flight.ts` said so in its own header:
 * *"not tied to real schedules yet"*.
 *
 * These are rows from `flight`, and a row is here only if it has **departed and
 * not yet arrived**. That predicate needs no phase list and no clock: a cancelled
 * flight never gets an `actual_departure`, and an arrived one has an
 * `actual_arrival`.
 *
 * ## The times are sent, not the position
 *
 * The client already runs the world's clock (`useWorldClock`) and re-renders
 * once a second. Sending a *position* would freeze every aeroplane between
 * overlay refreshes a minute apart; sending the two instants lets the browser
 * interpolate, so the fleet moves continuously and correctly at whatever speed
 * the world runs.
 *
 * All four instants are **game time**, like `world_event.fire_at`.
 */
export interface WorldMapFlight {
  id: string;
  source: [number, number];
  target: [number, number];
  originIcao: string;
  destinationIcao: string;
  originName: string;
  destinationName: string;
  airlineId: string;
  airlineName: string;
  /** True for the player's own flight, false for an NPC's (or another player's). */
  own: boolean;
  /** The carrier's brand colour, as `traffic` carries it. */
  colour: string;
  /** Registration and type, where the airframe still resolves. */
  registration: string | null;
  typeDesignation: string | null;
  /** Game time. When it was meant to go, and when it actually did. */
  scheduledDeparture: string;
  departedAt: string;
  /** Game time. The current estimate, which is what a player wants to know. */
  arrivesAt: string;
}

export interface WorldMap {
  hubs: WorldHub[];
  routes: WorldMapRoute[];
  traffic: WorldMapTrafficRoute[];
  flights: WorldMapFlight[];
}

/**
 * As many aeroplanes as are worth drawing at once.
 *
 * A mature world can have thousands airborne, and every one is an instanced quad
 * plus a row in the map's own list. The newest departures win, because they are
 * the ones with the most of their flight left to watch.
 */
const AIRBORNE_LIMIT = 500;

export async function readWorldMap(
  db: Database,
  airlineId: string,
  worldId: string,
): Promise<WorldMap> {
  const origin = alias(airport, 'origin_airport');
  const destination = alias(airport, 'destination_airport');

  const [hubRows, routeRows, trafficRows, flightRows] = await Promise.all([
    db
      .select({
        icao: airport.ident,
        name: airport.name,
        longitude: airport.longitude,
        latitude: airport.latitude,
      })
      .from(airlineHub)
      .innerJoin(airport, eq(airport.id, airlineHub.airportId))
      .where(eq(airlineHub.airlineId, airlineId)),
    db
      .select({
        id: route.id,
        originIcao: route.originIcao,
        destinationIcao: route.destinationIcao,
        originName: origin.name,
        originLon: origin.longitude,
        originLat: origin.latitude,
        destinationName: destination.name,
        destinationLon: destination.longitude,
        destinationLat: destination.latitude,
      })
      .from(route)
      .innerJoin(origin, eq(origin.ident, route.originIcao))
      .innerJoin(destination, eq(destination.ident, route.destinationIcao))
      .where(eq(route.airlineId, airlineId)),
    // Every live route in the world, whoever flies it — the traffic the map
    // animates. Scoped to the world (not the airline) and to active routes only, so
    // a paused route stops flying rather than leaving a ghost plane on the map.
    db
      .select({
        id: route.id,
        airlineId: route.airlineId,
        airlineName: airline.name,
        airlineIcao: airline.icaoCode,
        airlineLogo: airline.logo,
        originIcao: route.originIcao,
        destinationIcao: route.destinationIcao,
        originName: origin.name,
        originLon: origin.longitude,
        originLat: origin.latitude,
        destinationName: destination.name,
        destinationLon: destination.longitude,
        destinationLat: destination.latitude,
      })
      .from(route)
      .innerJoin(airline, eq(airline.id, route.airlineId))
      .innerJoin(origin, eq(origin.ident, route.originIcao))
      .innerJoin(destination, eq(destination.ident, route.destinationIcao))
      .where(and(eq(route.worldId, worldId), eq(route.active, true))),
    /*
     * The aeroplanes that are actually flying.
     *
     * Joined to `airport` on `icao_code`, which is the column `flight`'s own
     * foreign keys point at. The `airframe` join is a LEFT one because
     * `flight.airframe_id` carries no foreign key (see the schema note) — an
     * aeroplane that has been sold out from under a flight in progress should
     * leave the flight on the map without a registration, not remove it.
     */
    db
      .select({
        id: flight.id,
        airlineId: flight.airlineId,
        airlineName: airline.name,
        airlineIcao: airline.icaoCode,
        airlineLogo: airline.logo,
        originIcao: flight.originIcao,
        destinationIcao: flight.destinationIcao,
        originName: origin.name,
        originLon: origin.longitude,
        originLat: origin.latitude,
        destinationName: destination.name,
        destinationLon: destination.longitude,
        destinationLat: destination.latitude,
        registration: airframe.registration,
        typeDesignation: airframe.typeDesignation,
        scheduledDeparture: flight.scheduledDeparture,
        actualDeparture: flight.actualDeparture,
        estimatedArrival: flight.estimatedArrival,
      })
      .from(flight)
      .innerJoin(airline, eq(airline.id, flight.airlineId))
      .innerJoin(origin, eq(origin.icaoCode, flight.originIcao))
      .innerJoin(destination, eq(destination.icaoCode, flight.destinationIcao))
      .leftJoin(airframe, eq(airframe.id, flight.airframeId))
      .where(
        and(
          eq(flight.worldId, worldId),
          isNotNull(flight.actualDeparture),
          isNull(flight.actualArrival),
        ),
      )
      .orderBy(desc(flight.actualDeparture))
      .limit(AIRBORNE_LIMIT),
  ]);

  return {
    hubs: hubRows.map((row) => ({
      position: [row.longitude, row.latitude],
      icao: row.icao,
      name: row.name,
    })),
    routes: routeRows.map((row) => ({
      id: row.id,
      source: [row.originLon, row.originLat],
      target: [row.destinationLon, row.destinationLat],
      originIcao: row.originIcao ?? '',
      destinationIcao: row.destinationIcao ?? '',
      originName: row.originName,
      destinationName: row.destinationName,
    })),
    traffic: trafficRows.map((row) => ({
      id: row.id,
      source: [row.originLon, row.originLat],
      target: [row.destinationLon, row.destinationLat],
      originIcao: row.originIcao ?? '',
      destinationIcao: row.destinationIcao ?? '',
      originName: row.originName,
      destinationName: row.destinationName,
      airlineId: row.airlineId,
      airlineName: row.airlineName,
      own: row.airlineId === airlineId,
      // The carrier's brand hue, from its emblem (or a stable fallback keyed on
      // its ICAO) so even an unbranded NPC reads as itself. §H.3's "dominant colour".
      colour: airlineMapColour(row.airlineLogo, row.airlineIcao || row.airlineId),
    })),
    flights: flightRows.flatMap((row) => {
      /*
       * `actual_departure` cannot be null here — the predicate says so — but the
       * column is nullable, so the type is too. Dropping the row rather than
       * asserting keeps the impossible case honest and costs one line.
       */
      if (row.actualDeparture === null) return [];
      return [
        {
          id: row.id,
          source: [row.originLon, row.originLat] as [number, number],
          target: [row.destinationLon, row.destinationLat] as [number, number],
          originIcao: row.originIcao,
          destinationIcao: row.destinationIcao,
          originName: row.originName,
          destinationName: row.destinationName,
          airlineId: row.airlineId,
          airlineName: row.airlineName,
          own: row.airlineId === airlineId,
          colour: airlineMapColour(row.airlineLogo, row.airlineIcao || row.airlineId),
          registration: row.registration,
          typeDesignation: row.typeDesignation,
          scheduledDeparture: row.scheduledDeparture.toISOString(),
          departedAt: row.actualDeparture.toISOString(),
          arrivesAt: row.estimatedArrival.toISOString(),
        },
      ];
    }),
  };
}
