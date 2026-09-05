import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, route } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { readWorldMap } from './map';

/**
 * The aeroplanes on the world map are flights (WORLD-10).
 *
 * They used to be one per *active route*, riding a looping animation phase in
 * the browser — `readWorldMap` selected from `route` and never touched `flight`.
 * What is worth proving here is the predicate, because it is the whole of the
 * new behaviour: a row is airborne when it has **departed and not yet arrived**,
 * which needs no phase list and no clock.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [world/map.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('the aeroplanes on the world map', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const identities = createAirportIdentities('world/map');
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirport(name: string): Promise<{ icao: string }> {
    const identity = identities();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `${name} ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'large_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);
    return { icao: identity.icaoCode };
  }

  /**
   * One flight, with whatever departure and arrival the case needs.
   *
   * The airframe id is a bare uuid: `flight.airframe_id` carries no foreign key,
   * and the map's join to `airframe` is a LEFT one precisely so a flight whose
   * aeroplane no longer resolves still appears — without a registration rather
   * than not at all.
   */
  async function bookFlight(
    fixture: FoundedAirlineFixture,
    legs: { from: string; to: string },
    times: { departed: Date | null; arrived: Date | null },
  ): Promise<string> {
    const scheduled = new Date(fixture.world.epoch);
    const arrival = new Date(scheduled.getTime() + 2 * 60 * 60 * 1000);
    const [created] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId: '00000000-0000-4000-8000-000000000001',
        originIcao: legs.from,
        destinationIcao: legs.to,
        scheduledDeparture: scheduled,
        actualDeparture: times.departed,
        estimatedArrival: arrival,
        actualArrival: times.arrived,
      })
      .returning({ id: flight.id });
    if (!created) throw new Error('flight was not created');
    return created.id;
  }

  it('returns a flight that has departed and not yet arrived', async () => {
    const fixture = await fixtures.create();
    const from = await makeAirport('Origin');
    const to = await makeAirport('Destination');
    const departed = new Date(new Date(fixture.world.epoch).getTime() + 5 * 60 * 1000);
    const id = await bookFlight(
      fixture,
      { from: from.icao, to: to.icao },
      {
        departed,
        arrived: null,
      },
    );

    const map = await readWorldMap(db.db, fixture.airline.id, fixture.world.id);

    expect(map.flights.map((f) => f.id)).toEqual([id]);
    const [airborne] = map.flights;
    expect(airborne?.own).toBe(true);
    expect(airborne?.originIcao).toBe(from.icao);
    expect(airborne?.departedAt).toBe(departed.toISOString());
    // The times are sent rather than a position, so the browser can fly the
    // aeroplane between overlay refreshes a minute apart.
    expect(airborne?.arrivesAt).toBeDefined();
    // No airframe row behind that id, and the flight still appears.
    expect(airborne?.registration).toBeNull();
  });

  it('leaves out a flight that has not left the gate', async () => {
    const fixture = await fixtures.create();
    const from = await makeAirport('Origin');
    const to = await makeAirport('Destination');
    await bookFlight(fixture, { from: from.icao, to: to.icao }, { departed: null, arrived: null });

    const map = await readWorldMap(db.db, fixture.airline.id, fixture.world.id);

    // A cancelled flight is the same case and needs no separate rule: it never
    // receives an `actual_departure`.
    expect(map.flights).toHaveLength(0);
  });

  it('leaves out a flight that has landed', async () => {
    const fixture = await fixtures.create();
    const from = await makeAirport('Origin');
    const to = await makeAirport('Destination');
    const epoch = new Date(fixture.world.epoch).getTime();
    await bookFlight(
      fixture,
      { from: from.icao, to: to.icao },
      { departed: new Date(epoch + 5 * 60 * 1000), arrived: new Date(epoch + 2 * 60 * 60 * 1000) },
    );

    const map = await readWorldMap(db.db, fixture.airline.id, fixture.world.id);

    expect(map.flights).toHaveLength(0);
  });

  it('does not show one world’s aeroplanes to another', async () => {
    const mine = await fixtures.create();
    const theirs = await fixtures.create();
    const from = await makeAirport('Origin');
    const to = await makeAirport('Destination');
    await bookFlight(
      theirs,
      { from: from.icao, to: to.icao },
      { departed: new Date(new Date(theirs.world.epoch).getTime() + 60_000), arrived: null },
    );

    const map = await readWorldMap(db.db, mine.airline.id, mine.world.id);

    // The endpoint never accepts a world id — it is resolved from the session —
    // but the query is still scoped, because the resolution is what makes that
    // safe rather than the absence of a parameter.
    expect(map.flights).toHaveLength(0);
  });

  it('still draws the network when nothing is flying it', async () => {
    // The routes are the network and are worth drawing whether or not an
    // aeroplane is on one right now — which is the permanent state of a node
    // with no worker.
    const fixture = await fixtures.create();
    const from = await makeAirport('Origin');
    const to = await makeAirport('Destination');
    await db.db.insert(route).values({
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      originIcao: from.icao,
      destinationIcao: to.icao,
      greatCircleNm: 200,
      active: true,
    });

    const map = await readWorldMap(db.db, fixture.airline.id, fixture.world.id);

    expect(map.traffic).toHaveLength(1);
    expect(map.flights).toHaveLength(0);
  });
});
