/**
 * The airport map's whole picture (M7-07, App. B.7, §H.2).
 *
 * `GET /api/airports/:icao/apron` — one read, built entirely from facts the game
 * already holds and decides money with:
 *
 *   - **`gates`** is M7-06's `GET /api/airports/:icao/gates` answer, embedded
 *     unchanged, so the map and the gates panel cannot disagree about who holds
 *     what or what a lease costs.
 *   - **`aircraft`** are the aeroplanes on the ground here, derived from `flight`
 *     rows — the same rows the world map draws airborne aeroplanes from.
 *   - **`runways`** come from the airport import; **`movements`** are the flights
 *     landing and leaving either side of now.
 *   - **`standDays`** are M7-06's own measurement of your stands — the turns its
 *     utilisation is computed from, not a second reading of the schedule.
 *
 * ## What is public, and why
 *
 * Exactly what the world map already discloses. `WorldMapFlight` names every
 * airborne aeroplane's airline, colour, registration and type to every player in
 * the world, so naming the same aeroplanes once they are on the ground adds
 * nothing; who holds each stand is public by M7-06's decision. What stays private
 * is what M7-06 kept private — a rival's stand utilisation and day — and one more
 * thing this endpoint could have leaked and does not: **a rival's flight id**.
 * `flightId` is the asking airline's next departure and null for everyone else,
 * so the map's flight panel opens only on your own aeroplanes.
 *
 * ## The picture is a worker story
 *
 * Every aeroplane, movement and turn here comes from `flight` rows that only the
 * worker produces and moves. On a node with no worker nothing ever departs or
 * arrives, so the apron is empty and the runways are quiet — which reads as a
 * quiet airport rather than as a missing process. The stands and their holders
 * are HTTP state and show everywhere.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  airlineMapColour,
  type AircraftClass,
  type ApronAircraft,
  type ApronAirline,
  type ApronMovement,
  type ApronResponse,
  type ApronRunway,
  type StandDay,
  type WingspanCode,
  type AirlineLogo,
} from '@tailfin/shared';
import {
  apronAircraftSize,
  assignApronStands,
  isHelipadIdentifier,
  runwayHeadingDegrees,
  type ApronOccupantFacts,
} from '@tailfin/sim';

import { aircraftType, airframe, airline, flight, runway } from '../db/schema';
import { worldGameNow } from '../world/game-now';

import { readMeasuredAirportPicture, type MeasuredTurn } from './gates';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/** *"Runways with live movements"*: this far either side of now, in game minutes. */
export const APRON_MOVEMENT_WINDOW_MINUTES = 30;

/** A flight can be in the air at most this long; bounds the movement query to an index range. */
const LONGEST_FLIGHT_MS = 2 * 24 * 60 * 60_000;

const MINUTE_MS = 60_000;

interface AirlineFacts {
  id: string;
  name: string;
  iataCode: string | null;
  icaoCode: string;
  logo: AirlineLogo | null;
}

/** An airline as the apron shows it — coloured exactly as the world map colours it. */
function apronAirline(row: AirlineFacts, askingId: string): ApronAirline {
  return {
    airlineId: row.id,
    name: row.name,
    iataCode: row.iataCode,
    // `world/map.ts`'s own call, argument for argument, so a carrier's planes are
    // the same colour on the globe and on the apron.
    colour: airlineMapColour(row.logo, row.icaoCode || row.id),
    isYou: row.id === askingId,
  };
}

/* -- Runways ------------------------------------------------------------------ */

async function runwaysAt(db: Database, airportId: string): Promise<ApronRunway[]> {
  const rows = await db
    .select({ identifier: runway.identifier, lengthFt: runway.lengthFt, widthFt: runway.widthFt })
    .from(runway)
    // A closed runway is still geography, but the map draws where aeroplanes land.
    .where(and(eq(runway.airportId, airportId), eq(runway.closed, false)));

  return rows
    .filter((row) => row.identifier.trim().length > 0 && !isHelipadIdentifier(row.identifier))
    .map((row) => ({
      ident: row.identifier.trim(),
      lengthFt: row.lengthFt !== null && row.lengthFt > 0 ? row.lengthFt : null,
      widthFt: row.widthFt !== null && row.widthFt > 0 ? row.widthFt : null,
      headingDeg: runwayHeadingDegrees(row.identifier),
    }))
    .sort((a, b) => (b.lengthFt ?? 0) - (a.lengthFt ?? 0) || a.ident.localeCompare(b.ident));
}

