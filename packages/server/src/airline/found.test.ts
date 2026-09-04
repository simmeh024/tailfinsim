import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AirlineCodeAvailabilityResponse,
  AirlineCodeUnavailableError,
  AirlineFoundingAirportListResponse,
  AirlineFoundingOptionsResponse,
  CreateAirlineResponse,
  FLAGSHIP_CONFIG,
  INITIAL_AIRLINE_REPUTATION,
  type CreateAirlineInput,
  type AirportTier,
  type WorldConfig,
  type WorldStatus,
} from '@tailfin/shared';
import { gameTime } from '@tailfin/sim';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airlineHub, airport, cashMovement, player, world } from '../db/schema';
import { ECONOMY_CONFIG_V1 } from '../economy/config';
import { type ServerEnv } from '../env';
import { createWorld } from '../world/lifecycle';

import { reconcileAirlineCash } from './cash';
import { foundAirline } from './found';
import { transitionAirlineStatus } from './lifecycle';

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
  adminSessionTtlHours: 12,
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

  async function makeHub(tier: AirportTier = 'medium'): Promise<string> {
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
        name: `${tier === 'flagship' ? 'Flagship' : 'Test'} Hub ${ident}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + n / 10_000,
        longitude: 4 + n / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier,
        slotLevel: tier === 'flagship' ? 3 : 2,
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
      cash: ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor,
      reputation: INITIAL_AIRLINE_REPUTATION,
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
    expect(stored).toEqual([
      {
        cash: ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor,
        reputation: '0.35',
        founder: true,
      },
    ]);

    const movements = await db.db
      .select()
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, result.airline.id));
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      airlineId: result.airline.id,
      amountMinor: ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor,
      cause: 'airline_founding',
      reference: result.airline.id,
      balanceAfterMinor: ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor,
    });
    expect(await reconcileAirlineCash(db.db, result.airline.id)).toMatchObject({
      balanceMinor: ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor,
      movementTotalMinor: ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor,
      reconciles: true,
    });
  });

  /*
   * TIME-02 / ADR-0026. The opening AIR-06 movement is the *first* row in an
   * airline's ledger, and every row that follows it -- flights, leases, salaries,
   * aircraft -- is dated on the world's calendar. It used to carry the airline
   * row's wall-clock `createdAt`, which on a world whose epoch is in the past put
   * the opening balance years away from the money it funded.
   *
   * Deterministic rather than approximate: the founding instant is injected, so
   * the expected game instant is arithmetic. `createdAt` is asserted too, because
   * the point is that the two are different questions and both are still answered.
   */
  it('dates the opening movement in the world, not on the wall clock', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const playerId = await makePlayer();

    const [row] = await db.db
      .select({
        epoch: world.epoch,
        launchDate: world.launchDate,
        speedMultiplier: world.speedMultiplier,
      })
      .from(world)
      .where(eq(world.id, worldId));
    if (!row) throw new Error('world vanished');

    // A real hour into the world, so game and real time have measurably diverged.
    const foundedAt = new Date(row.launchDate.getTime() + 60 * 60 * 1_000);
    const expected = gameTime(
      {
        epoch: row.epoch,
        launchDate: row.launchDate,
        speedMultiplier: Number(row.speedMultiplier),
      },
      foundedAt,
    );

    const result = await foundAirline(db.db, playerId, input(worldId, hubIdent), {
      now: () => foundedAt,
    });
    if (!result.ok) throw new Error(`founding refused: ${result.kind}`);

    const [movement] = await db.db
      .select()
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, result.airline.id));
    expect(movement?.cause).toBe('airline_founding');
    expect(movement?.occurredAt.toISOString()).toBe(expected.toISOString());

    // Two years of divergence on the flagship epoch, so this could not pass by
    // accident if the wall clock crept back in.
    expect(movement?.occurredAt.getTime()).toBeLessThan(foundedAt.getTime());

    // The row's own audit stamp is untouched and is still real.
    const [stored] = await db.db
      .select({ createdAt: airline.createdAt })
      .from(airline)
      .where(eq(airline.id, result.airline.id));
    expect(stored?.createdAt.toISOString()).not.toBe(expected.toISOString());
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

        const failure: unknown = await foundAirline(tx, playerId, submitted).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);

        // Drizzle wraps the Postgres error at the top level. Preserve the
        // useful assertion by walking the same cause chain production uses
        // for named constraints instead of depending on the wrapper message.
        const messages: string[] = [];
        let current = failure;
        while (current instanceof Error) {
          messages.push(current.message);
          current = current.cause;
        }
        expect(messages.join('\n')).toMatch(/forced hub failure/);

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
    if (refused.ok || refused.kind !== 'code-taken') throw new Error('expected code refusal');
    expect(refused.alternatives).toHaveLength(3);
    expect(refused.alternatives).not.toContain(refused.code);
    expect(refused.advisory).toMatchObject({
      scope: 'world',
      reservation: 'none',
      realWorldCodes: 'allowed-if-free',
    });

    const partial = await db.db
      .select()
      .from(airline)
      .where(and(eq(airline.worldId, worldId), eq(airline.playerId, secondPlayer)));
    expect(partial).toHaveLength(0);
  });

  it('turns a concurrent allocation race into one success and one fresh refusal', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const firstPlayer = await makePlayer();
    const secondPlayer = await makePlayer();
    const [first, second] = await Promise.all([
      foundAirline(
        db.db,
        firstPlayer,
        input(worldId, hubIdent, { name: 'Race Horizon', iataCode: 'R1', icaoCode: 'RAA' }),
      ),
      foundAirline(
        db.db,
        secondPlayer,
        input(worldId, hubIdent, { name: 'Race Horizon', iataCode: 'R1', icaoCode: 'RAB' }),
      ),
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused).toMatchObject({ ok: false, kind: 'code-taken', codeKind: 'iata', code: 'R1' });
    if (!refused || refused.ok || refused.kind !== 'code-taken') {
      throw new Error('expected one constraint refusal');
    }
    expect(refused.alternatives).toHaveLength(3);
    expect(refused.alternatives).not.toContain('R1');
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
      identityModerator: {
        review: () =>
          Promise.resolve({
            accepted: false,
            field: 'name',
            reason: 'That name is reserved.',
          }),
      },
    });
    expect(result).toEqual({
      ok: false,
      kind: 'identity-refused',
      field: 'name',
      reason: 'That name is reserved.',
    });
    expect(await db.db.select().from(airline).where(eq(airline.playerId, playerId))).toHaveLength(
      0,
    );
  });

  it('enforces an injected reserved-code policy inside the founding transaction', async () => {
    const worldId = await makeWorld();
    const playerId = await makePlayer();
    const result = await foundAirline(
      db.db,
      playerId,
      input(worldId, await makeHub(), { name: 'Tailfin Air', iataCode: 'TA' }),
      {
        codePolicy: {
          realWorldCodes: 'reserved',
          isReserved: (kind, code) => kind === 'iata' && code === 'TA',
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'code-reserved',
      codeKind: 'iata',
      code: 'TA',
      advisory: { realWorldCodes: 'reserved' },
    });
    if (result.ok || result.kind !== 'code-reserved') throw new Error('expected reservation');
    expect(result.alternatives).toHaveLength(3);
    expect(result.alternatives).not.toContain('TA');
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

  it('releases a ceased airline’s player-cap place and codes for a new founder', async () => {
    const worldId = await makeWorld('open', { playerCap: 1 });
    const hubIdent = await makeHub();
    const codes = { iataCode: 'RL', icaoCode: 'RLS' };
    const first = await foundAirline(db.db, await makePlayer(), input(worldId, hubIdent, codes));
    if (!first.ok) throw new Error(`first founding refused: ${first.kind}`);

    await transitionAirlineStatus(
      db.db,
      first.airline.id,
      { to: 'ceased', reason: 'test code release' },
      new Date('2026-08-21T12:00:00.000Z'),
    );
    const second = await foundAirline(db.db, await makePlayer(), input(worldId, hubIdent, codes));
    expect(second).toMatchObject({
      ok: true,
      airline: { iataCode: 'RL', icaoCode: 'RLS', status: 'active' },
    });
  });

  it('exposes founding over authenticated HTTP and ignores client-supplied cash', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const playerId = await makePlayer();
    const app = await buildApp({ env, db });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/airlines',
        headers: { cookie: await cookieFor(playerId) },
        payload: { ...input(worldId, hubIdent), cash: 999_999_999, reputation: 1 },
      });
      expect(response.statusCode).toBe(201);
      const parsed = CreateAirlineResponse.parse(response.json());
      expect(parsed.airline.cash).toBe(ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor);
      expect(parsed.airline.reputation).toBe(INITIAL_AIRLINE_REPUTATION);
      expect(parsed.airline.playerId).toBe(playerId);
      expect(parsed.hub.airportIdent).toBe(hubIdent);
    } finally {
      await app.close();
    }
  });

  it('serves open-world terms and searchable founder hubs without the admin API', async () => {
    const worldId = await makeWorld();
    const lockedWorldId = await makeWorld('locked');
    const mediumHub = await makeHub();
    const flagshipHub = await makeHub('flagship');
    const playerId = await makePlayer();
    const app = await buildApp({ env, db });
    try {
      const cookie = await cookieFor(playerId);
      const optionsResponse = await app.inject({
        method: 'GET',
        url: '/api/airlines/founding-options',
        headers: { cookie },
      });
      expect(optionsResponse.statusCode).toBe(200);
      const options = AirlineFoundingOptionsResponse.parse(optionsResponse.json());
      expect(options.memberships).toEqual([]);
      const openWorld = options.worlds.find((entry) => entry.id === worldId);
      expect(typeof openWorld?.name).toBe('string');
      expect(openWorld).toMatchObject({
        id: worldId,
        openingCashMinor: ECONOMY_CONFIG_V1.airlineStartingPosition.openingCashMinor,
        freeHubAllowance: ECONOMY_CONFIG_V1.airlineStartingPosition.freeHubAllowance,
        playerCap: null,
        airlines: 0,
        availability: 'available',
      });
      expect(options.worlds.map((entry) => entry.id)).not.toContain(lockedWorldId);

      const recommendedResponse = await app.inject({
        method: 'GET',
        url: '/api/airlines/founding-airports',
        headers: { cookie },
      });
      const recommended = AirlineFoundingAirportListResponse.parse(recommendedResponse.json());
      expect(recommended.query).toBe('');
      expect(recommended.airports).toContainEqual(
        expect.objectContaining({ ident: mediumHub, tier: 'medium', foundingCostMinor: 0 }),
      );
      expect(recommended.airports.map((entry) => entry.ident)).not.toContain(flagshipHub);

      const searchResponse = await app.inject({
        method: 'GET',
        url: `/api/airlines/founding-airports?q=${encodeURIComponent(flagshipHub)}`,
        headers: { cookie },
      });
      const search = AirlineFoundingAirportListResponse.parse(searchResponse.json());
      expect(search.airports).toHaveLength(1);
      expect(search.airports[0]).toMatchObject({
        ident: flagshipHub,
        tier: 'flagship',
        slotLevel: 3,
        foundingCostMinor: 0,
      });
      expect(search.airports[0]?.feeWarning).toMatch(/highest ongoing facility fees.*Level 3/i);

      expect((await foundAirline(db.db, playerId, input(worldId, mediumHub))).ok).toBe(true);
      const joinedResponse = await app.inject({
        method: 'GET',
        url: '/api/airlines/founding-options',
        headers: { cookie },
      });
      const joined = AirlineFoundingOptionsResponse.parse(joinedResponse.json());
      expect(joined.memberships).toEqual([expect.objectContaining({ worldId })]);
      expect(joined.worlds.find((entry) => entry.id === worldId)?.availability).toBe(
        'already-founded',
      );
    } finally {
      await app.close();
    }
  });

  it('offers explicitly advisory availability and name-derived alternatives over HTTP', async () => {
    const worldId = await makeWorld();
    const hubIdent = await makeHub();
    const owner = await makePlayer();
    const viewer = await makePlayer();
    expect(
      (
        await foundAirline(
          db.db,
          owner,
          input(worldId, hubIdent, { iataCode: 'TA', icaoCode: 'TAI' }),
        )
      ).ok,
    ).toBe(true);

    const app = await buildApp({ env, db });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/airlines/code-availability',
        headers: { cookie: await cookieFor(viewer) },
        payload: { worldId, name: 'Tailfin Air', iataCode: 'TA', icaoCode: 'TAI' },
      });
      expect(response.statusCode).toBe(200);
      const parsed = AirlineCodeAvailabilityResponse.parse(response.json());
      expect(parsed.advisory).toMatchObject({
        scope: 'world',
        reservation: 'none',
        realWorldCodes: 'allowed-if-free',
      });
      expect(parsed.advisory.message).toMatch(/not reserved until airline founding succeeds/);
      expect(parsed.iataCode).toMatchObject({ requested: 'TA', status: 'assigned' });
      expect(parsed.iataCode.alternatives).toHaveLength(3);
      expect(parsed.iataCode.alternatives).not.toContain('TA');
      expect(parsed.icaoCode).toMatchObject({ requested: 'TAI', status: 'assigned' });
      expect(parsed.icaoCode.alternatives).toHaveLength(3);
      expect(parsed.icaoCode.alternatives).not.toContain('TAI');
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

    const app = await buildApp({ env, db });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/airlines',
        headers: { cookie: await cookieFor(rival) },
        payload: input(worldId, hubIdent, { iataCode: 'Q1' }),
      });
      expect(response.statusCode).toBe(409);
      const refusal = AirlineCodeUnavailableError.parse(response.json());
      expect(refusal).toMatchObject({
        code: 'iata_code_taken',
        fields: { iataCode: ['Q1 is already taken in this world.'] },
        codeKind: 'iata',
        submittedCode: 'Q1',
      });
      expect(refusal.alternatives).toHaveLength(3);
      expect(refusal.alternatives).not.toContain('Q1');
      expect(refusal.advisory.message).toMatch(/not reserved until airline founding succeeds/);
      expect(response.body).toContain('Q1');
    } finally {
      await app.close();
    }
  });
});
