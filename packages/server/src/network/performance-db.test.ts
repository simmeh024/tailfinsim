import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { gameTime, type WorldClock } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, flightResult, route, world } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { routePerformance } from './performance';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * A serial rather than a draw: `airport` has three unique columns and random
 * codes collide (BUG-11). The namespace keeps this suite clear of every
 * other one, which matters because vitest runs them together.
 */
const nextAirport = createAirportIdentities('network/performance-db');

/**
 * Rolling a route's real flights up over HTTP-shaped state (M2-06, §14.4).
 *
 * Proves the owner-scoped read and the join to `flight_result`: a route's own
 * settled flights are summed, another airline's route is a null (a 404 at the
 * boundary), and an unknown route is too. The arithmetic itself is proved without
 * a database in `performance.test.ts`. Requires `DATABASE_URL`; CI provides it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [network/performance-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY = 86_400_000;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('routePerformance', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  async function makeAirport(): Promise<string> {
    const identity = nextAirport();
    const icao = identity.icaoCode;
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: `TEST-${icao}`,
      icaoCode: icao,
      name: `Test Field ${icao}`,
      isoCountry: 'GB',
      kind: 'large_airport',
      latitude: 51.5,
      longitude: -0.1,
      scheduledService: true,
      hasRunwayData: false,
    });
    madeAirports.push(icao);
    return icao;
  }

  async function makeRoute(a: FoundedAirlineFixture, from: string, to: string): Promise<string> {
    const [row] = await db.db
      .insert(route)
      .values({
        worldId: a.world.id,
        airlineId: a.airline.id,
        originIcao: from,
        destinationIcao: to,
        greatCircleNm: 500,
      })
      .returning({ id: route.id });
    if (!row) throw new Error('no route');
    return row.id;
  }

  async function clockOf(worldId: string): Promise<WorldClock> {
    const [row] = await db.db
      .select({
        epoch: world.epoch,
        launchDate: world.launchDate,
        speedMultiplier: world.speedMultiplier,
      })
      .from(world)
      .where(eq(world.id, worldId))
      .limit(1);
    if (!row) throw new Error('no world');
    return {
      epoch: row.epoch,
      launchDate: row.launchDate,
      speedMultiplier: Number(row.speedMultiplier),
    };
  }

  /** A settled flight on `from → to`, its game-time settlement `ageDays` before now. */
  async function settleOne(
    a: FoundedAirlineFixture,
    from: string,
    to: string,
    settledAt: Date,
    fields: { seats: number; passengers: number; revenueMinor: number; costMinor: number },
  ): Promise<void> {
    const [f] = await db.db
      .insert(flight)
      .values({
        worldId: a.world.id,
        airlineId: a.airline.id,
        airframeId: crypto.randomUUID(),
        originIcao: from,
        destinationIcao: to,
        scheduledDeparture: new Date(settledAt.getTime() - 3_600_000),
        estimatedArrival: settledAt,
        actualArrival: settledAt,
      })
      .returning({ id: flight.id });
    if (!f) throw new Error('no flight');
    await db.db.insert(flightResult).values({
      worldId: a.world.id,
      flightId: f.id,
      airlineId: a.airline.id,
      revenueMinor: fields.revenueMinor,
      costMinor: fields.costMinor,
      netMinor: fields.revenueMinor - fields.costMinor,
      seats: fields.seats,
      passengers: fields.passengers,
      blockSeconds: 3_600,
      breakdown: '{}',
      settlementVersion: 'v1',
      settledAt,
    });
  }

  it('sums a route’s own settled flights over the window', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport();
    const out = await makeAirport();
    const routeId = await makeRoute(a, hub, out);

    const now = new Date();
    const gameNow = gameTime(await clockOf(a.world.id), now);
    await settleOne(a, hub, out, new Date(gameNow.getTime() - DAY), {
      seats: 180,
      passengers: 150,
      revenueMinor: 100_000,
      costMinor: 70_000,
    });
    await settleOne(a, hub, out, new Date(gameNow.getTime() - 2 * DAY), {
      seats: 180,
      passengers: 90,
      revenueMinor: 60_000,
      costMinor: 55_000,
    });

    const perf = await routePerformance(db.db, own(a), routeId, now);
    expect(perf?.flights).toBe(2);
    expect(perf?.seats).toBe(360);
    expect(perf?.passengers).toBe(240);
    expect(perf?.revenueMinor).toBe(160_000);
    expect(perf?.netMinor).toBe(35_000);
    expect(perf?.loadFactor).toBeCloseTo(240 / 360, 8);
    expect(perf?.onTimePct).toBe(1);
  });

  it('does not count the opposite direction, which is a different route', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport();
    const out = await makeAirport();
    const outbound = await makeRoute(a, hub, out);
    const now = new Date();
    const gameNow = gameTime(await clockOf(a.world.id), now);
    // A flight on out → hub; the outbound route must not see it.
    await settleOne(a, out, hub, new Date(gameNow.getTime() - DAY), {
      seats: 180,
      passengers: 150,
      revenueMinor: 100_000,
      costMinor: 70_000,
    });

    const perf = await routePerformance(db.db, own(a), outbound, now);
    expect(perf?.flights).toBe(0);
  });

  it('returns null for another airline’s route and for an unknown one', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const b = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
    const hub = await makeAirport();
    const out = await makeAirport();
    const aRoute = await makeRoute(a, hub, out);

    expect(await routePerformance(db.db, own(b), aRoute)).toBeNull();
    expect(await routePerformance(db.db, own(a), crypto.randomUUID())).toBeNull();
  });
});
