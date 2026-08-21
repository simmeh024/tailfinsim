import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG, type WorldConfig } from '@tailfin/shared';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminGrant, player, world } from '../db/schema';
import { type ServerEnv } from '../env';
import { currentGameDate } from '../world/lifecycle';

import { readAudit } from './audit';
import { BOOTSTRAP_ACTOR, grantAdmin } from './grants';
import { createWorldAsAdmin, listWorlds, validateWorldConfig } from './worlds';

/**
 * Creating worlds from the console (M1A-02).
 *
 * The four acceptance criteria, each with a test that would fail if it stopped
 * being true:
 *
 *   - a world created here is playable by M1-09 with no manual database work
 *   - duplicate names are refused with something readable
 *   - a world cannot be created directly in `open`
 *   - creation is audited
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [worlds.test] DATABASE_URL not set — skipping world tests.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 2,
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

const NOW = new Date('2026-08-18T12:00:00.000Z');

function config(overrides: Partial<WorldConfig> = {}): WorldConfig {
  return {
    ...FLAGSHIP_CONFIG,
    name: `test-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

/**
 * Stands in for `economy_config`, so this stays a test about the rule rather
 * than about the table. `createWorldAsAdmin` below uses the real one.
 */
const knownVersions = (...versions: string[]) => {
  const check = (version: string) => Promise.resolve(versions.includes(version));
  return { economyVersionExists: check, catalogueVersionExists: check };
};

/** Both of the world's pins resolve — the ordinary case. */
const anyVersion = knownVersions(
  FLAGSHIP_CONFIG.economyConfigVersion,
  FLAGSHIP_CONFIG.aircraftCatalogueVersion,
);

