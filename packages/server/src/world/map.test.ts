import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, flightResult, route, schedule, scheduleLeg } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { worldGameNow } from './game-now';
import { LOAD_FACTOR_WINDOW_DAYS, readWorldMap } from './map';

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

  async function makeAirport(name: string): Promise<{ icao: string; ident: string }> {
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
    return { icao: identity.icaoCode, ident: identity.ident };
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
    // Joined on `icao_code` — the column the foreign key names — and answered in
    // `ident`, which is what the client calls an airport's code everywhere else.
    expect(airborne?.originIcao).toBe(from.ident);
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

  it('says how often, how full and whether each own route flies (§H.3)', async () => {
    /*
     * Thickness is weekly frequency, opacity is load factor, dashed is
     * suspended. M7-03 deferred all three because this payload carried none of
     * them; the frequency is folded from active schedules, the load factor from
     * settled scheduled flights over the dashboard's window.
     */
    const fixture = await fixtures.create();
    const worldId = fixture.world.id;
    const airlineId = fixture.airline.id;
    const from = await makeAirport('Origin');
    const to = await makeAirport('Destination');
    const elsewhere = await makeAirport('Elsewhere');
    const leg = { worldId, airlineId, greatCircleNm: 200 };
    await db.db.insert(route).values([
      { ...leg, originIcao: from.icao, destinationIcao: to.icao, active: true },
      { ...leg, originIcao: to.icao, destinationIcao: from.icao, active: true },
      { ...leg, originIcao: from.icao, destinationIcao: elsewhere.icao, active: false },
    ]);

    // A daily out-and-back, and a Monday-Wednesday-Friday one on the same pair:
    // ten departures a week each way. A paused rotation on the pair must not count.
    const rotation = async (
      repeat: { kind: 'daily' } | { kind: 'weekdays'; days: number[] },
      active = true,
    ): Promise<void> => {
      const [created] = await db.db
        .insert(schedule)
        .values({
          worldId,
          airlineId,
          airframeId: '00000000-0000-4000-8000-000000000002',
          repeatKind: repeat.kind,
          repeatDays: repeat.kind === 'daily' ? null : repeat.days,
          active,
        })
        .returning({ id: schedule.id });
      if (!created) throw new Error('schedule was not created');
      await db.db.insert(scheduleLeg).values([
        {
          scheduleId: created.id,
          legIndex: 0,
          originIcao: from.icao,
          destinationIcao: to.icao,
          departureMinute: 480,
          blockMinutes: 60,
          turnaroundMinutes: 45,
        },
        {
          scheduleId: created.id,
          legIndex: 1,
          originIcao: to.icao,
          destinationIcao: from.icao,
          departureMinute: 585,
          blockMinutes: 60,
          turnaroundMinutes: 45,
        },
      ]);
    };
    await rotation({ kind: 'daily' });
    await rotation({ kind: 'weekdays', days: [1, 3, 5] });
    await rotation({ kind: 'daily' }, false);

    // Two settled flights out inside the window, 80 and 60 of 100 seats: 0.7. A
    // third, older than the window and empty, would drag that down if counted.
    const now = new Date();
    const gameNow = await worldGameNow(db.db, worldId, now);
    const settle = async (daysAgo: number, passengers: number): Promise<void> => {
      const departed = new Date(gameNow.getTime() - daysAgo * 86_400_000);
      const arrived = new Date(departed.getTime() + 60 * 60 * 1000);
      const id = await bookFlight(fixture, { from: from.icao, to: to.icao }, { departed, arrived });
      await db.db.insert(flightResult).values({
        worldId,
        flightId: id,
        airlineId,
        revenueMinor: passengers * 10_000,
        costMinor: 500_000,
        netMinor: passengers * 10_000 - 500_000,
        seats: 100,
        passengers,
        blockSeconds: 3_600,
        breakdown: '{}',
        settlementVersion: 'test',
        settledAt: arrived,
      });
    };
    await settle(2, 80);
    await settle(5, 60);
    await settle(LOAD_FACTOR_WINDOW_DAYS + 5, 0);

    const map = await readWorldMap(db.db, airlineId, worldId, now);
    const find = (a: { ident: string }, b: { ident: string }) =>
      map.routes.find((r) => r.originIcao === a.ident && r.destinationIcao === b.ident);

    const out = find(from, to);
    expect(out?.active).toBe(true);
    expect(out?.weeklyFrequency).toBe(10);
    expect(out?.loadFactor).toBeCloseTo(0.7, 6);

    // Flown just as often, and nothing has settled on it: unknown, not zero.
    const back = find(to, from);
    expect(back?.weeklyFrequency).toBe(10);
    expect(back?.loadFactor).toBeNull();

    const paused = find(from, elsewhere);
    expect(paused?.active).toBe(false);
    expect(paused?.weeklyFrequency).toBe(0);
    expect(paused?.loadFactor).toBeNull();
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
    // A test airport's `ident` and `icao_code` deliberately differ, which is how
    // this caught the join reading the wrong one: a route stored against
    // `icao_code` was matched against `ident` and silently vanished.
    expect(map.traffic[0]?.originIcao).toBe(from.ident);
    expect(map.flights).toHaveLength(0);
  });
});
