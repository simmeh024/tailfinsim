import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  FLAGSHIP_CONFIG,
  ForceRenameAirlineResponse,
  type CreateAirlineInput,
} from '@tailfin/shared';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminAudit, adminGrant, airline, airlineHub, airport, player, world } from '../db/schema';
import { type ServerEnv } from '../env';
import { createWorld } from '../world/lifecycle';

import { foundAirline } from './found';
import { forceRenameAirline } from './rename';

/** AIR-02 against real PostgreSQL: remedy, audit and HTTP authorization. */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [identity.test] DATABASE_URL not set — skipping identity DB tests.\n');
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

describeDb('airline identity moderation', () => {
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
      const ids = madePlayers.splice(0);
      await db.db.delete(adminGrant).where(inArray(adminGrant.playerId, ids));
      await db.db.delete(player).where(inArray(player.id, ids));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makePlayer(label = 'identity-player'): Promise<string> {
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
      name: `identity-${letters(sequence++, 6)}`,
    });
    madeWorlds.push(result.world.id);
    await db.db.update(world).set({ status: 'open' }).where(eq(world.id, result.world.id));
    return result.world.id;
  }

  async function makeHub(): Promise<string> {
    const n = sequence++;
    const ident = `ID-${String(n)}`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: 9_100_000 + n,
        ident,
        name: `Identity Hub ${String(n)}`,
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

  async function makeAirline() {
    const n = sequence++;
    const input: CreateAirlineInput = {
      worldId: await makeWorld(),
      name: 'Tailfin Original',
      iataCode: letters(n, 2),
      icaoCode: letters(n, 3),
      callsign: `TAILFIN ${String(n)}`,
      baseCountry: 'NL',
      hubIdent: await makeHub(),
    };
    const result = await foundAirline(db.db, await makePlayer('owner'), input);
    if (!result.ok) throw new Error(`founding refused: ${result.kind}`);
    return result;
  }

  async function auditFor(airlineId: string) {
    return db.db.select().from(adminAudit).where(eq(adminAudit.subjectId, airlineId));
  }

  async function cookieFor(playerId: string): Promise<string> {
    const { token } = await createSession(db.db, playerId, 1);
    return `${SESSION_COOKIE}=${token}`;
  }

  it('renames the stable airline, keeps its codes and hub, and audits both identities', async () => {
    const founded = await makeAirline();
    const result = await forceRenameAirline(
      db.db,
      founded.airline.id,
      {
        name: '航空会社 Horizon',
        callsign: 'HORIZON',
        reason: 'Resolved a reported identity conflict.',
      },
      { playerId: null, label: 'identity test moderator', requestId: 'air-02-test' },
    );
    if (!result.ok) throw new Error(`rename refused: ${result.kind}`);

    expect(result.changed).toBe(true);
    expect(result.airline).toMatchObject({
      id: founded.airline.id,
      name: '航空会社 Horizon',
      callsign: 'HORIZON',
      iataCode: founded.airline.iataCode,
      icaoCode: founded.airline.icaoCode,
    });
    expect(
      await db.db.select().from(airlineHub).where(eq(airlineHub.airlineId, result.airline.id)),
    ).toHaveLength(1);

    const entries = await auditFor(result.airline.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorLabel: 'identity test moderator',
      action: 'airline.identity_changed',
      subjectType: 'airline',
      requestId: 'air-02-test',
    });
    expect(JSON.parse(entries[0]?.before ?? '{}')).toMatchObject({
      name: 'Tailfin Original',
      callsign: founded.airline.callsign,
    });
    expect(JSON.parse(entries[0]?.after ?? '{}')).toMatchObject({
      name: '航空会社 Horizon',
      callsign: 'HORIZON',
      reason: 'Resolved a reported identity conflict.',
    });
  });

  it('does not write or audit when the injected policy refuses the callsign', async () => {
    const founded = await makeAirline();
    const result = await forceRenameAirline(
      db.db,
      founded.airline.id,
      { name: 'Valid New Name', callsign: 'RESERVED', reason: 'policy check' },
      { playerId: null, label: 'moderator' },
      {
        identityModerator: {
          review: () =>
            Promise.resolve({
              accepted: false,
              field: 'callsign',
              reason: 'That callsign is reserved.',
            }),
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      kind: 'identity-refused',
      field: 'callsign',
      reason: 'That callsign is reserved.',
    });
    expect(
      await db.db.select().from(airline).where(eq(airline.id, founded.airline.id)),
    ).toMatchObject([{ name: founded.airline.name, callsign: founded.airline.callsign }]);
    expect(await auditFor(founded.airline.id)).toHaveLength(0);
  });

  it('treats an identical correction as a no-op and reports an unknown airline cleanly', async () => {
    const founded = await makeAirline();
    const unchanged = await forceRenameAirline(
      db.db,
      founded.airline.id,
      {
        name: founded.airline.name,
        callsign: founded.airline.callsign,
        reason: 'Repeated moderation command.',
      },
      { playerId: null, label: 'moderator' },
    );
    expect(unchanged).toMatchObject({ ok: true, changed: false });
    expect(await auditFor(founded.airline.id)).toHaveLength(0);

    expect(
      await forceRenameAirline(
        db.db,
        '00000000-0000-4000-8000-000000000000',
        { name: 'Valid Name', callsign: 'VALID', reason: 'reported content' },
        { playerId: null, label: 'moderator' },
      ),
    ).toEqual({
      ok: false,
      kind: 'airline-not-found',
      airlineId: '00000000-0000-4000-8000-000000000000',
    });
  });

  it('exposes an authenticated, audited admin remedy with shared field errors', async () => {
    const founded = await makeAirline();
    const adminId = await makePlayer('moderator');
    await db.db.insert(adminGrant).values({ playerId: adminId });
    const app = buildApp({ env, db });
    try {
      const invalid = await app.inject({
        method: 'PATCH',
        url: `/api/admin/airlines/${founded.airline.id}/identity`,
        headers: { cookie: await cookieFor(adminId) },
        payload: { name: 'Bad ✈', callsign: 'lowercase', reason: '' },
      });
      expect(invalid.statusCode).toBe(400);
      const refusal = invalid.json<{ code: string; fields: Record<string, string[]> }>();
      expect(refusal.code).toBe('invalid_airline_identity');
      expect(refusal.fields.name?.join(' ')).toMatch(/may contain only/);
      expect(refusal.fields.callsign?.join(' ')).toMatch(/uppercase Latin/);
      expect(refusal.fields.reason?.join(' ')).toMatch(/audit log/);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/airlines/${founded.airline.id}/identity`,
        headers: { cookie: await cookieFor(adminId) },
        payload: {
          name: 'Air Côte d’Ivoire',
          callsign: 'COTE IVOIRE',
          reason: 'Player accepted the moderation correction.',
        },
      });
      expect(response.statusCode).toBe(200);
      const parsed = ForceRenameAirlineResponse.parse(response.json());
      expect(parsed).toMatchObject({
        changed: true,
        airline: { id: founded.airline.id, name: 'Air Côte d’Ivoire', callsign: 'COTE IVOIRE' },
      });
      expect(await auditFor(founded.airline.id)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('keeps the admin remedy behind requireAdmin', async () => {
    const founded = await makeAirline();
    const nonAdmin = await makePlayer('not-admin');
    const app = buildApp({ env, db });
    const request = {
      method: 'PATCH' as const,
      url: `/api/admin/airlines/${founded.airline.id}/identity`,
      payload: { name: 'New Name', callsign: 'NEW NAME', reason: 'should not run' },
    };
    try {
      expect((await app.inject(request)).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            ...request,
            headers: { cookie: await cookieFor(nonAdmin) },
          })
        ).statusCode,
      ).toBe(403);
      expect(await auditFor(founded.airline.id)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
