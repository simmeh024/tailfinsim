import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG, OwnAirlineResponse, UpdateOwnAirlineResponse } from '@tailfin/shared';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airlineIdentityChange, airport, cashMovement, player, world } from '../db/schema';
import { ECONOMY_CONFIG_V1 } from '../economy/config';
import { type ServerEnv } from '../env';
import { createWorld } from '../world/lifecycle';

import { reconcileAirlineCash } from './cash';
import { ACTIVE_WORLD_HEADER } from './context';
import { foundAirline } from './found';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [own.test] DATABASE_URL not set — skipping own-airline tests.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 2,
  databaseConnectTimeoutMs: 5_000,
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

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describeDb('reading and changing your own airline', () => {
  let db: DatabaseHandle;
  let app: ReturnType<typeof buildApp>;
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];
  const madeAirports: string[] = [];
  let sequence = 0;

  beforeAll(async () => {
    db = createDatabase();
    app = buildApp({
      env,
      db,
      identityModerator: {
        review: (identity) =>
          Promise.resolve(
            identity.name === 'Blocked Airline'
              ? {
                  accepted: false as const,
                  field: 'name' as const,
                  reason: 'That name is blocked.',
                }
              : { accepted: true as const },
          ),
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    if (madeWorlds.length > 0) {
      await db.db.delete(world).where(inArray(world.id, madeWorlds.splice(0)));
    }
    if (madeAirports.length > 0) {
      await db.db.delete(airport).where(inArray(airport.id, madeAirports.splice(0)));
    }
    if (madePlayers.length > 0) {
      await db.db.delete(player).where(inArray(player.id, madePlayers.splice(0)));
    }
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  async function makePlayer(): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `airline-owner-${String(sequence++)}` })
      .returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    return id;
  }

  async function makeWorld(): Promise<string> {
    const created = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `own-airline-world-${String(sequence++)}`,
    });
    await db.db.update(world).set({ status: 'open' }).where(eq(world.id, created.world.id));
    madeWorlds.push(created.world.id);
    return created.world.id;
  }

  async function makeAirport(): Promise<string> {
    const n = sequence++;
    const ident = `OA-${String(n)}`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: 9_600_000 + n,
        ident,
        name: `Own Airline Airport ${String(n)}`,
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
    return ident;
  }

  async function makeAirline(playerId: string, requestedWorldId?: string) {
    const worldId = requestedWorldId ?? (await makeWorld());
    const n = sequence++;
    const hubIdent = await makeAirport();
    const result = await foundAirline(db.db, playerId, {
      worldId,
      name: `Owner Air ${String(n)}`,
      iataCode: String(n % 100).padStart(2, '0'),
      icaoCode: `O${LETTERS[n % 26] ?? 'A'}${LETTERS[Math.floor(n / 26) % 26] ?? 'A'}`,
      callsign: `OWNER ${String(n)}`,
      baseCountry: 'NL',
      hubIdent,
    });
    if (!result.ok) throw new Error(`founding refused: ${result.kind}`);
    return result.airline;
  }

  async function tokenFor(playerId: string): Promise<string> {
    return (await createSession(db.db, playerId, 1)).token;
  }

  it('returns absence as a normal typed response and never leaks another player’s airline', async () => {
    const ownerId = await makePlayer();
    const worldId = await makeWorld();
    await makeAirline(ownerId, worldId);
    const callerId = await makePlayer();

    const response = await app.inject({
      method: 'GET',
      url: '/api/airlines/me',
      headers: { [ACTIVE_WORLD_HEADER]: worldId },
      cookies: { [SESSION_COOKIE]: await tokenFor(callerId) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ airline: null, rebrand: null });
    expect(OwnAirlineResponse.safeParse(response.json()).success).toBe(true);
  });

  it('reads the caller’s private balance, reputation, identity and immutable-field decision', async () => {
    const playerId = await makePlayer();
    const own = await makeAirline(playerId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/airlines/me',
      cookies: { [SESSION_COOKIE]: await tokenFor(playerId) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      airline: {
        id: own.id,
        playerId,
        cash: ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor,
        reputation: 0.35,
      },
      rebrand: {
        costMinor: ECONOMY_CONFIG_V1.airlineIdentity.rebrandCostMinor,
        mutableFields: ['name', 'callsign', 'baseCountry'],
        immutableFields: ['iataCode', 'icaoCode', 'cash', 'reputation'],
      },
    });
    expect(OwnAirlineResponse.safeParse(response.json()).success).toBe(true);
  });

  it('returns restricted and ceased airlines as read-only records', async () => {
    const playerId = await makePlayer();
    const own = await makeAirline(playerId);
    const token = await tokenFor(playerId);

    await db.db.update(airline).set({ status: 'restricted' }).where(eq(airline.id, own.id));
    const restricted = await app.inject({
      method: 'GET',
      url: '/api/airlines/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(restricted.statusCode).toBe(200);
    expect(restricted.json()).toMatchObject({
      airline: { id: own.id, status: 'restricted', ceasedAt: null },
      rebrand: null,
    });

    const ceasedAt = new Date('2026-08-21T12:00:00.000Z');
    await db.db
      .update(airline)
      .set({ status: 'ceased', statusChangedAt: ceasedAt, ceasedAt })
      .where(eq(airline.id, own.id));
    const ceased = await app.inject({
      method: 'GET',
      url: '/api/airlines/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(ceased.statusCode).toBe(200);
    expect(ceased.json()).toMatchObject({
      airline: { id: own.id, status: 'ceased', ceasedAt: ceasedAt.toISOString() },
      rebrand: null,
    });
    expect(OwnAirlineResponse.safeParse(ceased.json()).success).toBe(true);
  });

  it('changes AIR-02 identity fields and charges one event through the cash ledger', async () => {
    const playerId = await makePlayer();
    const before = await makeAirline(playerId);
    const token = await tokenFor(playerId);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/airlines/me',
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: 'Air Côte d’Ivoire', callsign: 'HORIZON 8', baseCountry: 'CI' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      changed: true,
      chargedMinor: ECONOMY_CONFIG_V1.airlineIdentity.rebrandCostMinor,
      airline: {
        id: before.id,
        name: 'Air Côte d’Ivoire',
        callsign: 'HORIZON 8',
        baseCountry: 'CI',
        iataCode: before.iataCode,
        icaoCode: before.icaoCode,
        reputation: before.reputation,
        cash:
          ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor -
          ECONOMY_CONFIG_V1.airlineIdentity.rebrandCostMinor,
      },
    });
    expect(UpdateOwnAirlineResponse.safeParse(response.json()).success).toBe(true);

    const events = await db.db
      .select()
      .from(airlineIdentityChange)
      .where(eq(airlineIdentityChange.airlineId, before.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      beforeName: before.name,
      afterName: 'Air Côte d’Ivoire',
      beforeCallsign: before.callsign,
      afterCallsign: 'HORIZON 8',
      beforeBaseCountry: 'NL',
      afterBaseCountry: 'CI',
      costMinor: ECONOMY_CONFIG_V1.airlineIdentity.rebrandCostMinor,
    });

    const movements = await db.db
      .select()
      .from(cashMovement)
      .where(eq(cashMovement.cause, 'airline_rebrand'));
    expect(movements).toEqual([
      expect.objectContaining({
        airlineId: before.id,
        reference: events[0]?.id,
        amountMinor: -ECONOMY_CONFIG_V1.airlineIdentity.rebrandCostMinor,
      }),
    ]);
    expect(await reconcileAirlineCash(db.db, before.id)).toMatchObject({ reconciles: true });
  });

  it('does not charge when the submitted identity is already current', async () => {
    const playerId = await makePlayer();
    const own = await makeAirline(playerId);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/airlines/me',
      cookies: { [SESSION_COOKIE]: await tokenFor(playerId) },
      payload: { name: own.name, callsign: own.callsign, baseCountry: own.baseCountry },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      changed: false,
      chargedMinor: 0,
      identityChangeId: null,
      airline: { cash: own.cash },
    });
    expect(
      await db.db
        .select()
        .from(airlineIdentityChange)
        .where(eq(airlineIdentityChange.airlineId, own.id)),
    ).toEqual([]);
  });

  it.each([
    ['cash', 900_000_000],
    ['reputation', 1],
    ['iataCode', 'ZZ'],
    ['icaoCode', 'ZZZ'],
  ])(
    'rejects attempts to set immutable %s rather than silently stripping it',
    async (field, value) => {
      const playerId = await makePlayer();
      const own = await makeAirline(playerId);

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/airlines/me',
        cookies: { [SESSION_COOKIE]: await tokenFor(playerId) },
        payload: {
          name: 'A Valid New Name',
          callsign: 'VALID NEW',
          baseCountry: 'GB',
          [field]: value,
        },
      });

      expect(response.statusCode).toBe(400);
      const stored = await db.db.select().from(airline).where(eq(airline.id, own.id));
      expect(stored[0]).toMatchObject({
        name: own.name,
        callsign: own.callsign,
        baseCountry: own.baseCountry,
        cashMinor: own.cash,
        reputation: '0.35',
      });
    },
  );

  it('applies AIR-02 validation and moderation before recording or charging a change', async () => {
    const playerId = await makePlayer();
    const own = await makeAirline(playerId);
    const token = await tokenFor(playerId);

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/airlines/me',
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: 'Tailfin ✈', callsign: 'new callsign', baseCountry: 'NLD' },
    });
    expect(invalid.statusCode).toBe(400);
    const invalidBody = invalid.json<{
      code: string;
      fields: Record<string, string[]>;
    }>();
    expect(invalidBody.code).toBe('invalid_airline_identity');
    expect(invalidBody.fields.name?.join(' ')).toMatch(/may contain only/);
    expect(invalidBody.fields.callsign?.join(' ')).toMatch(/uppercase Latin/);
    expect(invalidBody.fields.baseCountry?.join(' ')).toMatch(/ISO 3166-1 alpha-2/);

    const moderated = await app.inject({
      method: 'PATCH',
      url: '/api/airlines/me',
      cookies: { [SESSION_COOKIE]: token },
      payload: { name: 'Blocked Airline', callsign: 'BLOCKED', baseCountry: 'NL' },
    });
    expect(moderated.statusCode).toBe(422);
    expect(moderated.json()).toMatchObject({
      code: 'identity_refused',
      fields: { name: ['That name is blocked.'] },
    });

    expect(
      await db.db
        .select()
        .from(airlineIdentityChange)
        .where(eq(airlineIdentityChange.airlineId, own.id)),
    ).toEqual([]);
    expect(await reconcileAirlineCash(db.db, own.id)).toMatchObject({
      balanceMinor: own.cash,
      reconciles: true,
    });
  });
});
