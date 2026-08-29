import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { airlineHub, airport, route } from '../db/schema';

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

export interface WorldMap {
  hubs: WorldHub[];
  routes: WorldMapRoute[];
}

export async function readWorldMap(db: Database, airlineId: string): Promise<WorldMap> {
  const origin = alias(airport, 'origin_airport');
  const destination = alias(airport, 'destination_airport');

  const [hubRows, routeRows] = await Promise.all([
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
  };
}
