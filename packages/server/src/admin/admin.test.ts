import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminAudit, adminGrant, player } from '../db/schema';
import { type ServerEnv } from '../env';

import { readAudit, writeAudit } from './audit';
import { BOOTSTRAP_ACTOR, grantAdmin, isAdmin, listAdmins, revokeAdmin } from './grants';

/**
 * Admin grants, the audit log, and the gate in front of both (M1A-01).
 *
 * The tests that can actually fail:
 *
 *   - **The audit table refuses UPDATE, DELETE and TRUNCATE.** That is the whole
 *     point of the table, and it is enforced by a database trigger rather than by
 *     this codebase remembering not to. TRUNCATE gets its own case because it
 *     bypasses row-level triggers entirely — the hole a determined person finds.
 *   - **A non-admin session gets 403 from every admin route**, and an anonymous
 *     one gets 401, because those mean different things to a client.
 *   - **The audit row and its change share a transaction**, so a change that
 *     rolls back cannot leave a record claiming it happened.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [admin.test] DATABASE_URL not set — skipping admin tests.\n');
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
  allowRegistration: false,
};

describeDb('admin', () => {
  let db: DatabaseHandle;
  const madePlayers: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    for (const id of madePlayers.splice(0)) {
      await db.db.delete(adminGrant).where(eq(adminGrant.playerId, id));
      await db.db.delete(player).where(eq(player.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makePlayer(name: string): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `${name}-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    return id;
  }

  /** Audit rows written by this test run, newest first. Never deleted — it cannot be. */
  async function auditFor(subjectId: string) {
    const rows = await readAudit(db.db, 500);
    return rows.filter((row) => row.subjectId === subjectId);
  }

  describe('the audit log is append-only', () => {
    it('rejects UPDATE', async () => {
      const id = await makePlayer('update-victim');
      await writeAudit(db.db, {
        actorPlayerId: null,
        actorLabel: 'test',
        action: 'admin.granted',
        subjectType: 'player',
        subjectId: id,
      });

      await expect(
        db.db
          .update(adminAudit)
          .set({ actorLabel: 'someone else' })
          .where(eq(adminAudit.subjectId, id)),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects DELETE', async () => {
      const id = await makePlayer('delete-victim');
      await writeAudit(db.db, {
        actorPlayerId: null,
        actorLabel: 'test',
        action: 'admin.granted',
        subjectType: 'player',
        subjectId: id,
      });

      await expect(db.db.delete(adminAudit).where(eq(adminAudit.subjectId, id))).rejects.toThrow(
        /append-only/,
      );
    });

    it('rejects TRUNCATE, which row triggers would not catch', async () => {
      // TRUNCATE bypasses row-level triggers. Without a statement-level one the
      // entire log could be emptied in a single statement while both row
      // triggers looked on.
      await expect(db.db.execute(sql`truncate table admin_audit`)).rejects.toThrow(/append-only/);
    });

    it('survives the attempt intact', async () => {
      const id = await makePlayer('survivor');
      await writeAudit(db.db, {
        actorPlayerId: null,
        actorLabel: 'test',
        action: 'admin.granted',
        subjectType: 'player',
        subjectId: id,
      });

      await expect(db.db.delete(adminAudit).where(eq(adminAudit.subjectId, id))).rejects.toThrow();
      expect(await auditFor(id)).toHaveLength(1);
    });
  });

  describe('granting', () => {
    it('makes someone an admin, and says so', async () => {
      const id = await makePlayer('grantee');
      expect(await isAdmin(db.db, id)).toBe(false);

      const result = await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);
      expect(result.changed).toBe(true);
      expect(await isAdmin(db.db, id)).toBe(true);
    });

    it('is audited', async () => {
      // The acceptance criterion: granting admin is itself audited.
      const id = await makePlayer('audited-grantee');
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);

      const entries = await auditFor(id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe('admin.granted');
      expect(entries[0]?.actorLabel).toBe(BOOTSTRAP_ACTOR.label);
      expect(entries[0]?.actorPlayerId).toBeNull();
    });

    it('is idempotent, and a second grant writes no second entry', async () => {
      // A log full of "granted admin to someone who already had it" is a log
      // people stop reading.
      const id = await makePlayer('twice');
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);
      const again = await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);

      expect(again.changed).toBe(false);
      expect(await auditFor(id)).toHaveLength(1);
    });

    it('refuses a player that does not exist', async () => {
      await expect(
        grantAdmin(db.db, '00000000-0000-0000-0000-000000000000', BOOTSTRAP_ACTOR),
      ).rejects.toThrow(/No player/);
    });

    it('records who granted it', async () => {
      const granter = await makePlayer('granter');
      await grantAdmin(db.db, granter, BOOTSTRAP_ACTOR);
      const grantee = await makePlayer('grantee-by-admin');
      await grantAdmin(db.db, grantee, { playerId: granter, label: 'Granter' });

      const admins = await listAdmins(db.db);
      const entry = admins.find((a) => a.playerId === grantee);
      expect(entry?.grantedByPlayerId).toBe(granter);
      expect(entry?.grantedByLabel).not.toBeNull();
    });
  });

  describe('revoking', () => {
    it('takes admin away, and is audited', async () => {
      const keeper = await makePlayer('keeper');
      await grantAdmin(db.db, keeper, BOOTSTRAP_ACTOR);
      const loser = await makePlayer('loser');
      await grantAdmin(db.db, loser, BOOTSTRAP_ACTOR);

      const result = await revokeAdmin(db.db, loser, BOOTSTRAP_ACTOR);
      expect(result.changed).toBe(true);
      expect(await isAdmin(db.db, loser)).toBe(false);

      const actions = (await auditFor(loser)).map((row) => row.action);
      expect(actions).toContain('admin.revoked');
    });

    it('is idempotent for someone who was never an admin', async () => {
      const id = await makePlayer('never');
      const result = await revokeAdmin(db.db, id, BOOTSTRAP_ACTOR);
      expect(result.changed).toBe(false);
      expect(await auditFor(id)).toHaveLength(0);
    });

    it('refuses to remove the last admin', async () => {
      // Nobody could grant another without a shell on the server, so this is the
      // one misclick that must not be possible.
      await db.db.delete(adminGrant);
      const only = await makePlayer('only-admin');
      await grantAdmin(db.db, only, BOOTSTRAP_ACTOR);

      await expect(revokeAdmin(db.db, only, BOOTSTRAP_ACTOR)).rejects.toThrow(/last admin/);
      expect(await isAdmin(db.db, only)).toBe(true);
    });
  });

  describe('the audit row and the change share a transaction', () => {
    it('leaves no record when the change rolls back', async () => {
      // The criterion, and the reason `writeAudit` takes a transaction rather
      // than opening one. A row written after the fact is a row that goes missing
      // exactly when the change was the one somebody wanted hidden.
      const id = await makePlayer('rolled-back');

      await expect(
        db.db.transaction(async (tx) => {
          await writeAudit(tx, {
            actorPlayerId: null,
            actorLabel: 'test',
            action: 'admin.granted',
            subjectType: 'player',
            subjectId: id,
          });
          throw new Error('the change failed');
        }),
      ).rejects.toThrow('the change failed');

      expect(await auditFor(id)).toHaveLength(0);
    });

    it('keeps the record when the change commits', async () => {
      const id = await makePlayer('committed');
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);
      expect(await isAdmin(db.db, id)).toBe(true);
      expect(await auditFor(id)).toHaveLength(1);
    });
  });

  describe('the admin routes', () => {
    const ADMIN_ROUTES = ['/api/admin/audit', '/api/admin/admins'];

    async function sessionCookie(playerId: string): Promise<string> {
      const { token } = await createSession(db.db, playerId, 1);
      return `${SESSION_COOKIE}=${token}`;
    }

    it('answer 401 to an anonymous request', async () => {
      const app = buildApp({ env, db });
      try {
        for (const route of ADMIN_ROUTES) {
          const reply = await app.inject({ method: 'GET', url: route });
          expect(reply.statusCode, route).toBe(401);
        }
      } finally {
        await app.close();
      }
    });

    it('answer 403 to a signed-in player without a grant', async () => {
      // Not 401: signing in again would not help, and a client that treats every
      // refusal as "session expired" would loop for ever.
      const id = await makePlayer('ordinary');
      const app = buildApp({ env, db });
      try {
        const cookie = await sessionCookie(id);
        for (const route of ADMIN_ROUTES) {
          const reply = await app.inject({ method: 'GET', url: route, headers: { cookie } });
          expect(reply.statusCode, route).toBe(403);
        }
      } finally {
        await app.close();
      }
    });

    it('answer 200 to an admin', async () => {
      const id = await makePlayer('console-user');
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);
      const app = buildApp({ env, db });
      try {
        const cookie = await sessionCookie(id);
        for (const route of ADMIN_ROUTES) {
          const reply = await app.inject({ method: 'GET', url: route, headers: { cookie } });
          expect(reply.statusCode, route).toBe(200);
        }
      } finally {
        await app.close();
      }
    });

    it('tell /api/me whether the player is an admin', async () => {
      const ordinary = await makePlayer('me-ordinary');
      const elevated = await makePlayer('me-admin');
      await grantAdmin(db.db, elevated, BOOTSTRAP_ACTOR);

      const app = buildApp({ env, db });
      try {
        const anonymous = await app.inject({ method: 'GET', url: '/api/me' });
        expect(anonymous.json<{ isAdmin: boolean }>().isAdmin).toBe(false);

        const asPlayer = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { cookie: await sessionCookie(ordinary) },
        });
        expect(asPlayer.json<{ isAdmin: boolean }>().isAdmin).toBe(false);

        const asAdmin = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { cookie: await sessionCookie(elevated) },
        });
        expect(asAdmin.json<{ isAdmin: boolean }>().isAdmin).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('do not leak what the console contains to someone refused', async () => {
      const id = await makePlayer('nosy');
      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'GET',
          url: '/api/admin/audit',
          headers: { cookie: await sessionCookie(id) },
        });
        expect(reply.statusCode).toBe(403);
        expect(reply.body).not.toContain('entries');
        expect(reply.body).not.toContain('actorLabel');
      } finally {
        await app.close();
      }
    });
  });
});
