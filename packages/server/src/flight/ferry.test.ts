import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airport, flight, flightResult, worldEvent } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { createFerryFlight, ferryForRotation, locateAirframe } from './ferry';
import { arrivalKey, settleArrivedFlight } from './settle';

/**
 * A serial rather than a draw: `airport` has three unique columns and random
 * codes collide (BUG-11). The namespace keeps this suite clear of every
 * other one, which matters because vitest runs them together.
 */
const nextAirport = createAirportIdentities('flight/ferry');

/**
 * Positioning and ferry flights, against a real Postgres (M2-07).
 *
 * The fold itself is proven in `@tailfin/sim` and is not retested here. What is
 * here is the half only a database can settle:
 *
 *   - **Position is read from flights that actually moved the aircraft**, not
 *     from every row with the airframe's id on it.
 *   - **A ferry settles to all cost and no revenue**, and the row says it is a
 *     ferry — so "clearly marked as non-revenue" is true of the money, not only
 *     of the schedule.
 *   - **The database refuses a ferry that earns**, whatever path it arrives by.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [flight/ferry.test] DATABASE_URL not set — skipping ferry tests.\n');
const describeDb = url ? describe : describe.skip;

const DEPARTS = new Date('2026-08-17T06:00:00.000Z');
const ARRIVES = new Date('2026-08-17T07:15:00.000Z');
const ATR72_CRUISE_KT = 275;

describeDb('positioning and ferries', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirport(latitude: number, longitude: number): Promise<string> {
    const identity = nextAirport();
    const icao = identity.icaoCode;
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: icao,
      name: `Test Field ${icao}`,
      isoCountry: 'NL',
      kind: 'large_airport',
      latitude,
      longitude,
      scheduledService: true,
      hasRunwayData: false,
    });
    madeAirports.push(icao);
    return icao;
  }

  interface Fixture {
    worldId: string;
    airlineId: string;
    openingCashMinor: number;
    airframeId: string;
    ams: string;
    lhr: string;
    cdg: string;
  }

  async function makeWorld(): Promise<Fixture> {
    const created = await fixtures.create();

    return {
      worldId: created.world.id,
      airlineId: created.airline.id,
      openingCashMinor: created.airline.cash,
      airframeId: crypto.randomUUID(),
      ams: await makeAirport(52.3086, 4.76389),
      lhr: await makeAirport(51.4706, -0.461941),
      cdg: await makeAirport(49.0128, 2.55),
    };
  }

  /** A flight that has already happened, so it counts towards position. */
  async function flew(
    f: Fixture,
    originIcao: string,
    destinationIcao: string,
    options: { diversionIcao?: string; arrivedAt?: Date } = {},
  ): Promise<string> {
    const [row] = await db.db
      .insert(flight)
      .values({
        worldId: f.worldId,
        airlineId: f.airlineId,
        airframeId: f.airframeId,
        originIcao,
        destinationIcao,
        diversionIcao: options.diversionIcao ?? null,
        phase: 'turnaround',
        scheduledDeparture: DEPARTS,
        estimatedArrival: ARRIVES,
        actualArrival: options.arrivedAt ?? ARRIVES,
        load: '{}',
      })
      .returning({ id: flight.id });
    if (!row) throw new Error('no flight');
    return row.id;
  }

  describe('locateAirframe', () => {
    it('does not know where an aircraft is before it has been delivered or flown', async () => {
      // M4-04 owns delivery. Guessing would be worse than an absence — it would
      // let a rotation validate against a place the aircraft has never been.
      const f = await makeWorld();

      expect(await locateAirframe(db.db, f.airframeId)).toEqual({ known: false });
    });

    it('is the delivery airport before anything is flown', async () => {
      const f = await makeWorld();

      expect(await locateAirframe(db.db, f.airframeId, f.ams)).toEqual({
        known: true,
        icao: f.ams,
      });
    });

    it('follows the flights that have actually happened', async () => {
      const f = await makeWorld();
      await flew(f, f.ams, f.lhr, { arrivedAt: new Date('2026-08-17T07:00:00.000Z') });
      await flew(f, f.lhr, f.cdg, { arrivedAt: new Date('2026-08-17T10:00:00.000Z') });

      expect(await locateAirframe(db.db, f.airframeId, f.ams)).toEqual({
        known: true,
        icao: f.cdg,
      });
    });

    it('ignores a flight that has not gone yet', async () => {
      // The trap: a scheduled flight has not taken the aircraft anywhere, and
      // counting it would report the aeroplane at an airport it has not reached.
      const f = await makeWorld();
      await db.db.insert(flight).values({
        worldId: f.worldId,
        airlineId: f.airlineId,
        airframeId: f.airframeId,
        originIcao: f.ams,
        destinationIcao: f.cdg,
        phase: 'scheduled',
        scheduledDeparture: DEPARTS,
        estimatedArrival: ARRIVES,
        load: '{}',
      });

      expect(await locateAirframe(db.db, f.airframeId, f.ams)).toEqual({
        known: true,
        icao: f.ams,
      });
    });

    it('follows a diversion to where the aircraft actually landed', async () => {
      // The case that makes deriving position worth it. Planned to Heathrow,
      // landed at Charles de Gaulle — tomorrow's Heathrow rotation is impossible.
      const f = await makeWorld();
      await flew(f, f.ams, f.lhr, { diversionIcao: f.cdg });

      expect(await locateAirframe(db.db, f.airframeId, f.ams)).toEqual({
        known: true,
        icao: f.cdg,
      });
    });
  });

  describe('createFerryFlight', () => {
    it('creates a non-revenue flight and schedules its arrival', async () => {
      const f = await makeWorld();

      const outcome = await createFerryFlight(db.db, {
        worldId: f.worldId,
        airlineId: f.airlineId,
        airframeId: f.airframeId,
        fromIcao: f.ams,
        toIcao: f.lhr,
        departAt: DEPARTS,
        cruiseSpeedKt: ATR72_CRUISE_KT,
      });

      expect(outcome.status).toBe('created');
      if (outcome.status !== 'created') return;

      const [row] = await db.db.select().from(flight).where(eq(flight.id, outcome.flightId));
      expect(row?.kind).toBe('ferry');
      expect(row?.load).toBe('{}');
      expect(row?.cargoKg).toBe(0);
      expect(row?.scheduleId).toBeNull();
      // No rotation, no cycle, so no materialisation key — the case that column's
      // own note describes.
      expect(row?.materialisationKey).toBeNull();

      const events = await db.db
        .select()
        .from(worldEvent)
        .where(eq(worldEvent.idempotencyKey, arrivalKey(outcome.flightId)));
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('FLIGHT_ARRIVE');
    });

    it('reports that none is needed when the aircraft is already there', async () => {
      const f = await makeWorld();

      const outcome = await createFerryFlight(db.db, {
        worldId: f.worldId,
        airlineId: f.airlineId,
        airframeId: f.airframeId,
        fromIcao: f.ams,
        toIcao: f.ams,
        departAt: DEPARTS,
        cruiseSpeedKt: ATR72_CRUISE_KT,
      });

      expect(outcome.status).toBe('not-needed');
      const rows = await db.db.select().from(flight).where(eq(flight.worldId, f.worldId));
      expect(rows).toHaveLength(0);
    });

    it('moves the aircraft once it has arrived', async () => {
      const f = await makeWorld();
      const outcome = await createFerryFlight(db.db, {
        worldId: f.worldId,
        airlineId: f.airlineId,
        airframeId: f.airframeId,
        fromIcao: f.ams,
        toIcao: f.lhr,
        departAt: DEPARTS,
        cruiseSpeedKt: ATR72_CRUISE_KT,
      });
      if (outcome.status !== 'created') throw new Error('not created');

      await db.db.transaction((tx) => settleArrivedFlight(tx, outcome.flightId, ARRIVES));

      expect(await locateAirframe(db.db, f.airframeId, f.ams)).toEqual({
        known: true,
        icao: f.lhr,
      });
    });
  });

  describe('settling a ferry', () => {
    it('earns nothing, costs everything, and the row says it is a ferry', async () => {
      const f = await makeWorld();
      const outcome = await createFerryFlight(db.db, {
        worldId: f.worldId,
        airlineId: f.airlineId,
        airframeId: f.airframeId,
        fromIcao: f.ams,
        toIcao: f.lhr,
        departAt: DEPARTS,
        cruiseSpeedKt: ATR72_CRUISE_KT,
      });
      if (outcome.status !== 'created') throw new Error('not created');

      await db.db.transaction((tx) => settleArrivedFlight(tx, outcome.flightId, ARRIVES));

      const [result] = await db.db
        .select()
        .from(flightResult)
        .where(eq(flightResult.flightId, outcome.flightId));

      expect(result?.kind).toBe('ferry');
      expect(result?.revenueMinor).toBe(0);
      expect(result?.passengers).toBe(0);
      expect(result?.costMinor).toBeGreaterThan(0);
      expect(result?.netMinor).toBe(-(result?.costMinor ?? 0));

      // The airline paid for it. That is the point of the type.
      const [air] = await db.db
        .select({ cash: airline.cashMinor })
        .from(airline)
        .where(eq(airline.id, f.airlineId));
      expect(air?.cash).toBe(f.openingCashMinor + (result?.netMinor ?? 0));
    });

    it('is refused by the database if anything tries to book revenue on it', async () => {
      // The settlement model refuses first, but this is the row that becomes an
      // airline's cash — so it is refused underneath as well, whatever path a
      // future bug arrives by.
      const f = await makeWorld();
      const flightId = await flew(f, f.ams, f.lhr);
      await db.db.update(flight).set({ kind: 'ferry' }).where(eq(flight.id, flightId));

      let caught: unknown;
      try {
        await db.db.insert(flightResult).values({
          worldId: f.worldId,
          flightId,
          airlineId: f.airlineId,
          kind: 'ferry',
          revenueMinor: 350_000,
          costMinor: 100_000,
          netMinor: 250_000,
          seats: 70,
          passengers: 47,
          blockSeconds: 4_500,
          breakdown: '{}',
          settlementVersion: 'v1',
          settledAt: ARRIVES,
        });
      } catch (error) {
        caught = error;
      }

      // Walk the cause chain — Drizzle's wrapper message matches any failure.
      const reported: string[] = [];
      let current: unknown = caught;
      while (current instanceof Error) {
        const name = (current as { constraint?: unknown }).constraint;
        if (typeof name === 'string') reported.push(name);
        current = current.cause;
      }
      expect(reported).toContain('flight_result_ferry_earns_nothing');
    });
  });

  describe('ferryForRotation', () => {
    it('says none is needed when the aircraft is already at the start', async () => {
      const f = await makeWorld();

      expect(await ferryForRotation(db.db, f.airframeId, f.ams, f.ams)).toEqual({ needed: false });
    });

    it('names the leg that would make the rotation possible', async () => {
      // Not "no", but "not until you fly it there, and here is the leg".
      const f = await makeWorld();
      await flew(f, f.ams, f.cdg);

      expect(await ferryForRotation(db.db, f.airframeId, f.ams, f.ams)).toEqual({
        needed: true,
        fromIcao: f.cdg,
        toIcao: f.ams,
      });
    });

    it('asks for nothing when it does not know where the aircraft is', async () => {
      const f = await makeWorld();

      expect(await ferryForRotation(db.db, f.airframeId, f.ams)).toEqual({ needed: false });
    });
  });
});
