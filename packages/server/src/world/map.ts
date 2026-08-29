import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { airlineMapColour } from '@tailfin/shared';

import { airline, airlineHub, airport, route } from '../db/schema';

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

export interface WorldMap {
  hubs: WorldHub[];
  routes: WorldMapRoute[];
  traffic: WorldMapTrafficRoute[];
}

export async function readWorldMap(
  db: Database,
  airlineId: string,
  worldId: string,
): Promise<WorldMap> {
  const origin = alias(airport, 'origin_airport');
  const destination = alias(airport, 'destination_airport');

  const [hubRows, routeRows, trafficRows] = await Promise.all([
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
  };
}
