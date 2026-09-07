import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { NM_TO_KM } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, flightResult, runway } from '../db/schema';
import { openRoute } from '../network/open-route';
import { routeFlights } from '../network/route-flights';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { readMetricBreakdown, readStatistics } from './metrics';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * §14's metrics against real PostgreSQL, and M8-09's three acceptance criteria.
 *
 * The arithmetic is proved without a database in
 * `packages/sim/src/statistics/`. What needs Postgres is the part the sim cannot
 * see: that the rollup reads the right flights, that the windows and the buckets
 * agree, and — the one that matters most — that §14.1's chain is **walkable**
 * rather than merely declared. `drilldown.test.ts` proves the endpoints exist;
 * this one follows them with real data in them.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [statistics/statistics-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describeDb('the statistics API', () => {
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

  /** An airport with one long open runway, so a route can actually be opened. */
  async function makeAirport(latitude: number, longitude: number): Promise<string> {
    const n = sequence++;
    const icao = `S${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}${LETTERS[(n * 5) % 26]}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_960_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Stats test ${icao}`,
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
      sourceId: -(8_960_000 + n),
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

  /** A short domestic pair, opened as a route the airline owns. */
  async function openPair(
    fixture: FoundedAirlineFixture,
    longitude: number,
  ): Promise<{ routeId: string; from: string; to: string; greatCircleNm: number }> {
    const from = await makeAirport(5, longitude);
    const to = await makeAirport(5, longitude + 10);
    const opened = await openRoute(db.db, own(fixture), {
      originIcao: from,
      destinationIcao: to,
    });
    if (!opened.ok) throw new Error(`route refused: ${JSON.stringify(opened)}`);
    return { routeId: opened.routeId, from, to, greatCircleNm: opened.greatCircleNm };
  }

  /**
   * One settled flight, written directly.
   *
   * Only the worker settles a flight and driving a whole tick per sector would
   * make this suite about the engine. What the rollup reads is `flight_result`
   * joined to `flight`, so writing those two rows is the same input the worker
   * would have produced — and the settlement arithmetic has its own tests.
   */
  async function flew(
    fixture: FoundedAirlineFixture,
    pair: { from: string; to: string },
    options: {
      daysAgo: number;
      seats?: number;
      passengers?: number;
      spilled?: number;
      cargoKg?: number;
      revenueMinor?: number;
      costMinor?: number;
      delayMinutes?: number;
    },
  ): Promise<void> {
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    const settledAt = new Date(gameNow.getTime() - options.daysAgo * DAY_MS);
    const off = new Date(settledAt.getTime() - 2 * HOUR_MS);
    const seats = options.seats ?? 180;
    const passengers = options.passengers ?? 144;

    const [created] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId: randomUUID(),
        originIcao: pair.from,
        destinationIcao: pair.to,
        phase: 'turnaround',
        scheduledDeparture: off,
        estimatedArrival: settledAt,
        actualDeparture: off,
        actualArrival: settledAt,
        load: '{}',
      })
      .returning({ id: flight.id });
    if (!created) throw new Error('flight was not created');

    await db.db.insert(flightResult).values({
      worldId: fixture.world.id,
      flightId: created.id,
      airlineId: fixture.airline.id,
      kind: 'scheduled',
      seats,
      passengers,
      spilledPassengers: options.spilled ?? 0,
      cargoKg: options.cargoKg ?? 0,
      revenueMinor: options.revenueMinor ?? 1_800_000,
      costMinor: options.costMinor ?? 1_500_000,
      netMinor: (options.revenueMinor ?? 1_800_000) - (options.costMinor ?? 1_500_000),
      blockSeconds: 7_200,
      arrivalDelayMinutes: options.delayMinutes ?? 0,
      breakdown: '{}',
      settlementVersion: 'test',
      settledAt,
    });
  }

  it('reads every metric §14.3 names, with all three horizons (AC2)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -100);
    // Enough days for the projection to have something to fit through.
    for (let day = 1; day <= 12; day += 1) {
      await flew(fixture, pair, { daysAgo: day, passengers: 130 + day });
    }

    const stats = await readStatistics(db.db, own(fixture));
    const byId = new Map(stats.metrics.map((metric) => [metric.id, metric]));

    // §14.3's named unit economics, all present and all real.
    for (const id of ['rask', 'cask', 'yield', 'rpk', 'ask', 'rtk', 'breakeven_load_factor']) {
      expect(byId.has(id as never), id).toBe(true);
    }

    const lf = byId.get('load_factor');
    expect(lf?.value).toBeGreaterThan(0.7);
    expect(lf?.value).toBeLessThan(0.85);
    // §14.2's three trend windows, and each one against the window before it.
    expect(lf?.trends.map((trend) => trend.days)).toEqual([7, 30, 90]);

    /*
     * AC2: *"Forecasts return a band, never a single number."* Twelve days of
     * flying is enough to fit a line, so every horizon comes back — and every
     * one of them brackets its own projection.
     */
    expect(lf?.forecasts.length).toBeGreaterThan(0);
    for (const band of lf?.forecasts ?? []) {
      expect(band.low).toBeLessThanOrEqual(band.mid);
      expect(band.mid).toBeLessThanOrEqual(band.high);
      // A load factor cannot exceed 1. That is arithmetic, not uncertainty.
      expect(band.high).toBeLessThanOrEqual(1);
      expect(band.low).toBeGreaterThanOrEqual(0);
    }
  });

  it('measures per kilometre, from the route’s own distance', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -60);
    await flew(fixture, pair, {
      daysAgo: 1,
      seats: 100,
      passengers: 80,
      revenueMinor: 1_000_000,
      costMinor: 800_000,
    });

    const stats = await readStatistics(db.db, own(fixture));
    const byId = new Map(stats.metrics.map((metric) => [metric.id, metric]));
    const km = pair.greatCircleNm * NM_TO_KM;

    expect(byId.get('ask')?.value).toBeCloseTo(100 * km, 4);
    expect(byId.get('rpk')?.value).toBeCloseTo(80 * km, 4);
    expect(byId.get('rask')?.value).toBeCloseTo(1_000_000 / (100 * km), 8);
    expect(byId.get('yield')?.value).toBeCloseTo(1_000_000 / (80 * km), 8);
    // The identity, against real rows: RASK is yield times load factor.
    expect(byId.get('rask')?.value).toBeCloseTo(
      (byId.get('yield')?.value ?? 0) * (byId.get('load_factor')?.value ?? 0),
      8,
    );
  });

  it('walks §14.1’s chain: load factor → route → flight → waterfall (AC3)', async () => {
    const fixture = await fixtures.create();
    const busy = await openPair(fixture, -40);
    const quiet = await openPair(fixture, -20);
    await flew(fixture, busy, { daysAgo: 2, passengers: 170 });
    await flew(fixture, busy, { daysAgo: 3, passengers: 168 });
    await flew(fixture, quiet, { daysAgo: 2, passengers: 40 });

    // Rung one: the metric says where to go.
    const stats = await readStatistics(db.db, own(fixture));
    const lf = stats.metrics.find((metric) => metric.id === 'load_factor');
    expect(lf?.drillDown.by).toBe('route');

    // Rung two: the routes behind it, each with its own next step.
    const breakdown = await readMetricBreakdown(db.db, own(fixture), 'load_factor', 'route');
    expect(breakdown).not.toBeNull();
    expect(breakdown?.rows).toHaveLength(2);
    const rows = breakdown?.rows ?? [];
    // A share is null for a ratio: five routes' load factors do not add up to
    // the airline's, and a share column would be a confident wrong number.
    expect(rows[0]?.share).toBeNull();
    const quietRow = rows.find((row) => row.key === quiet.routeId);
    expect(quietRow?.value).toBeCloseTo(40 / 180, 6);
    expect(quietRow?.drillDown?.endpoint).toBe('/api/routes/:routeId/flights');

    // Rung three: the flights behind one route.
    const flights = await routeFlights(db.db, own(fixture), busy.routeId);
    expect(flights?.flights).toHaveLength(2);
    expect(flights?.flights[0]?.loadFactor).toBeCloseTo(170 / 180, 6);

    // Rung four: the waterfall, which is already the segment view.
    expect(flights?.drillDown.endpoint).toBe('/api/routes/:routeId/waterfall');
    expect(flights?.drillDown.by).toBe('segment');
  });

  it('ranks a breakdown by contribution, biggest first', async () => {
    const fixture = await fixtures.create();
    const big = await openPair(fixture, 0);
    const small = await openPair(fixture, 20);
    await flew(fixture, big, { daysAgo: 1, revenueMinor: 9_000_000, costMinor: 1_000_000 });
    await flew(fixture, small, { daysAgo: 1, revenueMinor: 1_100_000, costMinor: 1_000_000 });

    const breakdown = await readMetricBreakdown(db.db, own(fixture), 'operating_profit', 'route');
    expect(breakdown?.rows[0]?.key).toBe(big.routeId);
    // Additive, so a share means something and the two must add to one.
    const shares = (breakdown?.rows ?? []).map((row) => row.share ?? 0);
    expect(shares.reduce((total, share) => total + share, 0)).toBeCloseTo(1, 6);
  });

  it('conceals another airline’s route, and refuses a metric that does not exist', async () => {
    const mine = await fixtures.create();
    const theirs = await fixtures.create({ worldId: mine.world.id });
    const theirRoute = await openPair(theirs, 40);

    // ADR-0020: a route that is not mine is indistinguishable from one that is
    // not there.
    expect(await routeFlights(db.db, own(mine), theirRoute.routeId)).toBeNull();
    expect(await routeFlights(db.db, own(mine), randomUUID())).toBeNull();

    // A dimension this build cannot produce is refused rather than answered
    // empty — an empty breakdown reads as "this figure has no causes".
    expect(await readMetricBreakdown(db.db, own(mine), 'load_factor', 'hub')).toBeNull();
  });

  it('reads an airline that has never flown as unmeasured, not as zero', async () => {
    const fixture = await fixtures.create();
    const stats = await readStatistics(db.db, own(fixture));
    const byId = new Map(stats.metrics.map((metric) => [metric.id, metric]));

    /*
     * The production trap, stated as a test. Only the worker writes a
     * `flight_result`, so on a node without one every ratio here is null. Null
     * rather than zero is what lets a client say "nothing has flown" instead of
     * "you earned nothing per seat".
     */
    expect(byId.get('load_factor')?.value).toBeNull();
    expect(byId.get('rask')?.value).toBeNull();
    expect(byId.get('breakeven_load_factor')?.value).toBeNull();
    // Volume and money are genuinely zero, which is a different statement.
    expect(byId.get('ask')?.value).toBe(0);
    expect(byId.get('revenue')?.value).toBe(0);
    // And no forecast at all, rather than a flat line through nothing.
    expect(byId.get('load_factor')?.forecasts).toEqual([]);
  });

  it('keeps a flight outside the window out of the window', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, 60);
    await flew(fixture, pair, { daysAgo: 2, passengers: 180 });
    // Inside the 90-day trend, outside the 30-day headline.
    await flew(fixture, pair, { daysAgo: 45, passengers: 18 });

    const stats = await readStatistics(db.db, own(fixture));
    const lf = stats.metrics.find((metric) => metric.id === 'load_factor');
    expect(lf?.value).toBeCloseTo(1, 6);
    const ninety = lf?.trends.find((trend) => trend.days === 90);
    expect(ninety?.value).toBeCloseTo(198 / 360, 6);
    // Route-scoped reads use the same 30-day window as the headline.
    const flights = await routeFlights(db.db, own(fixture), pair.routeId);
    expect(flights?.flights).toHaveLength(1);
  });
});
