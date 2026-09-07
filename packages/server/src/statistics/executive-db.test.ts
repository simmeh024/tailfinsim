import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, flightResult, runway } from '../db/schema';
import { drawLoan } from '../finance/credit';
import { openRoute } from '../network/open-route';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { readExecutiveDashboard } from './executive';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * §14.3's Executive dashboard against real PostgreSQL (M8-10).
 *
 * Six of its nine figures are read from subsystems that already have their own
 * tests. What needs proving here is the three this module **computes**, because
 * nothing else in the game does:
 *
 * - **net worth**, on the same asset basis the lender advances against,
 * - **month to date against a band**, scaled to the days actually elapsed,
 * - **the week's movers**, ranked on the change rather than the level.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [statistics/executive-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describeDb('the executive dashboard', () => {
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
    const icao = `X${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}${LETTERS[(n * 3) % 26]}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_010_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Exec test ${icao}`,
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
      sourceId: -(9_010_000 + n),
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
  ): Promise<{ routeId: string; from: string; to: string }> {
    const from = await makeAirport(5, longitude);
    const to = await makeAirport(5, longitude + 10);
    const opened = await openRoute(db.db, own(fixture), { originIcao: from, destinationIcao: to });
    if (!opened.ok) throw new Error(`route refused: ${JSON.stringify(opened)}`);
    return { routeId: opened.routeId, from, to };
  }

  /** One settled flight, written the way the worker would leave it. */
  async function flew(
    fixture: FoundedAirlineFixture,
    pair: { from: string; to: string },
    options: { daysAgo: number; netMinor: number },
  ): Promise<void> {
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    const settledAt = new Date(gameNow.getTime() - options.daysAgo * DAY_MS);
    const off = new Date(settledAt.getTime() - 2 * HOUR_MS);
    const revenueMinor = Math.max(0, options.netMinor) + 1_000_000;
    const costMinor = revenueMinor - options.netMinor;

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
      seats: 180,
      passengers: 150,
      spilledPassengers: 0,
      cargoKg: 0,
      revenueMinor,
      costMinor,
      netMinor: options.netMinor,
      blockSeconds: 7_200,
      arrivalDelayMinutes: 0,
      breakdown: '{}',
      settlementVersion: 'test',
      settledAt,
    });
  }

  it('opens with §14.3’s figures, each carrying a rate of change (AC1)', async () => {
    const fixture = await fixtures.create();
    const dashboard = await readExecutiveDashboard(db.db, own(fixture));

    const ids = dashboard.headlines.map((headline) => headline.id);
    expect(ids).toEqual([
      'cash',
      'cash_runway',
      'net_worth',
      'mtd_profit',
      'load_factor',
      'on_time',
      'reputation',
      'credit_rating',
    ]);

    /*
     * §14.6 asks for the change on **every** headline. Absent rather than
     * present-with-`unknown` would make a tile that appears and disappears as
     * data arrives, so the trend is always there and says when it cannot compare.
     */
    for (const headline of dashboard.headlines) {
      expect(headline.trend.days, headline.id).toBeGreaterThan(0);
      expect(headline.trend.direction, headline.id).toBeTruthy();
      expect(headline.drillDown.endpoint, headline.id).toMatch(/^\/api\//);
    }
  });

  it('nets the debt off the assets, on the lender’s own basis', async () => {
    const fixture = await fixtures.create();
    const before = await readExecutiveDashboard(db.db, own(fixture));
    const netWorth = (d: typeof before) =>
      d.headlines.find((headline) => headline.id === 'net_worth')?.value ?? 0;

    // A founded airline owns no aeroplanes and owes nothing, so net worth is cash.
    expect(netWorth(before)).toBe(fixture.airline.cash);

    // Borrowing raises cash and debt by the same amount: net worth must not move.
    const drawn = await drawLoan(db.db, own(fixture), {
      instrument: 'working_capital',
      principalMinor: 20_000_000,
    });
    expect(drawn.ok).toBe(true);

    const after = await readExecutiveDashboard(db.db, own(fixture));
    expect(after.headlines.find((headline) => headline.id === 'cash')?.value).toBe(
      fixture.airline.cash + 20_000_000,
    );
    /*
     * The whole point of the figure. A dashboard that read net worth off cash
     * alone would congratulate a player for borrowing, which is precisely the
     * confusion §13 exists to prevent.
     */
    expect(netWorth(after)).toBe(netWorth(before));
  });

  it('scales the forecast to the days elapsed, not to a whole month', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -100);
    for (let day = 1; day <= 20; day += 1) {
      await flew(fixture, pair, { daysAgo: day, netMinor: 300_000 });
    }

    const dashboard = await readExecutiveDashboard(db.db, own(fixture));
    const mtd = dashboard.monthToDate;
    expect(mtd.daysElapsed).toBeGreaterThanOrEqual(0);

    if (mtd.forecastMinor !== null) {
      /*
       * A whole month's projection against six days of trading would report
       * every airline in the game as catastrophically behind plan for the first
       * three weeks of every month. The band is a daily rate, scaled.
       */
      expect(Math.abs(mtd.forecastMinor)).toBeLessThanOrEqual(
        Math.abs(300_000 * Math.max(1, mtd.daysElapsed)) * 3,
      );
      expect(mtd.forecastLowMinor).toBeLessThanOrEqual(mtd.forecastMinor);
      expect(mtd.forecastHighMinor).toBeGreaterThanOrEqual(mtd.forecastMinor);
      expect(mtd.varianceMinor).toBe(mtd.actualMinor - mtd.forecastMinor);
    }
  });

  it('ranks movers on the change, not on the level', async () => {
    const fixture = await fixtures.create();
    const steady = await openPair(fixture, -40);
    const improving = await openPair(fixture, -20);
    const sliding = await openPair(fixture, 0);

    // The best route in the network, and it was just as good last week.
    await flew(fixture, steady, { daysAgo: 2, netMinor: 5_000_000 });
    await flew(fixture, steady, { daysAgo: 9, netMinor: 5_000_000 });
    // A small route that doubled.
    await flew(fixture, improving, { daysAgo: 2, netMinor: 800_000 });
    await flew(fixture, improving, { daysAgo: 9, netMinor: 100_000 });
    // And one that fell away.
    await flew(fixture, sliding, { daysAgo: 2, netMinor: 100_000 });
    await flew(fixture, sliding, { daysAgo: 9, netMinor: 2_000_000 });

    const dashboard = await readExecutiveDashboard(db.db, own(fixture));

    // The improver leads the gainers even though it earns a fraction of what the
    // steady route does: §14.3 asks for movers, and steady is not news.
    expect(dashboard.gainers[0]?.routeId).toBe(improving.routeId);
    expect(dashboard.gainers.map((mover) => mover.routeId)).not.toContain(steady.routeId);
    expect(dashboard.losers[0]?.routeId).toBe(sliding.routeId);
    expect(dashboard.losers[0]?.changeMinor).toBeLessThan(0);
    // Each mover carries its own next rung, so the chain keeps working.
    expect(dashboard.gainers[0]?.drillDown?.endpoint).toBe('/api/routes/:routeId/flights');
  });

  it('reads an airline that has never flown without inventing anything', async () => {
    const fixture = await fixtures.create();
    // Cash moves, nothing flies.
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: -1_000_000,
        cause: 'crew_payroll',
        reference: `exec-test-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );

    const dashboard = await readExecutiveDashboard(db.db, own(fixture));
    const byId = new Map(dashboard.headlines.map((headline) => [headline.id, headline]));

    // Ratios are null — the production shape, where nothing settles at all.
    expect(byId.get('load_factor')?.value).toBeNull();
    expect(byId.get('on_time')?.value).toBeNull();
    // Money is real.
    expect(byId.get('cash')?.value).toBe(fixture.airline.cash - 1_000_000);
    // And the rating is a word, not a number forced into one.
    expect(byId.get('credit_rating')?.text).toBe(dashboard.creditTier);
    expect(byId.get('credit_rating')?.value).toBeNull();
    expect(dashboard.gainers).toEqual([]);
    expect(dashboard.losers).toEqual([]);
  });
});
