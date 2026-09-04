import crypto from 'node:crypto';

import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminGrant, player, session } from '../db/schema';
import { type ServerEnv } from '../env';

import { type AdminRole } from './capabilities';
import { BOOTSTRAP_ACTOR, grantAdmin } from './grants';

import type { FastifyInstance } from 'fastify';

/**
 * Roles are enforced by the running server, not merely modelled (M11-01, §22.1).
 *
 * `capabilities.test.ts` proves the model; this proves the boundary. A Support
 * administrator is a real, signed-in administrator — `requireAdmin` would let
 * them through every route in the console — and the point of the capability
 * gate is that it does not. Requires `DATABASE_URL`; CI provides it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [admin/role-enforcement.test] DATABASE_URL not set — skipping.\n');
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
  sessionSecret: 's'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

/** A well-formed id that names nothing, so a permitted route still changes nothing. */
const ABSENT = '00000000-0000-4000-8000-0000000000ff';

describeDb('administrator roles are enforced by the server', () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const madePlayers: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    app = await buildApp({ env, db });
  });

  afterAll(async () => {
    const ids = madePlayers.splice(0);
    if (ids.length > 0) {
      await db.db.delete(session).where(inArray(session.playerId, ids));
      await db.db.delete(adminGrant).where(inArray(adminGrant.playerId, ids));
      // `admin_audit` is deliberately left alone: it is append-only and a trigger
      // refuses DELETE (migration 0008). Its actor/subject are not foreign keys
      // precisely so the log outlives the accounts it describes, which is why
      // removing the players below is safe with the rows still there.
      await db.db.delete(player).where(inArray(player.id, ids));
    }
    await app.close();
    await db.close();
  });

  /** An administrator holding exactly `role`, and the cookie that proves it. */
  async function adminWith(role: AdminRole): Promise<string> {
    const id = crypto.randomUUID();
    await db.db.insert(player).values({ id, displayName: `Role ${role} ${id.slice(0, 6)}` });
    madePlayers.push(id);
    await grantAdmin(db.db, id, BOOTSTRAP_ACTOR, role);
    // Granting rotates sessions, so the credential is minted after the grant.
    const made = await createSession(db.db, id, env.adminSessionTtlHours);
    return `${SESSION_COOKIE}=${made.token}`;
  }

  async function status(cookie: string, method: 'GET' | 'POST', target: string): Promise<number> {
    const response = await app.inject({
      method,
      url: target,
      headers: { cookie },
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    return response.statusCode;
  }

  it('lets Support read the console', async () => {
    const cookie = await adminWith('support');
    expect(await status(cookie, 'GET', '/api/admin/players')).toBe(200);
    expect(await status(cookie, 'GET', '/api/admin/worlds')).toBe(200);
  });

  it('refuses Support every mutation, including the destructive ones', async () => {
    const cookie = await adminWith('support');
    // A real administrator by the old boolean; none of these by capability.
    expect(await status(cookie, 'POST', '/api/admin/worlds')).toBe(403);
    expect(await status(cookie, 'POST', `/api/admin/worlds/${ABSENT}/reset`)).toBe(403);
    expect(await status(cookie, 'POST', `/api/admin/worlds/${ABSENT}/speed`)).toBe(403);
    expect(await status(cookie, 'POST', '/api/admin/economy-config')).toBe(403);
    expect(await status(cookie, 'POST', `/api/admin/players/${ABSENT}/sessions/revoke`)).toBe(403);
  });

  it('separates the economist from the world administrator', async () => {
    const economist = await adminWith('economist');
    const worldAdmin = await adminWith('world_admin');

    // The economist may publish a version and may not touch the world lifecycle.
    expect(await status(economist, 'POST', '/api/admin/economy-config')).not.toBe(403);
    expect(await status(economist, 'POST', '/api/admin/worlds')).toBe(403);
    expect(await status(economist, 'POST', `/api/admin/worlds/${ABSENT}/reset`)).toBe(403);

    // The world administrator is the mirror image.
    expect(await status(worldAdmin, 'POST', '/api/admin/worlds')).not.toBe(403);
    expect(await status(worldAdmin, 'POST', '/api/admin/economy-config')).toBe(403);
  });

  it('gives the game master player remedies but not the world', async () => {
    const cookie = await adminWith('game_master');
    expect(await status(cookie, 'POST', `/api/admin/players/${ABSENT}/sessions/revoke`)).not.toBe(
      403,
    );
    expect(await status(cookie, 'POST', `/api/admin/worlds/${ABSENT}/reset`)).toBe(403);
    expect(await status(cookie, 'POST', '/api/admin/economy-config')).toBe(403);
  });

  it('still lets a super_admin do everything, as every grant did before roles', async () => {
    const cookie = await adminWith('super_admin');
    for (const target of ['/api/admin/worlds', '/api/admin/economy-config']) {
      expect(await status(cookie, 'POST', target)).not.toBe(403);
    }
    expect(await status(cookie, 'GET', '/api/admin/players')).toBe(200);
  });

  it('refuses a signed-in non-admin the same way, saying nothing extra', async () => {
    const id = crypto.randomUUID();
    await db.db.insert(player).values({ id, displayName: 'Not an admin' });
    madePlayers.push(id);
    const made = await createSession(db.db, id, env.sessionTtlHours);
    const cookie = `${SESSION_COOKIE}=${made.token}`;

    const refused = await app.inject({
      method: 'GET',
      url: '/api/admin/players',
      headers: { cookie },
    });
    expect(refused.statusCode).toBe(403);

    // The capability refusal must be byte-identical to the plain admin refusal,
    // so probing the console cannot map which role owns which route.
    const supportCookie = await adminWith('support');
    const capabilityRefused = await app.inject({
      method: 'POST',
      url: '/api/admin/worlds',
      headers: { cookie: supportCookie },
      payload: {},
    });
    expect(capabilityRefused.statusCode).toBe(403);
    expect(capabilityRefused.body).toBe(refused.body);
  });
});