/* -- The aeroplanes on the ground ------------------------------------------ */

interface CatalogueFacts {
  class: AircraftClass;
  family: string;
  wingspanCode: WingspanCode;
}

/** Every type in the catalogue versions the aeroplanes here were built under. */
async function catalogueFor(
  db: Database,
  versions: readonly string[],
): Promise<Map<string, { type: CatalogueFacts; siblings: CatalogueFacts[] }>> {
  const byKey = new Map<string, { type: CatalogueFacts; siblings: CatalogueFacts[] }>();
  if (versions.length === 0) return byKey;

  const rows = await db
    .select({
      catalogueVersion: aircraftType.catalogueVersion,
      designation: aircraftType.designation,
      class: aircraftType.class,
      family: aircraftType.family,
      baseSpec: aircraftType.baseSpec,
    })
    .from(aircraftType)
    .where(inArray(aircraftType.catalogueVersion, [...new Set(versions)]));

  const byVersion = new Map<string, CatalogueFacts[]>();
  const facts = rows.map((row) => {
    let wingspanCode: WingspanCode = 'C';
    try {
      const spec = JSON.parse(row.baseSpec) as { wingspanCode?: WingspanCode };
      if (spec.wingspanCode !== undefined) wingspanCode = spec.wingspanCode;
    } catch {
      // An unparseable spec is the catalogue's problem, not the map's: draw it mid-sized.
    }
    const type: CatalogueFacts = {
      class: row.class as AircraftClass,
      family: row.family,
      wingspanCode,
    };
    byVersion.set(row.catalogueVersion, [...(byVersion.get(row.catalogueVersion) ?? []), type]);
    return {
      key: `${row.catalogueVersion}|${row.designation}`,
      version: row.catalogueVersion,
      type,
    };
  });
  for (const row of facts) {
    byKey.set(row.key, { type: row.type, siblings: byVersion.get(row.version) ?? [] });
  }
  return byKey;
}

interface OnGround {
  key: string;
  airframeId: string;
  airline: AirlineFacts;
  registration: string;
  typeDesignation: string;
  catalogueVersion: string;
  arrivedAt: Date;
  next: { flightId: string; departsAt: Date; destinationIcao: string } | null;
}

/**
 * Every aeroplane on the ground here, whoever flies it.
 *
 * On the ground means: the airframe's **most recent departed flight arrived
 * here** — at its destination, or here by diversion — and nothing has departed
 * since. That needs no phase list and no clock, for the reason the world map's
 * airborne predicate needs none: a departure stamps `actual_departure` and an
 * arrival stamps `actual_arrival`, and the latest of an airframe's departures
 * says where it is.
 *
 * An airframe that has never flown is **not** here, even at its delivery
 * airport: the contract keys an aeroplane by the flight that brought it, and a
 * delivery is not a flight. The fleet page still shows it where it was delivered.
 *
 * The latest-departure scan reads the world's departed flights once per request.
 * Fine at the world sizes the game runs today; an index on `(airframe_id,
 * actual_departure)` is the fix if it ever is not.
 */
