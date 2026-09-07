import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, flightResult, runway } from '../db/schema';
import { openRoute } from '../network/open-route';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { readOperationsDashboard } from './operations';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * §14.3's operational figures against real PostgreSQL (M8-12).
 *
 * Two of the three acceptance criteria are about what the *data* says, so this
 * is where they are proved:
 *
 * - **delay attributed by M2-08's taxonomy**, including the minutes nobody
 *   attributed, which must add up to the headline rather than quietly not,
 * - **spill as a count** of passengers turned away.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [statistics/operations-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describeDb('the operations dashboard', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  let sequence = 0;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  async function makeAirport(latitude: number, longitude: number): Promise<string> {
    const n = sequence++;
    const icao = `O${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}${LETTERS[(n * 7) % 26]}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_210_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Ops test ${icao}`,
        isoCountry: 'US',
        kind: 'large_airport',
        latitude,
        longitude,
        scheduledService: true,
        hasRunwayData: true,
        tier: 'large',
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${icao}`);
    madeAirports.push(created.id);
    await db.db.insert(runway).values({
      sourceId: -(9_210_000 + n),
      airportId: created.id,
      identifier: '09/27',
      lengthFt: 12_000,
      widthFt: 150,
      surface: 'asphalt',
      lighted: true,
      closed: false,
    });
    return icao;
  }

  async function openPair(
    fixture: FoundedAirlineFixture,
    longitude: number,
  ): Promise<{ from: string; to: string }> {
    const from = await makeAirport(5, longitude);
    const to = await makeAirport(5, longitude + 10);
    const opened = await openRoute(db.db, own(fixture), { originIcao: from, destinationIcao: to });
    if (!opened.ok) throw new Error(`route refused: ${JSON.stringify(opened)}`);
    return { from, to };
  }

  /** One flight, settled or cancelled, the way the worker would leave it. */
  async function flew(
    fixture: FoundedAirlineFixture,
    pair: { from: string; to: string },
    options: {
      daysAgo: number;
      passengers?: number;
      spilled?: number;
      delayMinutes?: number;
      cause?:
        | 'weather_origin'
        | 'weather_destination'
        | 'atc_flow'
        | 'technical'
        | 'crew_timeout'
        | 'ground_vendor'
        | 'airport_closure';
      cancelled?: boolean;
    },
  ): Promise<void> {
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    const settledAt = new Date(gameNow.getTime() - options.daysAgo * DAY_MS);
    const off = new Date(settledAt.getTime() - 2 * HOUR_MS);

    const [created] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId: randomUUID(),
        originIcao: pair.from,
        destinationIcao: pair.to,
        phase: options.cancelled === true ? 'scheduled' : 'turnaround',
        disruption: options.cancelled === true ? 'cancelled' : options.cause ? 'delayed' : null,
        disruptionCause: options.cause ?? null,
        scheduledDeparture: off,
        estimatedArrival: settledAt,
        actualDeparture: options.cancelled === true ? null : off,
        actualArrival: options.cancelled === true ? null : settledAt,
        load: '{}',
      })
      .returning({ id: flight.id });
    if (!created) throw new Error('flight was not created');

    // A cancelled flight never settles, so it gets no result row at all.
    if (options.cancelled === true) return;

    const passengers = options.passengers ?? 150;
    await db.db.insert(flightResult).values({
      worldId: fixture.world.id,
      flightId: created.id,
      airlineId: fixture.airline.id,
      kind: 'scheduled',
      seats: 180,
      passengers,
      spilledPassengers: options.spilled ?? 0,
      cargoKg: 2_000,
      revenueMinor: 1_800_000,
      costMinor: 1_500_000,
      netMinor: 300_000,
      blockSeconds: 7_200,
      arrivalDelayMinutes: options.delayMinutes ?? 0,
      breakdown: '{}',
      settlementVersion: 'test',
      settledAt,
    });
  }

  it('attributes delay by M2-08’s taxonomy, and names what it cannot (AC1)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -100);

    await flew(fixture, pair, { daysAgo: 2, delayMinutes: 40, cause: 'technical' });
    await flew(fixture, pair, { daysAgo: 3, delayMinutes: 25, cause: 'technical' });
    await flew(fixture, pair, { daysAgo: 4, delayMinutes: 30, cause: 'weather_origin' });
    // Late with no disruption row: a slow turn, a long taxi. Real minutes.
    await flew(fixture, pair, { daysAgo: 5, delayMinutes: 12 });
    // On time, so it contributes no delay and no cause.
    await flew(fixture, pair, { daysAgo: 6, delayMinutes: 0 });

    const ops = await readOperationsDashboard(db.db, own(fixture));
    const p = ops.punctuality;

    expect(p.totalDelayMinutes).toBe(107);
    // Worst first: the point of an attribution is to name what to fix.
    expect(p.byCause[0]).toEqual({ cause: 'technical', minutes: 65, flights: 2 });
    expect(p.byCause.map((row) => row.cause)).toEqual([
      'technical',
      'weather_origin',
      'unattributed',
    ]);

    /*
     * The property that matters: the causes add up to the headline. A dashboard
     * that dropped unattributed minutes would show a player less delay than
     * they actually suffered, and the two figures would silently disagree.
     */
    const attributed = p.byCause.reduce((total, row) => total + row.minutes, 0);
    expect(attributed).toBe(p.totalDelayMinutes);
    expect(p.byCause.find((row) => row.cause === 'unattributed')?.minutes).toBe(12);
  });

  it('reports spill as a count of passengers turned away (AC2)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -60);
    // Full aeroplanes turning people away — `flight_result` only permits spill
    // when every seat is sold, which is the honest definition.
    await flew(fixture, pair, { daysAgo: 2, passengers: 180, spilled: 40 });
    await flew(fixture, pair, { daysAgo: 3, passengers: 180, spilled: 25 });

    const ops = await readOperationsDashboard(db.db, own(fixture));
    expect(ops.traffic.spilledPassengers).toBe(65);
    // The rate is context beside the count, not instead of it.
    expect(ops.traffic.spillRate).toBeCloseTo(65 / (360 + 65), 6);
    expect(ops.traffic.passengers).toBe(360);
  });

  it('counts cancellations from the schedule, not from what settled', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -20);
    await flew(fixture, pair, { daysAgo: 2 });
    await flew(fixture, pair, { daysAgo: 3 });
    await flew(fixture, pair, { daysAgo: 4, cancelled: true });

    const ops = await readOperationsDashboard(db.db, own(fixture));
    /*
     * A cancelled flight never settles, so it has no `flight_result` row.
     * Counting only what settled would report a perfect cancellation rate on an
     * airline that cancelled everything.
     */
    expect(ops.punctuality.cancelledFlights).toBe(1);
    expect(ops.punctuality.cancellationRate).toBeCloseTo(1 / 3, 6);
    expect(ops.flights).toBe(2);
  });

  it('separates D0 from D15, which are different questions', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, 20);
    await flew(fixture, pair, { daysAgo: 2, delayMinutes: 0 });
    // Late, but inside the industry's fifteen minutes: D15 counts it, D0 does not.
    await flew(fixture, pair, { daysAgo: 3, delayMinutes: 9, cause: 'atc_flow' });
    await flew(fixture, pair, { daysAgo: 4, delayMinutes: 45, cause: 'technical' });

    const ops = await readOperationsDashboard(db.db, own(fixture));
    expect(ops.punctuality.onTimeD0).toBeCloseTo(1 / 3, 6);
    expect(ops.punctuality.onTimeD15).toBeCloseTo(2 / 3, 6);
  });

  it('reads an airline that has never flown as having flown nothing', async () => {
    const fixture = await fixtures.create();
    const ops = await readOperationsDashboard(db.db, own(fixture));

    // The production shape: only the worker settles a flight.
    expect(ops.flights).toBe(0);
    expect(ops.traffic.loadFactor).toBeNull();
    expect(ops.punctuality.onTimeD15).toBeNull();
    expect(ops.punctuality.byCause).toEqual([]);
    expect(ops.fleet.costPerBlockHourMinor).toBeNull();
    // And the figures that genuinely are zero say zero.
    expect(ops.traffic.spilledPassengers).toBe(0);
    expect(ops.fleet.airframes).toBe(0);
    // §14.3 asks for a product score; M8-04 assembles one per cabin per package,
    // so there is no airline-level figure and this says so rather than averaging.
    expect(ops.productScore).toBeNull();
    // The age profile is always present, so a client renders a table of zeroes
    // rather than an absent section.
    expect(ops.fleet.ageProfile).toHaveLength(4);
  });

  it('reads only this airline’s operation', async () => {
    const mine = await fixtures.create();
    const theirs = await fixtures.create({ worldId: mine.world.id });
    const theirPair = await openPair(theirs, 60);
    await flew(theirs, theirPair, { daysAgo: 2, spilled: 0, delayMinutes: 90, cause: 'technical' });

    const ops = await readOperationsDashboard(db.db, own(mine));
    expect(ops.flights).toBe(0);
    expect(ops.punctuality.totalDelayMinutes).toBe(0);
  });
});
