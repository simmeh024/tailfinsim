import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { gameTime, type WorldClock } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, world } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { hubConnections } from './connections';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * A serial rather than a draw: `airport` has three unique columns and random
 * codes collide (BUG-11). The namespace keeps this suite clear of every
 * other one, which matters because vitest runs them together.
 */
const nextAirport = createAirportIdentities('network/connections-db');

/**
 * The hub connection analysis over HTTP-shaped state (§7.4).
 *
 * Proves the owner-scoped read and the query that feeds the pure builder: the
 * airline's own upcoming flights at its founder hub are split into arrivals and
 * departures, another airline's flights at the same airport are not counted, and
 * a hub with nothing materialised reads as empty rather than as a failure. The
 * arithmetic itself is proved without a database in `connections.test.ts`.
 * Requires `DATABASE_URL`; CI provides it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [network/connections-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('hubConnections', () => {
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

  /** An airport with a real ICAO, so it can be a founder hub and a flight endpoint. */
  async function makeAirport(): Promise<{ icao: string; ident: string }> {
    const identity = nextAirport();
    const icao = identity.icaoCode;
    const ident = `TEST-${icao}`;
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident,
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
    return { icao, ident };
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

  /** A materialised flight from `from` to `to`, off-blocks and on at the given game instants. */
  async function makeFlight(
    a: FoundedAirlineFixture,
    from: string,
    to: string,
    departure: Date,
    arrival: Date,
  ): Promise<void> {
    await db.db.insert(flight).values({
      worldId: a.world.id,
      airlineId: a.airline.id,
      airframeId: crypto.randomUUID(),
      originIcao: from,
      destinationIcao: to,
      scheduledDeparture: departure,
      estimatedArrival: arrival,
    });
  }

  it('splits the hub’s upcoming flights into arrivals and departures and counts connections', async () => {
    const hub = await makeAirport();
    const s1 = await makeAirport();
    const s2 = await makeAirport();
    const far = await makeAirport();
    const a = await fixtures.create({ baseCountry: 'GB', hubIdent: hub.ident });

    const now = new Date();
    const gameNow = gameTime(await clockOf(a.world.id), now);
    // A day into the horizon, so every flight sits inside [gameNow, gameNow + 14d].
    const base = gameNow.getTime() + 86_400_000;
    const at = (minutes: number): Date => new Date(base + minutes * 60_000);

    // Two inbounds landing at the hub, three outbounds leaving it.
    await makeFlight(a, s1.icao, hub.icao, at(0), at(120)); // I1 arrives 120
    await makeFlight(a, s2.icao, hub.icao, at(5), at(130)); // I2 arrives 130
    await makeFlight(a, hub.icao, far.icao, at(165), at(300)); // O1 feeds both
    await makeFlight(a, hub.icao, s1.icao, at(180), at(320)); // O2: turn-back for I1, feeds I2
    await makeFlight(a, hub.icao, s2.icao, at(400), at(540)); // O3 too late: unfed

    const result = await hubConnections(db.db, own(a), now);

    expect(result).not.toBeNull();
    expect(result?.hubIcao).toBe(hub.icao);
    expect(result?.inboundFlights).toBe(2);
    expect(result?.outboundFlights).toBe(3);
    expect(result?.feasibleConnections).toBe(3);
    expect(result?.connectingInbound).toBe(2);
    expect(result?.connectingOutbound).toBe(2);
    expect(result?.unfedDepartureCount).toBe(1);
    expect(result?.unfedDepartures[0]?.spokeIcao).toBe(s2.icao);
    expect(result?.banks).toHaveLength(2);
  });

  it('does not count another airline’s flights at the same airport', async () => {
    const hub = await makeAirport();
    const spoke = await makeAirport();
    const a = await fixtures.create({ baseCountry: 'GB', hubIdent: hub.ident });
    const b = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });

    const now = new Date();
    const gameNow = gameTime(await clockOf(a.world.id), now);
    const at = (minutes: number): Date =>
      new Date(gameNow.getTime() + 86_400_000 + minutes * 60_000);

    // B flies through A's hub airport; A's analysis must not see it.
    await makeFlight(b, spoke.icao, hub.icao, at(0), at(120));
    await makeFlight(b, hub.icao, spoke.icao, at(150), at(270));

    const result = await hubConnections(db.db, own(a), now);
    expect(result?.hubIcao).toBe(hub.icao);
    expect(result?.inboundFlights).toBe(0);
    expect(result?.outboundFlights).toBe(0);
  });

  it('reads as empty, not broken, for a hub the worker has not materialised', async () => {
    const hub = await makeAirport();
    const a = await fixtures.create({ baseCountry: 'GB', hubIdent: hub.ident });

    const result = await hubConnections(db.db, own(a), new Date());
    expect(result).not.toBeNull();
    expect(result?.hubIcao).toBe(hub.icao);
    expect(result?.inboundFlights).toBe(0);
    expect(result?.feasibleConnections).toBe(0);
    expect(result?.banks).toEqual([]);
    expect(result?.horizonDays).toBe(0);
  });
});
