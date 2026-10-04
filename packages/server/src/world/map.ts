import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { airlineMapColour } from '@tailfin/shared';

import {
  airframe,
  airline,
  airlineHub,
  airport,
  flight,
  flightResult,
  route,
  schedule,
  scheduleLeg,
} from '../db/schema';
import { OPERATIONS_WINDOW_DAYS } from '../statistics/operations';

import { worldGameNow } from './game-now';

import type { Database } from '../db/client';

/**
 * The player's own overlay on the world map (M7): their hubs and their routes,
 * positioned so the client can draw them straight onto the globe.
 *
 * World state, not reference data, so it is scoped to one airline. Routes and
 * flights carry ICAO codes rather than airport ids, so origin and destination are
 * each joined to `airport` to resolve a position; a route whose endpoint no longer
 * resolves is left out rather than drawn to nowhere. Positions are `[lon, lat]`,
 * ready for deck.gl.
 *
 * ## Joined on `icao_code`, answered in `ident`
 *
 * Those are two different columns and the difference bit. `route.origin_icao` and
 * `flight.origin_icao` both have foreign keys to **`airport.icao_code`**, so that
 * is the only column they can be joined on — this used to join routes on `ident`,
 * which matches only where the two happen to be equal, and silently dropped every
 * route through an airport where they are not. A database test now holds that
 * line.
 *
 * The *answer* carries `ident`, because that is what `readWorldAirports` sends
 * the client as an airport's code and what `airline_hub` resolves to here. One
 * vocabulary in the payload, so the map can match a route to the dot it is drawn
 * through; `icao_code` is nullable and `ident` is not, which settles which of the
 * two the client should be speaking.
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

/**
 * One of the player's own routes, with what App. H.3 draws it by.
 *
 * > *Thickness — weekly frequency. Opacity — load factor, busy routes glow,
 * > weak ones fade. Dashed — seasonal or suspended.* — §H.3
 *
 * M7-03 shipped the line and deferred these three, because the payload carried
 * none of them. Schedules and settled flights have existed since; this is the
 * read that puts them on the line. The owner's own figures only — the rivals'
 * `traffic` rows carry none of this, and the competition panel is where a
 * rival's frequency is shown, through its own disclosure rules.
 */
export interface WorldMapOwnRoute extends WorldMapRoute {
  /** False for a paused route, which the map draws dashed. */
  active: boolean;
  /**
   * Departures a week on this directed leg, from the airline's active schedules:
   * each leg of a rotation flies once per run, and a rotation runs on each of
   * its repeat days (seven for `daily`). A rule rather than a count of
   * materialised flights, so it is right on a node with no worker, where no
   * flight is ever materialised. Zero for a route nothing is scheduled on.
   */
  weeklyFrequency: number;
  /**
   * Passengers over seats on the leg's settled scheduled flights in the last
   * {@link LOAD_FACTOR_WINDOW_DAYS} game days, or null when none settled — a
   * new route, or any route on a node with no worker. Null is "unknown", not
   * zero: an empty aeroplane and an unflown route are different things to fade.
   */
  loadFactor: number | null;
}

/**
 * The load-factor window, in game days: the operations dashboard's.
 *
 * The same thirty days the network load factor on that dashboard and the route
 * diagnosis are measured over, so a line that fades here is fading by the
 * number the player can look up there.
 */
export const LOAD_FACTOR_WINDOW_DAYS = OPERATIONS_WINDOW_DAYS;

