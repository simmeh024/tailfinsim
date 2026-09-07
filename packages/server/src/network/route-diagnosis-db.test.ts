import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { RouteCompetitionResponse } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, flightResult, runway } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { openRoute } from './open-route';
import { diagnoseOwnRoute } from './route-diagnosis';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * §14.4's drill-down against real PostgreSQL (M8-11).
 *
 * The decision tree is proved without a database in
 * `packages/sim/src/statistics/route-diagnosis.test.ts`. What needs Postgres is
 * the part that feeds it: that the route's own window is read correctly, that the
 * peer median **excludes the route being diagnosed**, and that a stranger's
 * route is concealed rather than diagnosed.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [network/route-diagnosis-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describeDb('diagnosing a route', () => {
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
    const icao = `D${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}${LETTERS[(n * 11) % 26]}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_110_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Diagnosis test ${icao}`,
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
      sourceId: -(9_110_000 + n),
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
    options: {
      daysAgo: number;
      seats?: number;
      passengers: number;
      revenueMinor: number;
      costMinor: number;
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
      seats: options.seats ?? 180,
      passengers: options.passengers,
      spilledPassengers: 0,
      cargoKg: 0,
      revenueMinor: options.revenueMinor,
      costMinor: options.costMinor,
      netMinor: options.revenueMinor - options.costMinor,
      blockSeconds: 7_200,
      arrivalDelayMinutes: 0,
      breakdown: '{}',
      settlementVersion: 'test',
      settledAt,
    });
  }

  /** A market where the rivals hold `share` of the traffic between them. */
  function competition(routeId: string, share: number): RouteCompetitionResponse {
    return {
      routeId,
      marketDailyPassengers: 400,
      operators: [
        {
          airlineId: '00000000-0000-4000-8000-000000000001',
          name: 'You',
          kind: 'player',
          isYou: true,
          weeklyFrequency: 7,
          economyFareMinor: 12_000,
          share: 1 - share,
          productScore: 0.6,
        },
        {
          airlineId: '00000000-0000-4000-8000-000000000002',
          name: 'Rival',
          kind: 'npc',
          isYou: false,
          weeklyFrequency: 21,
          economyFareMinor: 10_000,
          share,
          productScore: 0.6,
        },
      ],
    };
  }

  it('names a cause and an action from the route’s own trading (AC1)', async () => {
    const fixture = await fixtures.create();
    const dear = await openPair(fixture, -100);
    // Costs 13.3¢ per seat-km offered against 12.5¢ per seat-km sold: no load
    // factor pays, so this is a cost problem however empty it is.
    await flew(fixture, dear, {
      daysAgo: 2,
      passengers: 144,
      revenueMinor: 1_800_000,
      costMinor: 2_400_000,
    });

    const found = await diagnoseOwnRoute(db.db, own(fixture), dear.routeId, null);
    expect(found).not.toBeNull();
    expect(found?.cause).toBe('cost');
    expect(found?.action).toBe('re-gauge');
    expect(found?.unfillable).toBe(true);
    expect(found?.flights).toBe(1);
    // The working comes with the answer, whichever cause won.
    expect(found?.gaps.cost.own).not.toBeNull();
  });

  it('excludes the route being diagnosed from its own benchmark', async () => {
    /*
     * **Exactly one peer**, which is what makes this discriminating. With two
     * peers the median of three values is the middle one either way, so
     * including the subject would give the same answer and the test would pass
     * against the very bug it exists to catch.
     *
     * With one peer: excluding the subject, the benchmark *is* the peer's yield;
     * including it, the benchmark is the mean of the two, which lands well below.
     */
    const fixture = await fixtures.create();
    const subject = await openPair(fixture, -60);
    const peer = await openPair(fixture, -30);

    // The subject sells at a little over a third of the peer's yield.
    await flew(fixture, subject, {
      daysAgo: 2,
      passengers: 160,
      revenueMinor: 1_000_000,
      costMinor: 1_400_000,
    });
    await flew(fixture, peer, {
      daysAgo: 2,
      passengers: 160,
      revenueMinor: 2_600_000,
      costMinor: 1_400_000,
    });

    const found = await diagnoseOwnRoute(db.db, own(fixture), subject.routeId, null);
    expect(found?.peerRoutes).toBe(1);

    const ownYield = found?.gaps.yield.own ?? 0;
    const peerYield = found?.gaps.yield.peer ?? 0;
    expect(ownYield).toBeGreaterThan(0);
    /*
     * The exact figures depend on each pair's great-circle distance, so the
     * assertion is a ratio rather than a hard-coded yield — the first version of
     * this test asserted 15.0 and got 13.54 because the two pairs are not the
     * same length. A benchmark that included the subject would sit at the mean,
     * under 2x its own, and fail here.
     */
    expect(peerYield / ownYield).toBeGreaterThan(2.2);
    expect(found?.cause).toBe('yield');
    expect(found?.action).toBe('reprice');
  });

  it('turns an under-filled route into a cut when a rival owns the market', async () => {
    const fixture = await fixtures.create();
    const thin = await openPair(fixture, 40);
    // Would pay at a normal load; it is flying a third full.
    await flew(fixture, thin, {
      daysAgo: 2,
      passengers: 60,
      revenueMinor: 750_000,
      costMinor: 1_000_000,
    });

    const alone = await diagnoseOwnRoute(
      db.db,
      own(fixture),
      thin.routeId,
      competition(thin.routeId, 0.1),
    );
    expect(alone?.cause).toBe('load_factor');
    expect(alone?.action).toBe('re-time');

    // Same numbers, different market.
    const crowded = await diagnoseOwnRoute(
      db.db,
      own(fixture),
      thin.routeId,
      competition(thin.routeId, 0.85),
    );
    expect(crowded?.cause).toBe('competitor');
    expect(crowded?.action).toBe('cut');
    expect(crowded?.rivalShare).toBeCloseTo(0.85, 6);
  });

  it('says nothing to fix on a route above the line', async () => {
    const fixture = await fixtures.create();
    const good = await openPair(fixture, 80);
    await flew(fixture, good, {
      daysAgo: 2,
      passengers: 160,
      revenueMinor: 2_400_000,
      costMinor: 1_400_000,
    });

    const found = await diagnoseOwnRoute(db.db, own(fixture), good.routeId, null);
    expect(found?.cause).toBe('none');
    expect(found?.action).toBe('keep');
    expect(found?.contributionMinor).toBe(1_000_000);
  });

  it('reads an unflown route as unflown rather than diagnosing it', async () => {
    const fixture = await fixtures.create();
    const idle = await openPair(fixture, 120);
    const found = await diagnoseOwnRoute(db.db, own(fixture), idle.routeId, null);
    // The production shape: only the worker settles a flight, so on a node
    // without one every route reads like this.
    expect(found?.flights).toBe(0);
    expect(found?.contributionMinor).toBe(0);
    expect(found?.cause).toBe('none');
  });

  it('conceals another airline’s route, and a route that is not there', async () => {
    const mine = await fixtures.create();
    const theirs = await fixtures.create({ worldId: mine.world.id });
    const theirRoute = await openPair(theirs, 150);

    expect(await diagnoseOwnRoute(db.db, own(mine), theirRoute.routeId, null)).toBeNull();
    expect(await diagnoseOwnRoute(db.db, own(mine), randomUUID(), null)).toBeNull();
  });
});
