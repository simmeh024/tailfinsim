import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { moveAirlineCash } from '../airline/cash';
import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminGrant, airline, airport, cashMovement, player, route } from '../db/schema';
import { type ServerEnv } from '../env';
import { createAuthorizationTestSuite } from '../test-fixtures/authorization';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { readAirline } from './airlines';
import { BOOTSTRAP_ACTOR, grantAdmin } from './grants';

/**
 * AIR-10's airline support record.
 *
 * Requires `DATABASE_URL` against a migrated disposable `_test`/`_ci`
 * database. The suite proves the projection against Postgres, the HTTP admin
 * boundary, and that the new surface has no balance mutation route.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [airlines.test] DATABASE_URL not set — skipping airline tests.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 4,
  databaseConnectTimeoutMs: 5000,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  publicOrigin: 'http://localhost:3000',
  googleClientId: 'test-client-id.apps.googleusercontent.com',
  googleClientSecret: 'test-client-secret',
  sessionSecret: 'a'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

describeDb('the airline support record', () => {
  let db: DatabaseHandle;
  const madePlayers: string[] = [];
  const madeAirports: string[] = [];
  let fixtures: FoundedAirlineFixtureHarness;
  let sequence = 0;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
    for (const id of madePlayers.splice(0)) {
      await db.db.delete(adminGrant).where(eq(adminGrant.playerId, id));
      await db.db.delete(player).where(eq(player.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makePlayer(label = 'Airline owner'): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `${label} ${String(sequence++)}` })
      .returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    return id;
  }

  async function makeAirport(icaoCode: string, name: string): Promise<void> {
    const n = sequence++;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: 9_900_000 + n,
        ident: icaoCode,
        icaoCode,
        name,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + n / 10_000,
        longitude: 4 + n / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
      })
      .returning({ id: airport.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no airport created');
    madeAirports.push(id);
  }

  async function makeAirline(): Promise<{
    airlineId: string;
    ownerId: string;
    openingCashMinor: number;
  }> {
    const created = await fixtures.create({
      name: 'Support Air',
      iataCode: 'SA',
      icaoCode: 'SPA',
      callsign: 'SUPPORT',
    });
    return {
      airlineId: created.airline.id,
      ownerId: created.player.id,
      openingCashMinor: created.airline.cash,
    };
  }

  async function addMovement(
    airlineId: string,
    amountMinor: number,
    reference: string,
    occurredAt: string,
  ): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor,
        cause: 'flight_settlement',
        reference,
        occurredAt: new Date(occurredAt),
      }),
    );
  }

  async function cookieFor(playerId: string): Promise<string> {
    const { token } = await createSession(db.db, playerId, 1);
    return `${SESSION_COOKIE}=${token}`;
  }

  it('shows identity, standing, current and historical routes, and the immutable cash ledger', async () => {
    const { airlineId, ownerId, openingCashMinor } = await makeAirline();
    await makeAirport('EHAA', 'Support Origin');
    await makeAirport('EHBB', 'Support Destination');
    const airlineRows = await db.db.select().from(airline).where(eq(airline.id, airlineId));
    const worldId = airlineRows[0]?.worldId;
    if (!worldId) throw new Error('airline has no world');
    await db.db.insert(route).values({
      worldId,
      airlineId,
      originIcao: 'EHAA',
      destinationIcao: 'EHBB',
      greatCircleNm: 321,
      fares: JSON.stringify({ economy: 12_500, business: 33_000 }),
      active: false,
    });
    await addMovement(airlineId, -12_500, `flight-${String(sequence++)}`, '2099-01-01T10:00:00Z');

    const before = {
      airline: await db.db.select().from(airline).where(eq(airline.id, airlineId)),
      routes: await db.db.select().from(route).where(eq(route.airlineId, airlineId)),
      movements: await db.db
        .select()
        .from(cashMovement)
        .where(eq(cashMovement.airlineId, airlineId)),
    };
    const detail = await readAirline(db.db, airlineId);
    const after = {
      airline: await db.db.select().from(airline).where(eq(airline.id, airlineId)),
      routes: await db.db.select().from(route).where(eq(route.airlineId, airlineId)),
      movements: await db.db
        .select()
        .from(cashMovement)
        .where(eq(cashMovement.airlineId, airlineId)),
    };

    expect(detail?.airline).toMatchObject({
      id: airlineId,
      name: 'Support Air',
      iataCode: 'SA',
      icaoCode: 'SPA',
      callsign: 'SUPPORT',
      cashMinor: openingCashMinor - 12_500,
      reputation: 0.35,
      status: 'active',
      owner: { id: ownerId },
    });
    expect(detail?.airline.routes).toEqual([
      expect.objectContaining({
        originIcao: 'EHAA',
        originName: 'Support Origin',
        destinationIcao: 'EHBB',
        destinationName: 'Support Destination',
        active: false,
        fares: { economy: 12_500, business: 33_000 },
      }),
    ]);
    expect(detail?.cashMovements.entries.map((entry) => entry.amountMinor)).toEqual([
      -12_500,
      openingCashMinor,
    ]);
    expect(detail?.cashMovements.entries[0]).toMatchObject({
      cause: 'flight_settlement',
      balanceAfterMinor: openingCashMinor - 12_500,
    });
    // AIR-10 reads only. The three game-state tables are byte-for-byte the same afterwards.
    expect(after).toEqual(before);
  });

  it('pages a long ledger newest first and bounds invalid page input', async () => {
    const { airlineId } = await makeAirline();
    await addMovement(airlineId, 100, `first-${String(sequence++)}`, '2099-01-01T10:00:00Z');
    await addMovement(airlineId, 200, `second-${String(sequence++)}`, '2099-01-02T10:00:00Z');
    await addMovement(airlineId, 300, `third-${String(sequence++)}`, '2099-01-03T10:00:00Z');

    const secondPage = await readAirline(db.db, airlineId, {
      movementLimit: 1,
      movementOffset: 1,
    });
    expect(secondPage?.cashMovements).toMatchObject({ total: 4, limit: 1, offset: 1 });
    expect(secondPage?.cashMovements.entries[0]?.amountMinor).toBe(200);

    const bounded = await readAirline(db.db, airlineId, {
      movementLimit: Number.NaN,
      movementOffset: -10,
    });
    expect(bounded?.cashMovements).toMatchObject({ total: 4, limit: 50, offset: 0 });
  });

  it('returns null for an airline that is not there', async () => {
    expect(await readAirline(db.db, '11111111-2222-4333-8444-555555555555')).toBeNull();
  });

  it('protects the HTTP record with the admin gate and exposes no cash mutation route', async () => {
    const { airlineId } = await makeAirline();
    const authorization = await createAuthorizationTestSuite({
      db,
      env,
      suite: 'admin-airline-record',
    });
    try {
      await authorization.expectAuthorization({
        request: { method: 'GET', url: `/api/admin/airlines/${airlineId}` },
        guest: 401,
        playerA: 403,
        playerB: 403,
        admin: 200,
      });

      const cookie = authorization.identities.admin.cookie;
      if (cookie === undefined) throw new Error('authorization fixture created no admin cookie');
      const detail = await authorization.app.inject({
        method: 'GET',
        url: `/api/admin/airlines/${airlineId}?movementLimit=1&movementOffset=0`,
        headers: { cookie },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ airline: { id: string } }>().airline.id).toBe(airlineId);

      for (const method of ['PATCH', 'POST'] as const) {
        const mutation = await authorization.app.inject({
          method,
          url: `/api/admin/airlines/${airlineId}`,
          headers: { cookie, 'content-type': 'application/json' },
          payload: { cashMinor: 999_999, reason: 'unsupported direct edit' },
        });
        expect(mutation.statusCode).toBe(404);
      }
    } finally {
      await authorization.cleanup();
    }
  });

  it('answers 404 for a missing airline and a malformed id', async () => {
    const adminId = await makePlayer('Airline admin');
    await grantAdmin(db.db, adminId, BOOTSTRAP_ACTOR);
    const app = await buildApp({ env, db });
    try {
      const cookie = await cookieFor(adminId);
      for (const id of ['11111111-2222-4333-8444-555555555555', 'not-a-uuid']) {
        const reply = await app.inject({
          method: 'GET',
          url: `/api/admin/airlines/${id}`,
          headers: { cookie },
        });
        expect(reply.statusCode).toBe(404);
        expect(reply.json<{ code: string }>().code).toBe('airline_not_found');
      }
    } finally {
      await app.close();
    }
  });
});