const DAYS_PER_WEEK = 7;
const MS_PER_DAY = 86_400_000;

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
  routes: WorldMapOwnRoute[];
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
  now: Date = new Date(),
): Promise<WorldMap> {
  const origin = alias(airport, 'origin_airport');
  const destination = alias(airport, 'destination_airport');
  const gameNow = await worldGameNow(db, worldId, now);
  const loadSince = new Date(gameNow.getTime() - LOAD_FACTOR_WINDOW_DAYS * MS_PER_DAY);

  const [hubRows, routeRows, trafficRows, flightRows, legRows, loadRows] = await Promise.all([
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
        originCode: route.originIcao,
        destinationCode: route.destinationIcao,
        active: route.active,
        originIdent: origin.ident,
        destinationIdent: destination.ident,
        originName: origin.name,
        originLon: origin.longitude,
        originLat: origin.latitude,
        destinationName: destination.name,
        destinationLon: destination.longitude,
        destinationLat: destination.latitude,
      })
      .from(route)
      .innerJoin(origin, eq(origin.icaoCode, route.originIcao))
      .innerJoin(destination, eq(destination.icaoCode, route.destinationIcao))
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
        originIdent: origin.ident,
        destinationIdent: destination.ident,
        originName: origin.name,
        originLon: origin.longitude,
        originLat: origin.latitude,
        destinationName: destination.name,
        destinationLon: destination.longitude,
        destinationLat: destination.latitude,
      })
      .from(route)
      .innerJoin(airline, eq(airline.id, route.airlineId))
      .innerJoin(origin, eq(origin.icaoCode, route.originIcao))
      .innerJoin(destination, eq(destination.icaoCode, route.destinationIcao))
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
        originIdent: origin.ident,
        destinationIdent: destination.ident,
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
    // Every leg of the airline's active rotations, with how often it runs — the
    // weekly frequency is folded from these below, per directed airport pair.
    db
      .select({
        originCode: scheduleLeg.originIcao,
        destinationCode: scheduleLeg.destinationIcao,
        repeatKind: schedule.repeatKind,
        repeatDays: schedule.repeatDays,
      })
      .from(scheduleLeg)
      .innerJoin(schedule, eq(schedule.id, scheduleLeg.scheduleId))
      .where(
        and(
          eq(schedule.airlineId, airlineId),
          eq(schedule.worldId, worldId),
          eq(schedule.active, true),
        ),
      ),
    /*
     * Seats and passengers per directed pair over the window, as one grouped
     * query. `sum` of an integer column is a bigint, which the driver returns as
     * a string — so the type says string and the fold below converts.
     */
    db
      .select({
        originCode: flight.originIcao,
        destinationCode: flight.destinationIcao,
        seats: sql<string>`sum(${flightResult.seats})`,
        passengers: sql<string>`sum(${flightResult.passengers})`,
      })
      .from(flightResult)
      .innerJoin(flight, eq(flight.id, flightResult.flightId))
      .where(
        and(
          eq(flightResult.airlineId, airlineId),
          eq(flightResult.worldId, worldId),
          eq(flightResult.kind, 'scheduled'),
          gte(flightResult.settledAt, loadSince),
        ),
      )
      .groupBy(flight.originIcao, flight.destinationIcao),
  ]);

  /** Schedule legs and flights store `icao_code`, so that is the key — not `ident`. */
  const pairKey = (from: string, to: string): string => `${from}>${to}`;
  const weekly = new Map<string, number>();
  for (const leg of legRows) {
    const runs = leg.repeatKind === 'daily' ? DAYS_PER_WEEK : (leg.repeatDays?.length ?? 0);
    const key = pairKey(leg.originCode, leg.destinationCode);
    weekly.set(key, (weekly.get(key) ?? 0) + runs);
  }
  const loadFactors = new Map<string, number>();
  for (const row of loadRows) {
    const seats = Number(row.seats);
    if (seats > 0) {
      loadFactors.set(pairKey(row.originCode, row.destinationCode), Number(row.passengers) / seats);
    }
  }

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
      originIcao: row.originIdent,
      destinationIcao: row.destinationIdent,
      originName: row.originName,
      destinationName: row.destinationName,
      active: row.active,
      weeklyFrequency: weekly.get(pairKey(row.originCode, row.destinationCode)) ?? 0,
      loadFactor: loadFactors.get(pairKey(row.originCode, row.destinationCode)) ?? null,
    })),
    traffic: trafficRows.map((row) => ({
      id: row.id,
      source: [row.originLon, row.originLat],
      target: [row.destinationLon, row.destinationLat],
      originIcao: row.originIdent,
      destinationIcao: row.destinationIdent,
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
          originIcao: row.originIdent,
          destinationIcao: row.destinationIdent,
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