async function aircraftOnGround(db: Database, worldId: string, icao: string): Promise<OnGround[]> {
  const latest = db
    .selectDistinctOn([flight.airframeId], {
      id: flight.id,
      airframeId: flight.airframeId,
      airlineId: flight.airlineId,
      destinationIcao: flight.destinationIcao,
      diversionIcao: flight.diversionIcao,
      actualArrival: flight.actualArrival,
    })
    .from(flight)
    .where(and(eq(flight.worldId, worldId), isNotNull(flight.actualDeparture)))
    .orderBy(flight.airframeId, desc(flight.actualDeparture), desc(flight.id))
    .as('latest');

  const rows = await db
    .select({
      key: latest.id,
      airframeId: latest.airframeId,
      arrivedAt: latest.actualArrival,
      airlineId: airline.id,
      airlineName: airline.name,
      airlineIata: airline.iataCode,
      airlineIcao: airline.icaoCode,
      airlineLogo: airline.logo,
      registration: airframe.registration,
      typeDesignation: airframe.typeDesignation,
      catalogueVersion: airframe.catalogueVersion,
    })
    .from(latest)
    .innerJoin(airline, eq(airline.id, latest.airlineId))
    // INNER: an aeroplane that no longer exists is not standing anywhere.
    .innerJoin(airframe, and(eq(airframe.id, latest.airframeId), eq(airframe.worldId, worldId)))
    .where(
      and(
        isNotNull(latest.actualArrival),
        sql`coalesce(${latest.diversionIcao}, ${latest.destinationIcao}) = ${icao}`,
      ),
    );

  const onGround = rows.flatMap((row) =>
    row.arrivedAt === null
      ? []
      : [
          {
            ...row,
            arrivedAt:
              row.arrivedAt instanceof Date ? row.arrivedAt : new Date(String(row.arrivedAt)),
          },
        ],
  );
  if (onGround.length === 0) return [];

  /*
   * Each one's next departure from here: the earliest flight it is scheduled to
   * fly out of this airport that has not gone yet and was not cancelled, and not
   * one from before it landed — a leg it never flew is history, not a plan.
   */
  const pending = await db
    .select({
      airframeId: flight.airframeId,
      id: flight.id,
      scheduledDeparture: flight.scheduledDeparture,
      destinationIcao: flight.destinationIcao,
    })
    .from(flight)
    .where(
      and(
        eq(flight.worldId, worldId),
        eq(flight.originIcao, icao),
        isNull(flight.actualDeparture),
        or(isNull(flight.disruption), ne(flight.disruption, 'cancelled')),
        inArray(
          flight.airframeId,
          onGround.map((row) => row.airframeId),
        ),
      ),
    )
    .orderBy(asc(flight.scheduledDeparture), asc(flight.id));

  // The first one at or after the landing, per airframe. Filtered here rather
  // than with DISTINCT ON, so a stale leg from before it landed cannot hide the
  // real next one behind it.
  const arrivedOf = new Map(onGround.map((row) => [row.airframeId, row.arrivedAt.getTime()]));
  const nextOf = new Map<string, (typeof pending)[number]>();
  for (const row of pending) {
    if (nextOf.has(row.airframeId)) continue;
    if (row.scheduledDeparture.getTime() < (arrivedOf.get(row.airframeId) ?? 0)) continue;
    nextOf.set(row.airframeId, row);
  }

  return onGround.map((row) => {
    const next = nextOf.get(row.airframeId);
    return {
      key: row.key,
      airframeId: row.airframeId,
      airline: {
        id: row.airlineId,
        name: row.airlineName,
        iataCode: row.airlineIata,
        icaoCode: row.airlineIcao,
        logo: row.airlineLogo,
      },
      registration: row.registration,
      typeDesignation: row.typeDesignation,
      catalogueVersion: row.catalogueVersion,
      arrivedAt: row.arrivedAt,
      next:
        next === undefined
          ? null
          : {
              flightId: next.id,
              departsAt: next.scheduledDeparture,
              destinationIcao: next.destinationIcao,
            },
    };
  });
}

/* -- Movements ----------------------------------------------------------------- */

/**
 * Landings and take-offs within {@link APRON_MOVEMENT_WINDOW_MINUTES} of now.
 *
 * The actual instant where there is one, and the estimate or the schedule for a
 * movement still due — a cancelled flight never moves and is left out. An
 * arrival counts where the aeroplane actually came down, so a diversion here
 * lands here and one diverted away does not.
 */
