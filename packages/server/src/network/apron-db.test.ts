import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApronResponse } from '@tailfin/shared';

import { acquireAircraft } from '../aircraft/acquisition';
import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, runway } from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import { worldGameNow } from '../world/game-now';

import { readApron } from './apron';
import { leaseStand, readAirportGates } from './gates';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * The airport map's picture against a real database (M7-07, App. B.7).
 *
 * The display rule has its own tests in `@tailfin/sim` (`route/apron.test.ts`).
 * What only Postgres can answer is the reading of `flight` rows: which
 * aeroplanes are on the ground (landed here, not left since — a diversion here
 * included), which are airborne or gone, what a rival's aeroplane discloses and
 * what it does not, and that your stands' days are M7-06's own measurement.
 *
 * Every instant is derived from the world's game clock read at an injected
 * `now` — never from a literal date, which has expired twice in this repository.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [network/apron-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const nextAirport = createAirportIdentities('network/apron-db');
const MINUTE = 60_000;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('the airport map', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirport(
    tier: 'medium' | 'large' = 'medium',
  ): Promise<{ id: string; icao: string; ident: string }> {
    const identity = nextAirport();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Apron Field ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'large_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: true,
        tier,
        slotLevel: 2,
        utcOffsetMinutes: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);
    return { id: created.id, icao: identity.icaoCode, ident: identity.ident };
  }

  async function fund(fixture: FoundedAirlineFixture): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 2_000_000_000,
        cause: 'admin_adjustment',
        reference: `apron-topup-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  /** An aeroplane the airline really holds, delivered somewhere. */
  async function aeroplane(
    fixture: FoundedAirlineFixture,
    type: string,
    deliveredTo: string,
  ): Promise<{ id: string; registration: string }> {
    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: type,
        deliveryAirportIcao: deliveredTo,
      },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) {
      throw new Error(`acquisition refused: ${acquired.ok ? 'no airframe' : acquired.kind}`);
    }
    return { id: acquired.airframe.id, registration: acquired.airframe.registration };
  }

  interface Leg {
    fixture: FoundedAirlineFixture;
    airframeId: string;
    from: string;
    to: string;
    /** Game time, from the world's own clock. */
    departs: Date;
    arrives: Date;
    departed?: boolean;
    arrived?: boolean;
    diversionIcao?: string;
    cancelled?: boolean;
  }

  async function fly(leg: Leg): Promise<string> {
    const [created] = await db.db
      .insert(flight)
      .values({
        worldId: leg.fixture.world.id,
        airlineId: leg.fixture.airline.id,
        airframeId: leg.airframeId,
        originIcao: leg.from,
        destinationIcao: leg.to,
        diversionIcao: leg.diversionIcao ?? null,
        scheduledDeparture: leg.departs,
        estimatedArrival: leg.arrives,
        actualDeparture: leg.departed === true ? leg.departs : null,
        actualArrival: leg.arrived === true ? leg.arrives : null,
        disruption: leg.cancelled === true ? 'cancelled' : leg.diversionIcao ? 'diverted' : null,
        phase: leg.arrived === true ? 'turnaround' : leg.departed === true ? 'cruise' : 'scheduled',
      })
      .returning({ id: flight.id });
    if (!created) throw new Error('flight was not created');
    return created.id;
  }

  /** Lease a stand at the price the server quotes. */
  async function lease(
    fixture: FoundedAirlineFixture,
    icao: string,
    position: string,
  ): Promise<void> {
    const gates = await readAirportGates(db.db, own(fixture), icao);
    const fee = gates?.stands.find((stand) => stand.position === position)?.annualFeeMinor
      .preferential;
    if (fee === undefined) throw new Error(`no stand ${position}`);
    const leased = await leaseStand(db.db, own(fixture), icao, {
      position,
      contract: 'preferential',
      expectedAnnualFeeMinor: fee,
    });
    if (!leased.ok) throw new Error(`lease refused: ${leased.problem}`);
  }

  it('shows who is on the ground, and not who is airborne, gone or never flew', async () => {
    const here = await makeAirport();
    const away = await makeAirport();
    const elsewhere = await makeAirport();
    const us = await fixtures.create({ hubIdent: here.ident });
    const rival = await fixtures.create({ worldId: us.world.id });
    await fund(us);
    await fund(rival);

    const now = new Date();
    const gameNow = await worldGameNow(db.db, us.world.id, now);
    const at = (minutes: number) => new Date(gameNow.getTime() + minutes * MINUTE);

    // Ours, on the ground: landed twenty minutes ago, leaving in forty.
    const parked = await aeroplane(us, 'ATR 72-600', away.icao);
    const landed = await fly({
      fixture: us,
      airframeId: parked.id,
      from: away.icao,
      to: here.icao,
      departs: at(-100),
      arrives: at(-20),
      departed: true,
      arrived: true,
    });
    const nextLeg = await fly({
      fixture: us,
      airframeId: parked.id,
      from: here.icao,
      to: away.icao,
      departs: at(40),
      arrives: at(120),
    });

    // Ours, airborne towards here: not on the ground yet.
    const inbound = await aeroplane(us, 'ATR 72-600', away.icao);
    await fly({
      fixture: us,
      airframeId: inbound.id,
      from: away.icao,
      to: here.icao,
      departs: at(-30),
      arrives: at(50),
      departed: true,
    });

    // Ours, been and gone: landed here, then left again.
    const gone = await aeroplane(us, 'ATR 72-600', away.icao);
    await fly({
      fixture: us,
      airframeId: gone.id,
      from: away.icao,
      to: here.icao,
      departs: at(-300),
      arrives: at(-220),
      departed: true,
      arrived: true,
    });
    await fly({
      fixture: us,
      airframeId: gone.id,
      from: here.icao,
      to: away.icao,
      departs: at(-60),
      arrives: at(20),
      departed: true,
    });

    // Ours, diverted here on its way somewhere else: it is standing here.
    const diverted = await aeroplane(us, 'ATR 72-600', away.icao);
    const divertedLeg = await fly({
      fixture: us,
      airframeId: diverted.id,
      from: away.icao,
      to: elsewhere.icao,
      diversionIcao: here.icao,
      departs: at(-200),
      arrives: at(-90),
      departed: true,
      arrived: true,
    });

    // Delivered here and never flown: not drawn — it has no flight that brought it.
    await aeroplane(us, 'ATR 72-600', here.icao);

    // The rival's, on the ground, leaving in ten minutes.
    const theirs = await aeroplane(rival, 'A320neo', away.icao);
    const theirLanding = await fly({
      fixture: rival,
      airframeId: theirs.id,
      from: away.icao,
      to: here.icao,
      departs: at(-150),
      arrives: at(-45),
      departed: true,
      arrived: true,
    });
    await fly({
      fixture: rival,
      airframeId: theirs.id,
      from: here.icao,
      to: elsewhere.icao,
      departs: at(10),
      arrives: at(100),
    });

    const apron = ApronResponse.parse(await readApron(db.db, own(us), here.icao, now));
    expect(apron.gameNow).toBe(gameNow.toISOString());
    expect(apron.you.isYou).toBe(true);
    expect(apron.you.airlineId).toBe(us.airline.id);

    expect(apron.aircraft.map((row) => row.key).sort()).toEqual(
      [landed, divertedLeg, theirLanding].sort(),
    );

    const ours = apron.aircraft.find((row) => row.key === landed);
    expect(ours).toMatchObject({
      registration: parked.registration,
      typeDesignation: 'ATR 72-600',
      size: 'regional',
      arrivedAt: at(-20).toISOString(),
      departsAt: at(40).toISOString(),
      nextDestinationIcao: away.icao,
      flightId: nextLeg,
    });
    expect(ours?.airline.isYou).toBe(true);

    // The rival's aeroplane is public — airline, colour, registration, type and
    // its next departure — and its flight id is not.
    const rivals = apron.aircraft.find((row) => row.key === theirLanding);
    expect(rivals).toMatchObject({
      registration: theirs.registration,
      typeDesignation: 'A320neo',
      size: 'narrowbody',
      departsAt: at(10).toISOString(),
      nextDestinationIcao: elsewhere.icao,
      flightId: null,
    });
    expect(rivals?.airline).toMatchObject({ airlineId: rival.airline.id, isYou: false });
    expect(rivals?.airline.colour).toMatch(/^#[0-9a-f]{6}$/);

    // A diversion that nobody has planned onward from: parked, no departure.
    const divertedHere = apron.aircraft.find((row) => row.key === divertedLeg);
    expect(divertedHere).toMatchObject({
      departsAt: null,
      nextDestinationIcao: null,
      flightId: null,
    });

    // Every aeroplane drawn somewhere, and no two on one stand.
    const positions = apron.aircraft.map((row) => row.standPosition);
    expect(positions.every((position) => position !== null)).toBe(true);
    expect(new Set(positions).size).toBe(positions.length);
    // The parked diversion is off the contact gates.
    expect(divertedHere?.standPosition).toMatch(/^[PR]/);

    // Live movements, ±30 game minutes: ours landed 20 ago, the rival leaves in
    // 10. Ours leaving in 40, the inbound due in 50, and the old ones are not.
    expect(apron.movements.map((row) => [row.kind, row.at])).toEqual([
      ['arrival', at(-20).toISOString()],
      ['departure', at(10).toISOString()],
    ]);
    expect(apron.movements[1]).toMatchObject({
      typeDesignation: 'A320neo',
      otherIcao: elsewhere.icao,
      airline: { airlineId: rival.airline.id, isYou: false },
    });
  });

  it('leaves a cancelled flight off the runways and keeps a stale leg from hiding the next', async () => {
    const here = await makeAirport();
    const away = await makeAirport();
    const us = await fixtures.create({ hubIdent: here.ident });
    await fund(us);

    const now = new Date();
    const gameNow = await worldGameNow(db.db, us.world.id, now);
    const at = (minutes: number) => new Date(gameNow.getTime() + minutes * MINUTE);

    const plane = await aeroplane(us, 'ATR 72-600', away.icao);
    await fly({
      fixture: us,
      airframeId: plane.id,
      from: away.icao,
      to: here.icao,
      departs: at(-200),
      arrives: at(-120),
      departed: true,
      arrived: true,
    });
    // A leg it was meant to fly before it ever got here — history, not a plan.
    await fly({
      fixture: us,
      airframeId: plane.id,
      from: here.icao,
      to: away.icao,
      departs: at(-400),
      arrives: at(-320),
    });
    // Cancelled, inside the movement window.
    await fly({
      fixture: us,
      airframeId: plane.id,
      from: here.icao,
      to: away.icao,
      departs: at(5),
      arrives: at(85),
      cancelled: true,
    });
    const real = await fly({
      fixture: us,
      airframeId: plane.id,
      from: here.icao,
      to: away.icao,
      departs: at(90),
      arrives: at(170),
    });

    const apron = ApronResponse.parse(await readApron(db.db, own(us), here.icao, now));
    expect(apron.movements).toEqual([]);
    expect(apron.aircraft[0]).toMatchObject({
      departsAt: at(90).toISOString(),
      flightId: real,
    });
  });

  it('lists your stands’ days from M7-06’s own measurement, and never a rival’s', async () => {
    const here = await makeAirport();
    const away = await makeAirport();
    const us = await fixtures.create({ hubIdent: here.ident });
    const rival = await fixtures.create({ worldId: us.world.id });
    await fund(us);
    await fund(rival);
    await lease(us, here.icao, 'A3');
    await lease(rival, here.icao, 'A5');

    const now = new Date();
    const gameNow = await worldGameNow(db.db, us.world.id, now);
    const at = (minutes: number) => new Date(gameNow.getTime() + minutes * MINUTE);

    const mine = await aeroplane(us, 'ATR 72-600', away.icao);
    const landed = await fly({
      fixture: us,
      airframeId: mine.id,
      from: away.icao,
      to: here.icao,
      departs: at(-100),
      arrives: at(-20),
      departed: true,
      arrived: true,
    });
    await fly({
      fixture: us,
      airframeId: mine.id,
      from: here.icao,
      to: away.icao,
      departs: at(40),
      arrives: at(120),
    });

    const theirs = await aeroplane(rival, 'ATR 72-600', away.icao);
    const theirLanding = await fly({
      fixture: rival,
      airframeId: theirs.id,
      from: away.icao,
      to: here.icao,
      departs: at(-90),
      arrives: at(-10),
      departed: true,
      arrived: true,
    });
    await fly({
      fixture: rival,
      airframeId: theirs.id,
      from: here.icao,
      to: away.icao,
      departs: at(30),
      arrives: at(110),
    });

    const apron = ApronResponse.parse(await readApron(db.db, own(us), here.icao, now));

    // Our one stand, its day and its utilisation — the gates answer's own.
    expect(apron.standDays.map((day) => day.position)).toEqual(['A3']);
    const [day] = apron.standDays;
    const stand = apron.gates.stands.find((row) => row.position === 'A3');
    expect(day?.utilisation).toEqual(stand?.utilisation);
    expect(day?.turns).toEqual([
      {
        arrivedAt: at(-20).toISOString(),
        departsAt: at(40).toISOString(),
        registration: mine.registration,
        fromIcao: away.icao,
        toIcao: away.icao,
      },
    ]);
    expect(day?.utilisation.turns).toBe(1);

    // Each aeroplane on its own airline's stand: ours where the measurement put
    // it, the rival's on the stand it leases.
    expect(apron.aircraft.find((row) => row.key === landed)?.standPosition).toBe('A3');
    expect(apron.aircraft.find((row) => row.key === theirLanding)?.standPosition).toBe('A5');

    // The rival's stand is named as theirs, and its day is not ours to see.
    expect(apron.gates.stands.find((row) => row.position === 'A5')?.utilisation).toBeNull();
    const theirView = ApronResponse.parse(await readApron(db.db, own(rival), here.icao, now));
    expect(theirView.standDays.map((row) => row.position)).toEqual(['A5']);
    expect(theirView.aircraft.find((row) => row.key === landed)?.flightId).toBeNull();
  });

  it('maps the runways the import has, and leaves out closed strips and helipads', async () => {
    const here = await makeAirport();
    const us = await fixtures.create({ hubIdent: here.ident });
    // Runway source ids are their own unique column; a fixed synthetic range,
    // negative like every test airport's, and removed with the airport.
    let sourceId = -900_000_000;
    const strip = (
      identifier: string,
      lengthFt: number | null,
      widthFt: number | null,
      closed = false,
    ) => ({
      sourceId: (sourceId -= 1),
      airportId: here.id,
      identifier,
      lengthFt,
      widthFt,
      surface: 'asphalt' as const,
      lighted: true,
      closed,
    });
    await db.db
      .insert(runway)
      .values([
        strip('09/27', 11_330, 148),
        strip('18L/36R', 12_467, 197),
        strip('04/22', 6_608, 148, true),
        strip('H1', 60, 60),
        strip('N/S', null, null),
      ]);

    const apron = ApronResponse.parse(await readApron(db.db, own(us), here.icao, new Date()));
    expect(apron.runways).toEqual([
      { ident: '18L/36R', lengthFt: 12_467, widthFt: 197, headingDeg: 180 },
      { ident: '09/27', lengthFt: 11_330, widthFt: 148, headingDeg: 90 },
      { ident: 'N/S', lengthFt: null, widthFt: null, headingDeg: null },
    ]);
  });

  it('answers null for an airport that does not exist', async () => {
    const us = await fixtures.create();
    expect(await readApron(db.db, own(us), 'ZZZZ', new Date())).toBeNull();
  });
});

describeDb('the airport map over HTTP', () => {
  const env: ServerEnv = makeAuthedTestEnv();
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];
  let icao: string;

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'apron-routes' });
    const identity = nextAirport();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Apron Route Field ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'small',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);
    icao = identity.icaoCode;
  });

  afterAll(async () => {
    await suite.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
    await db.close();
  });

  it('refuses a guest', async () => {
    const response = await suite.app.inject({ method: 'GET', url: `/api/airports/${icao}/apron` });
    expect(response.statusCode).toBe(401);
  });

  it('answers the contract, with the gates read embedded unchanged', async () => {
    const [apron, gates] = await Promise.all([
      suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        { method: 'GET', url: `/api/airports/${icao.toLowerCase()}/apron` },
      ),
      suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        { method: 'GET', url: `/api/airports/${icao}/gates` },
      ),
    ]);
    expect(apron.statusCode).toBe(200);
    const body = ApronResponse.parse(apron.json());
    expect(body.icao).toBe(icao);
    expect(body.gates).toEqual(gates.json());
    expect(body.you.airlineId).toBe(suite.airlineA.airline.id);
  });

  it('answers 404 for an airport that does not exist, as the gates route does', async () => {
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'GET', url: '/api/airports/ZZZZ/apron' },
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'not_found', message: 'No such airport' });
  });
});
