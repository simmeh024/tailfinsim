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
  adminSessionTtlHours: 12,
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
    const rows = await readAudit(db.db, { limit: 500 });
    return rows.filter((row) => row.subjectId === subjectId);
  }

  /**
   * The whole error chain of a statement that must fail.
   *
   * Drizzle wraps a driver error in its own `Failed query: …`, so asserting on
   * the outer message would pass for *any* failure — a missing table, a bad
   * column, a dropped connection. The trigger's own words are in the cause, and
   * they are the thing these tests are actually about, so the chain is walked
   * and matched whole.
   */
  async function refusalFor(statement: PromiseLike<unknown>): Promise<string> {
    try {
      await statement;
    } catch (error) {
      const chain: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        chain.push(current.message);
        current = current.cause;
      }
      return chain.join(' | ');
    }
    throw new Error('expected the statement to be refused, but it succeeded');
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

      const refusal = await refusalFor(
        db.db
          .update(adminAudit)
          .set({ actorLabel: 'someone else' })
          .where(eq(adminAudit.subjectId, id)),
      );
      expect(refusal).toMatch(/append-only/);
      expect(refusal).toMatch(/UPDATE/);
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

      const refusal = await refusalFor(
        db.db.delete(adminAudit).where(eq(adminAudit.subjectId, id)),
      );
      expect(refusal).toMatch(/append-only/);
      expect(refusal).toMatch(/DELETE/);
    });

    it('rejects TRUNCATE, which row triggers would not catch', async () => {
      // TRUNCATE bypasses row-level triggers. Without a statement-level one the
      // entire log could be emptied in a single statement while both row
      // triggers looked on.
      const refusal = await refusalFor(db.db.execute(sql`truncate table admin_audit`));
      expect(refusal).toMatch(/append-only/);
      expect(refusal).toMatch(/TRUNCATE/);
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

      await refusalFor(db.db.delete(adminAudit).where(eq(adminAudit.subjectId, id)));
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

    it('rejects a session minted before elevation until the player signs in again', async () => {
      const id = await makePlayer('rotated-grantee');
      const { token: beforeGrant } = await createSession(db.db, id, 24);
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);

      const app = buildApp({ env, db });
      try {
        const stale = await app.inject({
          method: 'GET',
          url: '/api/admin/admins',
          cookies: { [SESSION_COOKIE]: beforeGrant },
        });
        expect(stale.statusCode).toBe(401);

        const { token: afterGrant } = await createSession(db.db, id, env.adminSessionTtlHours);
        const fresh = await app.inject({
          method: 'GET',
          url: '/api/admin/admins',
          cookies: { [SESSION_COOKIE]: afterGrant },
        });
        expect(fresh.statusCode).toBe(200);
      } finally {
        await app.close();
      }
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
      //
      // Set up **inside a transaction that always rolls back**. Proving the guard
      // requires being the only admin, and the first version of this cleared the
      // grant table to arrange that — which is fine against a throwaway CI
      // database and destructive against any other. It was run against dev once
      // and revoked a real person's access. A test must not be able to do that,
      // whatever it is pointed at.
      const only = await makePlayer('only-admin');

      await expect(
        db.db.transaction(async (tx) => {
          await tx.delete(adminGrant);
          await grantAdmin(tx, only, BOOTSTRAP_ACTOR);
          await revokeAdmin(tx, only, BOOTSTRAP_ACTOR);
        }),
      ).rejects.toThrow(/last admin/);

      // The rollback took the setup with it, so nothing outside this test moved.
      expect(await isAdmin(db.db, only)).toBe(false);
    });

    it('leaves other grants alone when it refuses', async () => {
      // The guard counts grants; a bug that counted rows of the wrong table, or
      // deleted before counting, would show up here rather than in production.
      const keeper = await makePlayer('untouched');
      await grantAdmin(db.db, keeper, BOOTSTRAP_ACTOR);
      const second = await makePlayer('second');
      await grantAdmin(db.db, second, BOOTSTRAP_ACTOR);

      await revokeAdmin(db.db, second, BOOTSTRAP_ACTOR);
      expect(await isAdmin(db.db, keeper)).toBe(true);
    });

    it('invalidates privileged sessions at the same commit as revocation', async () => {
      const keeper = await makePlayer('rotation-keeper');
      await grantAdmin(db.db, keeper, BOOTSTRAP_ACTOR);
      const target = await makePlayer('rotation-target');
      await grantAdmin(db.db, target, BOOTSTRAP_ACTOR);
      const { token } = await createSession(db.db, target, env.adminSessionTtlHours);

      await revokeAdmin(db.db, target, BOOTSTRAP_ACTOR);

      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'GET',
          url: '/api/admin/admins',
          cookies: { [SESSION_COOKIE]: token },
        });
        expect(reply.statusCode).toBe(401);
      } finally {
        await app.close();
      }
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

    it('carry the before and after through serialisation intact', async () => {
      // Fastify serialises through the JSON Schema and strips anything the
      // schema does not admit. `before` and `after` are open-ended records, which
      // is exactly the shape a serialiser is most likely to quietly empty — and
      // an audit entry that says a change happened but not what it changed is
      // half an audit entry.
      const id = await makePlayer('payload');
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);

      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'GET',
          url: '/api/admin/audit',
          headers: { cookie: await sessionCookie(id) },
        });

        const body = reply.json<{
          entries: { subjectId: string | null; before: unknown; after: unknown }[];
        }>();
        const entry = body.entries.find((e) => e.subjectId === id);
        expect(entry).toBeDefined();
        expect(entry?.before).toEqual({ admin: false });
        expect(entry?.after).toMatchObject({ admin: true });
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

    it('lets an admin immediately revoke every target session and audits only the count', async () => {
      const operator = await makePlayer('session-operator');
      await grantAdmin(db.db, operator, BOOTSTRAP_ACTOR);
      const target = await makePlayer('session-target');
      const first = await createSession(db.db, target, 24);
      const second = await createSession(db.db, target, 24);

      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: `/api/admin/players/${target}/sessions/revoke`,
          headers: { cookie: await sessionCookie(operator) },
        });
        expect(reply.statusCode).toBe(200);
        expect(reply.json()).toEqual({ signedOut: true, revokedSessions: 2 });

        for (const token of [first.token, second.token]) {
          const replay = await app.inject({
            method: 'GET',
            url: '/api/me',
            cookies: { [SESSION_COOKIE]: token },
          });
          expect(replay.json()).toMatchObject({ player: null });
        }

        const audit = (await auditFor(target)).find((row) => row.action === 'sessions.revoked');
        expect(audit?.after).toBe(JSON.stringify({ result: 'success', revokedSessions: 2 }));
        expect(audit?.after).not.toContain(first.token);
        expect(audit?.after).not.toContain(second.token);
      } finally {
        await app.close();
      }
    });
  });
});