async function movementsAt(
  db: Database,
  worldId: string,
  icao: string,
  gameNow: Date,
  askingId: string,
): Promise<ApronMovement[]> {
  const from = new Date(gameNow.getTime() - APRON_MOVEMENT_WINDOW_MINUTES * MINUTE_MS);
  const until = new Date(gameNow.getTime() + APRON_MOVEMENT_WINDOW_MINUTES * MINUTE_MS);
  const arrivalAt = sql<Date>`coalesce(${flight.actualArrival}, ${flight.estimatedArrival})`;
  const departureAt = sql<Date>`coalesce(${flight.actualDeparture}, ${flight.scheduledDeparture})`;
  const landsAt = sql<string>`coalesce(${flight.diversionIcao}, ${flight.destinationIcao})`;
  const operator = alias(airline, 'movement_airline');

  const rows = await db
    .select({
      id: flight.id,
      originIcao: flight.originIcao,
      landsAt,
      arrivalAt,
      departureAt,
      airlineId: operator.id,
      airlineName: operator.name,
      airlineIata: operator.iataCode,
      airlineIcao: operator.icaoCode,
      airlineLogo: operator.logo,
      typeDesignation: airframe.typeDesignation,
    })
    .from(flight)
    .innerJoin(operator, eq(operator.id, flight.airlineId))
    .leftJoin(airframe, eq(airframe.id, flight.airframeId))
    .where(
      and(
        eq(flight.worldId, worldId),
        // An index range first: nothing that lands or leaves in the window
        // was scheduled to depart more than a long flight before it.
        gte(flight.scheduledDeparture, new Date(from.getTime() - LONGEST_FLIGHT_MS)),
        lte(flight.scheduledDeparture, until),
        or(isNull(flight.disruption), ne(flight.disruption, 'cancelled')),
        or(
          and(sql`${landsAt} = ${icao}`, sql`${arrivalAt} between ${from} and ${until}`),
          and(eq(flight.originIcao, icao), sql`${departureAt} between ${from} and ${until}`),
        ),
      ),
    );

  const instant = (at: Date | string): Date => (at instanceof Date ? at : new Date(String(at)));
  const within = (at: Date) => at.getTime() >= from.getTime() && at.getTime() <= until.getTime();

  const movements: (ApronMovement & { id: string })[] = [];
  for (const row of rows) {
    const airline = apronAirline(
      {
        id: row.airlineId,
        name: row.airlineName,
        iataCode: row.airlineIata,
        icaoCode: row.airlineIcao,
        logo: row.airlineLogo,
      },
      askingId,
    );
    const lands = instant(row.arrivalAt);
    if (row.landsAt === icao && within(lands)) {
      movements.push({
        id: row.id,
        kind: 'arrival',
        at: lands.toISOString(),
        airline,
        typeDesignation: row.typeDesignation,
        otherIcao: row.originIcao,
      });
    }
    const leaves = instant(row.departureAt);
    if (row.originIcao === icao && within(leaves)) {
      movements.push({
        id: row.id,
        kind: 'departure',
        at: leaves.toISOString(),
        airline,
        typeDesignation: row.typeDesignation,
        otherIcao: row.landsAt,
      });
    }
  }

  return movements
    .sort(
      (a, b) =>
        a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
    )
    .map(({ id: _id, ...movement }) => movement);
}

/* -- Your stands' days --------------------------------------------------------- */

function standTurnOf(turn: MeasuredTurn): StandDay['turns'][number] {
  return {
    arrivedAt: turn.arrivedAt.toISOString(),
    // The measured interval's own length, anchored on the real arrival: these
    // are the minutes the utilisation beside it counted, overnight included.
    departsAt: new Date(turn.arrivedAt.getTime() + (turn.off - turn.on) * MINUTE_MS).toISOString(),
    registration: turn.registration,
    fromIcao: turn.fromIcao,
    toIcao: turn.toIcao,
  };
}

/* -- The whole picture -------------------------------------------------------- */

/**
 * `GET /api/airports/:icao/apron` for this airline, or null if there is no such
 * airport.
 *
 * `now` is the wall-clock instant the world's game time is read at — injectable
 * for tests, and the only real-time read on this path. Everything else is read
 * at that one game instant.
 */
