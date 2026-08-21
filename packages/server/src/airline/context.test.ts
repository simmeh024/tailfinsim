import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG, PlayerAirlineContextError } from '@tailfin/shared';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airport, player, route, world } from '../db/schema';
import { type ServerEnv } from '../env';
import { createWorld } from '../world/lifecycle';

import { ACTIVE_WORLD_HEADER, parseActiveWorldHeader } from './context';

const url = process.env.DATABASE_URL;
if (!url)
  console.warn('\n  [context.test] DATABASE_URL not set — skipping airline context tests.\n');
const describeDb = url ? describe : describe.skip;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

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

describe('active world header', () => {
  const worldId = '3f2b8c9e-1d4a-4f6b-8c2e-9a7d5b3f1e0c';

  it('accepts one UUID or no selection', () => {
    expect(parseActiveWorldHeader(undefined)).toEqual({ ok: true, worldId: undefined });
    expect(parseActiveWorldHeader(worldId)).toEqual({ ok: true, worldId });
  });

  it('rejects malformed and duplicate selections', () => {
    expect(parseActiveWorldHeader('newest')).toEqual({ ok: false });
    expect(parseActiveWorldHeader([worldId, worldId])).toEqual({ ok: false });
  });
});

describeDb('player airline context over HTTP', () => {
  let db: DatabaseHandle;
  let app: ReturnType<typeof buildApp>;
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];
  const madeAirports: string[] = [];
  let sequence = 0;

  beforeAll(async () => {
    db = createDatabase();
    app = buildApp({ env, db });
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

  async function makePlayer(label = 'pilot'): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `${label}-${String(sequence++)}` })
      .returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    return id;
  }

  async function makeWorld(): Promise<string> {
    const result = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `context-world-${String(sequence++)}`,
    });
    madeWorlds.push(result.world.id);
    return result.world.id;
  }

  async function makeAirline(worldId: string, playerId: string): Promise<string> {
    const n = sequence++;
    const rows = await db.db
      .insert(airline)
      .values({
        worldId,
        playerId,
        name: `Context Air ${String(n)}`,
        iataCode: String(n % 100).padStart(2, '0'),
        icaoCode: `C${LETTERS[n % 26] ?? 'A'}${LETTERS[Math.floor(n / 26) % 26] ?? 'A'}`,
        callsign: `CONTEXT ${String(n)}`,
        baseCountry: 'NL',
      })
      .returning({ id: airline.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no airline created');
    return id;
  }

  async function makeAirport(icaoCode: string): Promise<void> {
    const n = sequence++;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: 9_300_000 + n,
        ident: icaoCode,
        icaoCode,
        name: `Context Airport ${icaoCode}`,
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

  async function makeRoute(
    worldId: string,
    airlineId: string,
    originIcao: string,
    destinationIcao: string,
  ): Promise<string> {
    const rows = await db.db
      .insert(route)
      .values({
        worldId,
        airlineId,
        originIcao,
        destinationIcao,
        greatCircleNm: 400,
        fares: JSON.stringify({ economy: 12_000 }),
      })
      .returning({ id: route.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no route created');
    return id;
  }

  async function cookieFor(playerId: string): Promise<string> {
    const { token } = await createSession(db.db, playerId, 1);
    return token;
  }

  it('uses one documented response across every handler when the player has no airline', async () => {
    const playerId = await makePlayer();
    const token = await cookieFor(playerId);

    const requests = [
      { method: 'GET', url: '/api/routes' },
      { method: 'POST', url: '/api/routes', payload: {} },
      { method: 'PUT', url: '/api/routes/00000000-0000-4000-8000-000000000000/fares', payload: {} },
      {
        method: 'POST',
        url: '/api/routes/00000000-0000-4000-8000-000000000000/fares/preview',
        payload: {},
      },
    ] as const;

    for (const request of requests) {
      const response = await app.inject({
        ...request,
        cookies: { [SESSION_COOKIE]: token },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: 'airline_required',
        message: 'Found an airline in the active world before using this feature',
      });
      expect(PlayerAirlineContextError.safeParse(response.json()).success).toBe(true);
    }
  });

  it('infers the world only when the player has exactly one airline', async () => {
    const worldId = await makeWorld();
    const playerId = await makePlayer();
    await makeAirline(worldId, playerId);
    const token = await cookieFor(playerId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/routes',
      cookies: { [SESSION_COOKIE]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ routes: [] });
  });

  it('refuses to guess when several worlds could be active', async () => {
    const playerId = await makePlayer();
    await makeAirline(await makeWorld(), playerId);
    await makeAirline(await makeWorld(), playerId);
    const token = await cookieFor(playerId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/routes',
      cookies: { [SESSION_COOKIE]: token },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'active_world_required' });
  });

  it('selects the requested world rather than whichever airline a query returns first', async () => {
    await makeAirport('CTAA');
    await makeAirport('CTAB');
    const playerId = await makePlayer();
    const firstWorldId = await makeWorld();
    const secondWorldId = await makeWorld();
    const firstAirlineId = await makeAirline(firstWorldId, playerId);
    const secondAirlineId = await makeAirline(secondWorldId, playerId);
    const firstRouteId = await makeRoute(firstWorldId, firstAirlineId, 'CTAA', 'CTAB');
    await makeRoute(secondWorldId, secondAirlineId, 'CTAB', 'CTAA');
    const token = await cookieFor(playerId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/routes',
      headers: { [ACTIVE_WORLD_HEADER]: firstWorldId },
      cookies: { [SESSION_COOKIE]: token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ routes: { id: string }[] }>().routes.map((entry) => entry.id)).toEqual([
      firstRouteId,
    ]);
  });

  it("cannot update another airline's route, even inside the selected world", async () => {
    await makeAirport('CTBA');
    await makeAirport('CTBB');
    const worldId = await makeWorld();
    const ownerId = await makePlayer('owner');
    const strangerId = await makePlayer('stranger');
    await makeAirline(worldId, ownerId);
    const competitorAirlineId = await makeAirline(worldId, strangerId);
    const competitorRouteId = await makeRoute(worldId, competitorAirlineId, 'CTBA', 'CTBB');
    const token = await cookieFor(ownerId);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/routes/${competitorRouteId}/fares`,
      headers: { [ACTIVE_WORLD_HEADER]: worldId },
      cookies: { [SESSION_COOKIE]: token },
      payload: { fares: { economy: 99_999 } },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'not_found', message: 'No such route' });
    const stored = await db.db
      .select({ fares: route.fares })
      .from(route)
      .where(eq(route.id, competitorRouteId));
    expect(stored).toEqual([{ fares: JSON.stringify({ economy: 12_000 }) }]);
  });

  it('does not reveal whether an explicitly selected world belongs to a competitor', async () => {
    const worldId = await makeWorld();
    const otherWorldId = await makeWorld();
    const ownerId = await makePlayer('owner');
    const strangerId = await makePlayer('stranger');
    await makeAirline(worldId, ownerId);
    await makeAirline(otherWorldId, strangerId);
    const token = await cookieFor(strangerId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/routes',
      headers: { [ACTIVE_WORLD_HEADER]: worldId },
      cookies: { [SESSION_COOKIE]: token },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'airline_required' });
  });

  it('applies active, operating and read-only lifecycle permissions consistently', async () => {
    const worldId = await makeWorld();
    const playerId = await makePlayer();
    const airlineId = await makeAirline(worldId, playerId);
    const token = await cookieFor(playerId);
    const request = async (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH',
      requestUrl: string,
      payload?: Record<string, unknown>,
    ) =>
      app.inject({
        method,
        url: requestUrl,
        payload,
        headers: { [ACTIVE_WORLD_HEADER]: worldId },
        cookies: { [SESSION_COOKIE]: token },
      });

    await db.db.update(airline).set({ status: 'restricted' }).where(eq(airline.id, airlineId));
    expect((await request('GET', '/api/routes')).statusCode).toBe(200);
    expect((await request('POST', '/api/routes', {})).json()).toMatchObject({
      code: 'airline_restricted',
    });
    // Restricted airlines may still manage an existing operation. This missing
    // id reaches route ownership resolution instead of being lifecycle-blocked.
    expect(
      (
        await request('PUT', '/api/routes/00000000-0000-4000-8000-000000000000/fares', {
          fares: { economy: 12_000 },
        })
      ).statusCode,
    ).toBe(404);
    expect((await request('PATCH', '/api/airlines/me', {})).json()).toMatchObject({
      code: 'airline_restricted',
    });

    await db.db
      .update(airline)
      .set({ status: 'ceased', ceasedAt: new Date() })
      .where(eq(airline.id, airlineId));
    expect((await request('GET', '/api/routes')).statusCode).toBe(200);
    for (const response of [
      await request('POST', '/api/routes', {}),
      await request('PUT', '/api/routes/00000000-0000-4000-8000-000000000000/fares', {
        fares: { economy: 12_000 },
      }),
      await request('POST', '/api/routes/00000000-0000-4000-8000-000000000000/fares/preview', {
        fares: { economy: 12_000 },
      }),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'airline_ceased' });
    }
  });
});
