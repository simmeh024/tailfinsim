import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  CreateAirlineResponse,
  FLAGSHIP_CONFIG,
  type CreateAirlineInput,
  type WorldConfig,
  type WorldStatus,
} from '@tailfin/shared';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airlineHub, airport, player, world } from '../db/schema';
import { type ServerEnv } from '../env';
import { createWorld } from '../world/lifecycle';

import { foundAirline } from './found';

/**
 * Founding an airline, against real Postgres (AIR-01).
 *
 * These cases prove the operation rather than only its endpoint: the world is
 * locked and read inside the transaction, Postgres's named constraints decide
 * both kinds of collision, and a forced failure on the hub insert leaves no
 * half-founded airline behind.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [found.test] DATABASE_URL not set — skipping founding tests.\n');
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
  allowRegistration: false,
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let sequence = 0;

function letters(n: number, length: number): string {
  let value = n;
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result = `${LETTERS[value % LETTERS.length] ?? 'A'}${result}`;
    value = Math.floor(value / LETTERS.length);
  }
  return result;
}

describeDb('founding an airline', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
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
    await db.close();
  });

  async function makePlayer(): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `founder-${String(sequence)}` })
      .returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    return id;
  }

  async function makeWorld(
    status: WorldStatus = 'open',
    overrides: Partial<WorldConfig> = {},
  ): Promise<string> {
    const result = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `founding-${letters(sequence++, 6)}`,
      ...overrides,
    });
    madeWorlds.push(result.world.id);
    await db.db.update(world).set({ status }).where(eq(world.id, result.world.id));
    return result.world.id;
  }

  async function makeHub(): Promise<string> {
    const n = sequence++;
    // Deliberately not an ICAO code: OurAirports `ident` is the universal key,
    // including for the majority of records that have no official ICAO code.
    const ident = `TF-${String(n)}`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: 9_000_000 + n,
        ident,
        icaoCode: null,
        name: `Test Hub ${ident}`,
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

  function input(
    worldId: string,
    hubIdent: string,
    overrides: Partial<CreateAirlineInput> = {},
  ): CreateAirlineInput {
    const n = sequence++;
    return {
      worldId,
      name: `Tailfin Test ${String(n)}`,
      iataCode: String(n % 100).padStart(2, '0'),
      icaoCode: letters(n, 3),
      callsign: `TEST ${String(n)}`,
      baseCountry: 'NL',
      hubIdent,
      ...overrides,
    };
  }

  async function cookieFor(playerId: string): Promise<string> {
    const { token } = await createSession(db.db, playerId, 1);
    return `${SESSION_COOKIE}=${token}`;
  }

  it('commits identity, owner, configured cash, fixed reputation and the free hub together', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const playerId = await makePlayer();

    const result = await foundAirline(db.db, playerId, input(worldId, hubIdent));
    if (!result.ok) throw new Error(`founding refused: ${result.kind}`);

    expect(result.airline).toMatchObject({
      worldId,
      playerId,
      cash: 50_000_000,
      reputation: 0.35,
    });
    expect(result.hub).toMatchObject({
      airlineId: result.airline.id,
      airportIdent: hubIdent,
      founderGrant: true,
    });

    const stored = await db.db
      .select({
        cash: airline.cashMinor,
        reputation: airline.reputation,
        founder: airlineHub.founderGrant,
      })
      .from(airline)
      .innerJoin(airlineHub, eq(airlineHub.airlineId, airline.id))
      .where(and(eq(airline.worldId, worldId), eq(airline.playerId, playerId)));
    expect(stored).toEqual([{ cash: 50_000_000, reputation: '0.35', founder: true }]);
  });

  it('rolls the airline back when granting its hub fails', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const playerId = await makePlayer();
    const submitted = input(worldId, hubIdent);

    class RollbackProbe extends Error {}

    await expect(
      db.db.transaction(async (tx) => {
        await tx.execute(sql`
          create function test_refuse_founder_hub() returns trigger
          language plpgsql as $$ begin raise exception 'forced hub failure'; end $$
        `);
        await tx.execute(sql`
          create trigger test_refuse_founder_hub
          before insert on airline_hub
          for each row execute function test_refuse_founder_hub()
        `);

        await expect(foundAirline(tx, playerId, submitted)).rejects.toThrow(/forced hub failure/);

        const rows = await tx
          .select({ id: airline.id })
          .from(airline)
          .where(and(eq(airline.worldId, worldId), eq(airline.playerId, playerId)));
        expect(rows).toHaveLength(0);

        // Rolls back the temporary trigger and function too.
        throw new RollbackProbe('probe complete');
      }),
    ).rejects.toThrow(RollbackProbe);
  });

  it.each([
    ['iata', { iataCode: 'ZZ' }, { iataCode: 'ZZ', icaoCode: 'ZZB' }],
    ['icao', { icaoCode: 'ZZZ' }, { iataCode: 'Z2', icaoCode: 'ZZZ' }],
  ] as const)('names the taken %s code reported by the constraint', async (kind, first, second) => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const firstPlayer = await makePlayer();
    const secondPlayer = await makePlayer();

    const created = await foundAirline(db.db, firstPlayer, input(worldId, hubIdent, first));
    expect(created.ok).toBe(true);

    const refused = await foundAirline(db.db, secondPlayer, input(worldId, hubIdent, second));
    expect(refused).toMatchObject({
      ok: false,
      kind: 'code-taken',
      codeKind: kind,
      code: kind === 'iata' ? 'ZZ' : 'ZZZ',
    });

    const partial = await db.db
      .select()
      .from(airline)
      .where(and(eq(airline.worldId, worldId), eq(airline.playerId, secondPlayer)));
    expect(partial).toHaveLength(0);
  });

  it('refuses a second airline in the same world through the ownership constraint', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const playerId = await makePlayer();
    expect((await foundAirline(db.db, playerId, input(worldId, hubIdent))).ok).toBe(true);

    expect(await foundAirline(db.db, playerId, input(worldId, hubIdent))).toEqual({
      ok: false,
      kind: 'already-founded',
      worldId,
    });
  });

  it.each(['staging', 'locked', 'archived'] as const)(
    'refuses a %s world and says which status it has',
    async (status) => {
      const worldId = await makeWorld(status);
      const result = await foundAirline(db.db, await makePlayer(), input(worldId, await makeHub()));
      expect(result).toEqual({ ok: false, kind: 'world-not-open', status });
    },
  );

  it('treats moderation as a separate, injectable decision and writes nothing on refusal', async () => {
    const worldId = await makeWorld();
    const playerId = await makePlayer();
    const result = await foundAirline(db.db, playerId, input(worldId, await makeHub()), {
      moderateIdentity: () =>
        Promise.resolve({ accepted: false, reason: 'That name is reserved.' }),
    });
    expect(result).toEqual({
      ok: false,
      kind: 'identity-refused',
      reason: 'That name is reserved.',
    });
    expect(await db.db.select().from(airline).where(eq(airline.playerId, playerId))).toHaveLength(
      0,
    );
  });

  it('honours the world player cap while holding the world lock', async () => {
    const worldId = await makeWorld('open', { playerCap: 1 });
    const hubIdent = await makeHub();
    expect((await foundAirline(db.db, await makePlayer(), input(worldId, hubIdent))).ok).toBe(true);
    expect(await foundAirline(db.db, await makePlayer(), input(worldId, hubIdent))).toEqual({
      ok: false,
      kind: 'world-full',
      playerCap: 1,
    });
  });

  it('exposes founding over authenticated HTTP and ignores client-supplied cash', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const playerId = await makePlayer();
    const app = buildApp({ env, db });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/airlines',
        headers: { cookie: await cookieFor(playerId) },
        payload: { ...input(worldId, hubIdent), cash: 999_999_999, reputation: 1 },
      });
      expect(response.statusCode).toBe(201);
      const parsed = CreateAirlineResponse.parse(response.json());
      expect(parsed.airline.cash).toBe(50_000_000);
      expect(parsed.airline.reputation).toBe(0.35);
      expect(parsed.airline.playerId).toBe(playerId);
      expect(parsed.hub.airportIdent).toBe(hubIdent);
    } finally {
      await app.close();
    }
  });

  it('returns a field-level, code-naming HTTP refusal instead of a 500', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const owner = await makePlayer();
    const rival = await makePlayer();
    expect(
      (await foundAirline(db.db, owner, input(worldId, hubIdent, { iataCode: 'Q1' }))).ok,
    ).toBe(true);

    const app = buildApp({ env, db });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/airlines',
        headers: { cookie: await cookieFor(rival) },
        payload: input(worldId, hubIdent, { iataCode: 'Q1' }),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'iata_code_taken',
        fields: { iataCode: ['Q1 is already taken in this world.'] },
      });
      expect(response.body).toContain('Q1');
    } finally {
      await app.close();
    }
  });
});
