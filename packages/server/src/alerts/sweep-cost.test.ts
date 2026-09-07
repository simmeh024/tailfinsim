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

import { sweepAirlineAlerts } from './evaluate';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * What §14.5's sweep costs, and that it does not grow with the network (PERF-01).
 *
 * The sweep runs inside every tick, for every player airline whose game-hour
 * watermark is due. So its cost is not a page load a player waits for — it is a
 * cost the whole world pays continuously, and the failure mode is a tick that
 * gets slower as the game gets bigger.
 *
 * This measures the thing rather than asserting it, exactly as BUG-07's
 * `ground/alert-query-count.test.ts` does: counting statements on the pool is
 * the only honest way to check *"a bounded number of queries"*, because a
 * wall-clock assertion would measure this machine's neighbours — which CLAUDE.md
 * is explicit is not a criterion.
 *
 * **The number is deliberately not asserted exactly.** A ceiling is what the
 * design promises; pinning the precise count would turn every legitimate
 * refactor into a failing test that says nothing about whether the sweep is
 * still bounded.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [alerts/sweep-cost.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The ceiling one airline's sweep may cost.
 *
 * The reads are a fixed set: the routes, three grouped reads over
 * `flight_result`, the runway projection, the coverage ratio, the crew
 * projection, the fleet's maintenance position, the contracts, the open alerts,
 * and the watermark write. Each of those is a handful of statements and none of
 * them is per route, per airframe or per contract.
 *
 * Measured at **25** statements on 2026-09-07, unchanged between a one-route
 * airline and a six-route one. The ceiling is set well above that on purpose:
 * what this guards is the shape — a count that starts tracking the network — not
 * the exact figure, which a legitimate refactor may move either way.
 */
const CEILING_PER_AIRLINE = 45;

describeDb('what the alert sweep costs', () => {
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

  async function makeAirport(longitude: number): Promise<string> {
    const n = sequence++;
    const icao = `P${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}${LETTERS[(n * 5) % 26]}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_410_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Sweep cost ${icao}`,
        isoCountry: 'US',
        kind: 'large_airport',
        latitude: 5,
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
      sourceId: -(9_410_000 + n),
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

  /** One route, with `flights` settled days behind it. */
  async function routeWithHistory(
    fixture: FoundedAirlineFixture,
    longitude: number,
    days: number,
  ): Promise<void> {
    const from = await makeAirport(longitude);
    const to = await makeAirport(longitude + 4);
    const opened = await openRoute(db.db, own(fixture), { originIcao: from, destinationIcao: to });
    if (!opened.ok) throw new Error(`route refused: ${JSON.stringify(opened)}`);

    const gameNow = await worldGameNow(db.db, fixture.world.id);
    for (let day = 1; day <= days; day += 1) {
      const settledAt = new Date(gameNow.getTime() - day * DAY_MS);
      const [created] = await db.db
        .insert(flight)
        .values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId: randomUUID(),
          originIcao: from,
          destinationIcao: to,
          phase: 'turnaround',
          scheduledDeparture: new Date(settledAt.getTime() - 2 * HOUR_MS),
          estimatedArrival: settledAt,
          actualDeparture: new Date(settledAt.getTime() - 2 * HOUR_MS),
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
        passengers: 120,
        spilledPassengers: 0,
        cargoKg: 0,
        revenueMinor: 800_000,
        costMinor: 400_000,
        netMinor: 400_000,
        blockSeconds: 7_200,
        arrivalDelayMinutes: 0,
        breakdown: '{}',
        settlementVersion: 'test',
        settledAt,
      });
    }
  }

  /** Statements the pool issued while `run` was in flight. */
  async function countQueries(run: () => Promise<unknown>): Promise<number> {
    const pool = db.pool as unknown as { query: (...args: unknown[]) => unknown };
    const original = pool.query.bind(pool);
    let count = 0;
    pool.query = (...args: unknown[]) => {
      count += 1;
      return original(...args);
    };
    try {
      await run();
    } finally {
      pool.query = original;
    }
    return count;
  }

  async function sweep(fixture: FoundedAirlineFixture): Promise<number> {
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    return countQueries(() =>
      sweepAirlineAlerts(db.db, own(fixture), fixture.airline.name, gameNow),
    );
  }

  it('costs the same whatever the airline flies', async () => {
    const fixture = await fixtures.create();

    await routeWithHistory(fixture, -140, 8);
    const withOne = await sweep(fixture);
    expect(withOne).toBeLessThanOrEqual(CEILING_PER_AIRLINE);

    // Five more routes, each with a week of trading behind it.
    for (const longitude of [-120, -100, -80, -60, -40]) {
      await routeWithHistory(fixture, longitude, 8);
    }

    const withSix = await sweep(fixture);
    expect(withSix).toBeLessThanOrEqual(CEILING_PER_AIRLINE);

    /*
     * The assertion that matters. Six times the network must not cost six times
     * the queries: every read behind the rules is grouped by route rather than
     * issued per route, and the two-step rival test only asks a follow-up
     * question about carriers that actually flew inside the lookback — of which
     * there are none here.
     */
    expect(withSix).toBe(withOne);
  });

  /**
   * The rival test's second step is the one thing that *is* per candidate, so
   * this is where its bound lives: one extra statement per carrier that has
   * newly flown one of the player's pairs, and none at all when nobody has.
   */
  it('asks nothing extra about rivals when none has entered', async () => {
    const fixture = await fixtures.create();
    await routeWithHistory(fixture, 40, 8);

    const quiet = await sweep(fixture);

    // A rival flying somewhere else entirely must not cost anything here.
    const rival = await fixtures.create({ worldId: fixture.world.id });
    await routeWithHistory(rival, 100, 8);

    const stillQuiet = await sweep(fixture);
    expect(stillQuiet).toBe(quiet);
  });
});