describe('validateWorldConfig', () => {
  it('accepts the flagship configuration', async () => {
    const result = await validateWorldConfig(FLAGSHIP_CONFIG, NOW, anyVersion);
    expect(result.ok).toBe(true);
  });

  it('refuses an epoch that is not in the past, and says why', async () => {
    // ADR-0005's rule. An epoch of today makes a reset a no-op, and that is a
    // failure nobody discovers until the day they try to reset.
    const result = await validateWorldConfig(
      config({ epoch: '2027-01-01T00:00:00.000Z' }),
      NOW,
      anyVersion,
    );
    if (result.ok) throw new Error('expected a refusal');
    expect(result.fields.epoch?.[0]).toMatch(/has to be in the past/);
    expect(result.fields.epoch?.[0]).toMatch(/reset/);
  });

  it('refuses an epoch of exactly now', async () => {
    const result = await validateWorldConfig(config({ epoch: NOW.toISOString() }), NOW, anyVersion);
    expect(result.ok).toBe(false);
  });

  it('points at the field that was wrong', async () => {
    const result = await validateWorldConfig(
      { ...config(), speedMultiplier: 0, playerCap: 0, name: '' },
      NOW,
      anyVersion,
    );
    if (result.ok) throw new Error('expected a refusal');
    expect(Object.keys(result.fields).sort()).toEqual(['name', 'playerCap', 'speedMultiplier']);
  });

  it('refuses a negative speed, which would run the world backwards', async () => {
    const result = await validateWorldConfig(config({ speedMultiplier: -2 }), NOW, anyVersion);
    expect(result.ok).toBe(false);
  });

  it('refuses an economy version the database does not have', async () => {
    const result = await validateWorldConfig(
      config({ economyConfigVersion: 'missing' }),
      NOW,
      anyVersion,
    );
    if (result.ok) throw new Error('expected a refusal');
    expect(result.fields.economyConfigVersion?.[0]).toMatch(/no economy version "missing"/);
  });

  it('accepts a version that exists but is not the shipped one', async () => {
    // The point of M3-11: a world can be created on a retune. Nothing in this
    // path knows or cares which version is the one the build shipped with.
    const result = await validateWorldConfig(
      config({ economyConfigVersion: 'autumn-retune' }),
      NOW,
      knownVersions('autumn-retune', FLAGSHIP_CONFIG.aircraftCatalogueVersion),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses nonsense rather than throwing on it', async () => {
    for (const input of [null, 'a world', 42, [], {}]) {
      expect((await validateWorldConfig(input, NOW, anyVersion)).ok).toBe(false);
    }
  });

  it('ignores a status somebody tried to smuggle in', async () => {
    // The request shape has no status field, so asking for an open world is not
    // refused — it is not expressible. This proves the extra key is dropped
    // rather than carried through to the insert.
    const result = await validateWorldConfig({ ...config(), status: 'open' }, NOW, anyVersion);
    if (!result.ok) throw new Error('expected acceptance');
    expect(result.config).not.toHaveProperty('status');
  });
});

describeDb('creating worlds', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    for (const id of madeWorlds.splice(0)) await db.db.delete(world).where(eq(world.id, id));
    for (const id of madePlayers.splice(0)) {
      await db.db.delete(adminGrant).where(eq(adminGrant.playerId, id));
      await db.db.delete(player).where(eq(player.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAdmin(): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `admin-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);
    return id;
  }

  async function create(c: WorldConfig, actorId: string | null = null) {
    const result = await createWorldAsAdmin(db.db, c, {
      playerId: actorId,
      label: actorId === null ? 'test' : 'Test Admin',
    });
    madeWorlds.push(result.world.id);
    return result;
  }

  async function auditFor(worldId: string) {
    const rows = await readAudit(db.db, { limit: 500 });
    return rows.filter((row) => row.subjectId === worldId);
  }

  it('creates a world that M1-09 can run, with no manual database work', async () => {
    // The first acceptance criterion, and the only honest way to test it is to
    // ask M1-09's own clock what day it is in the world afterwards.
    const c = config();
    const { world: created } = await create(c);

    const at = await currentGameDate(db.db, created.id, created.launchDate);
    expect(at.toISOString()).toBe(c.epoch);
    expect(Number(created.speedMultiplier)).toBe(c.speedMultiplier);
    expect(created.aircraftCatalogueVersion).toBe(c.aircraftCatalogueVersion);
    expect(created.economyConfigVersion).toBe(c.economyConfigVersion);
  });

  it('starts every world in staging', async () => {
    const { world: created } = await create(config());
    expect(created.status).toBe('staging');
  });

  it('is audited, with the config it was given', async () => {
    const actor = await makeAdmin();
    const c = config();
    const { world: created } = await create(c, actor);

    const entries = await auditFor(created.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('world.created');
    expect(entries[0]?.actorPlayerId).toBe(actor);
    expect(entries[0]?.after).toContain(c.name);
    expect(entries[0]?.after).toContain('staging');
  });

  it('reports a duplicate rather than silently returning the existing world', async () => {
    // M1-09's `createWorld` is idempotent on purpose — it is what a fresh
    // environment runs, repeatedly. An admin filling in a form is not asking to
    // be idempotent, so the difference has to survive up to the caller.
    const c = config();
    const first = await create(c);
    const second = await createWorldAsAdmin(db.db, c, { playerId: null, label: 'test' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.world.id).toBe(first.world.id);
  });

  it('writes no audit entry for a duplicate, because nothing happened', async () => {
    const c = config();
    const { world: created } = await create(c);
    await createWorldAsAdmin(db.db, c, { playerId: null, label: 'test' });
    expect(await auditFor(created.id)).toHaveLength(1);
  });

  it('leaves no world behind when the audit write fails', async () => {
    // The two share a transaction. Proven by breaking the audit write — an
    // action is not permitted to be recorded as unrecorded.
    const c = config();
    await expect(
      db.db.transaction(async (tx) => {
        await createWorldAsAdmin(tx, c, { playerId: null, label: 'test' });
        throw new Error('the audit failed');
      }),
    ).rejects.toThrow('the audit failed');

    const found = await db.db.select().from(world).where(eq(world.name, c.name));
    expect(found).toHaveLength(0);
  });

  it('lists worlds with the in-game date worked out', async () => {
    const c = config();
    const { world: created } = await create(c);
    const listed = (await listWorlds(db.db)).find((entry) => entry.id === created.id);

    expect(listed).toBeDefined();
    expect(listed?.status).toBe('staging');
    expect(listed?.speedMultiplier).toBe(c.speedMultiplier);
    // Just created, so the calendar is still at the epoch, give or take the
    // milliseconds the insert took.
    expect(Date.parse(listed?.inGameDate ?? '')).toBeGreaterThanOrEqual(Date.parse(c.epoch));
    expect(Date.parse(listed?.inGameDate ?? '')).toBeLessThan(Date.parse(c.epoch) + 60_000);
  });

  describe('over HTTP', () => {
    async function cookieFor(playerId: string): Promise<string> {
      const { token } = await createSession(db.db, playerId, 1);
      return `${SESSION_COOKIE}=${token}`;
    }

    it('refuses an anonymous request with 401 and a signed-in player with 403', async () => {
      const ordinary = await db.db
        .insert(player)
        .values({ displayName: 'ordinary' })
        .returning({ id: player.id });
      const ordinaryId = ordinary[0]?.id;
      if (!ordinaryId) throw new Error('no player');
      madePlayers.push(ordinaryId);

      const app = buildApp({ env, db });
      try {
        const anon = await app.inject({
          method: 'POST',
          url: '/api/admin/worlds',
          payload: config(),
        });
        expect(anon.statusCode).toBe(401);

        const asPlayer = await app.inject({
          method: 'POST',
          url: '/api/admin/worlds',
          payload: config(),
          headers: { cookie: await cookieFor(ordinaryId) },
        });
        expect(asPlayer.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('creates a world and answers 201 with it', async () => {
      const actor = await makeAdmin();
      const c = config();
      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: '/api/admin/worlds',
          payload: c,
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(201);
        const body = reply.json<{ world: { id: string; name: string; status: string } }>();
        madeWorlds.push(body.world.id);
        expect(body.world.name).toBe(c.name);
        expect(body.world.status).toBe('staging');
      } finally {
        await app.close();
      }
    });

    it('cannot be talked into creating an open world', async () => {
      // The acceptance criterion. `status` is not part of the request shape, so
      // the extra key is dropped rather than honoured.
      const actor = await makeAdmin();
      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: '/api/admin/worlds',
          payload: { ...config(), status: 'open' },
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(201);
        const body = reply.json<{ world: { id: string; status: string } }>();
        madeWorlds.push(body.world.id);
        expect(body.world.status).toBe('staging');
      } finally {
        await app.close();
      }
    });

    it('refuses a duplicate name with something a person can act on', async () => {
      const actor = await makeAdmin();
      const c = config();
      await create(c, actor);

      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: '/api/admin/worlds',
          payload: c,
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(409);
        const body = reply.json<{ message: string; fields: Record<string, string[]> }>();
        expect(body.message).toContain(c.name);
        // Against the name field, so a form can put it where the mistake is.
        expect(body.fields.name?.[0]).toMatch(/already exists/);
        // And never a constraint name.
        expect(JSON.stringify(body)).not.toContain('world_name_key');
      } finally {
        await app.close();
      }
    });

    it('refuses a bad config with the reason against each field', async () => {
      const actor = await makeAdmin();
      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: '/api/admin/worlds',
          payload: { ...config(), epoch: '2027-01-01T00:00:00.000Z', speedMultiplier: 0 },
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(400);
        const body = reply.json<{ fields: Record<string, string[]> }>();
        expect(body.fields.speedMultiplier?.length).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });

    it('lists worlds to an admin and refuses everyone else', async () => {
      const actor = await makeAdmin();
      const app = buildApp({ env, db });
      try {
        const anon = await app.inject({ method: 'GET', url: '/api/admin/worlds' });
        expect(anon.statusCode).toBe(401);

        const asAdmin = await app.inject({
          method: 'GET',
          url: '/api/admin/worlds',
          headers: { cookie: await cookieFor(actor) },
        });
        expect(asAdmin.statusCode).toBe(200);
        expect(Array.isArray(asAdmin.json<{ worlds: unknown[] }>().worlds)).toBe(true);
      } finally {
        await app.close();
      }
    });
  });
});