export async function readApron(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  now: Date = new Date(),
): Promise<ApronResponse | null> {
  const gameNow = await worldGameNow(db, own.worldId, now);
  const picture = await readMeasuredAirportPicture(db, own, icao, gameNow);
  if (picture === null) return null;
  const air = picture.airport;

  const [youRows, runways, onGround, movements] = await Promise.all([
    db
      .select({
        id: airline.id,
        name: airline.name,
        iataCode: airline.iataCode,
        icaoCode: airline.icaoCode,
        logo: airline.logo,
      })
      .from(airline)
      .where(eq(airline.id, own.id))
      .limit(1),
    runwaysAt(db, air.id),
    aircraftOnGround(db, own.worldId, air.icao),
    movementsAt(db, own.worldId, air.icao, gameNow, own.id),
  ]);
  const youRow = youRows[0];
  if (youRow === undefined) throw new Error(`Airline ${own.id} vanished while reading its apron`);

  const catalogue = await catalogueFor(
    db,
    onGround.map((row) => row.catalogueVersion),
  );
  const typeOf = (row: OnGround) => catalogue.get(`${row.catalogueVersion}|${row.typeDesignation}`);

  /*
   * Your own aeroplanes carry the stand M7-06's measurement put their current
   * turn on, so the picture and the gate's rotation agree about who is where.
   */
  const measuredStandOf = new Map<string, string>();
  for (const [position, turns] of picture.turnsByPosition) {
    for (const turn of turns) measuredStandOf.set(turn.arrivingFlightId, position);
  }

  const occupants: ApronOccupantFacts[] = onGround.map((row) => ({
    key: row.key,
    airlineId: row.airline.id,
    arrivedAt: row.arrivedAt.getTime(),
    departsAt: row.next?.departsAt.getTime() ?? null,
    freighter: typeOf(row)?.type.class === 'freighter',
    measuredPosition: row.airline.id === own.id ? (measuredStandOf.get(row.key) ?? null) : null,
  }));
  const standOf = assignApronStands(
    picture.gates.stands.map((stand) => ({
      position: stand.position,
      kind: stand.kind,
      holders: stand.holders.map((holder) => ({
        airlineId: holder.airlineId,
        contract: holder.contract,
      })),
    })),
    occupants,
    gameNow.getTime(),
  );

  const aircraft: ApronAircraft[] = onGround
    .map((row) => {
      const known = typeOf(row);
      return {
        key: row.key,
        airline: apronAirline(row.airline, own.id),
        registration: row.registration,
        typeDesignation: row.typeDesignation,
        // A type the catalogue no longer lists is drawn mid-sized rather than dropped.
        size:
          known === undefined
            ? ('narrowbody' as const)
            : apronAircraftSize(known.type, known.siblings),
        standPosition: standOf.get(row.key) ?? null,
        arrivedAt: row.arrivedAt.toISOString(),
        departsAt: row.next?.departsAt.toISOString() ?? null,
        nextDestinationIcao: row.next?.destinationIcao ?? null,
        // Yours only. A rival's flight id would open a panel onto somebody
        // else's operation, which the world map has never disclosed.
        flightId: row.airline.id === own.id ? (row.next?.flightId ?? null) : null,
      };
    })
    .sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt) || a.key.localeCompare(b.key));

  const standDays: StandDay[] = picture.gates.stands.flatMap((stand) => {
    if (stand.yourContract === null || stand.utilisation === null) return [];
    return [
      {
        position: stand.position,
        turns: (picture.turnsByPosition.get(stand.position) ?? []).map(standTurnOf),
        utilisation: stand.utilisation,
      },
    ];
  });

  return {
    icao: air.icao,
    name: air.name,
    tier: picture.gates.tier,
    gameNow: gameNow.toISOString(),
    you: apronAirline(youRow, own.id),
    gates: picture.gates,
    runways,
    aircraft,
    movements,
    standDays,
  };
}
