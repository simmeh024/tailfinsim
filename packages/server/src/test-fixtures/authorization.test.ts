import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { player } from '../db/schema';
import { type ServerEnv } from '../env';

import { createAuthorizationTestSuite, type AuthorizationTestSuite } from './authorization';

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn(
    '\n  [authorization.test] DATABASE_URL not set — skipping authorization fixtures.\n',
  );
}
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

describeDb('authorization test fixtures', () => {
  let db: DatabaseHandle;
  let authorization: AuthorizationTestSuite;

  beforeAll(async () => {
    db = createDatabase();
    authorization = await createAuthorizationTestSuite({
      db,
      env,
      suite: 'authorization-framework-main',
    });
  });

  afterAll(async () => {
    await authorization.cleanup();
    await db.close();
  });

  it('creates distinct players with real cookies and a credential-free guest', () => {
    const { identities } = authorization;
    expect(identities.guest).toMatchObject({ playerId: null, cookie: undefined });
    expect(
      new Set([identities.playerA.playerId, identities.playerB.playerId, identities.admin.playerId])
        .size,
    ).toBe(3);
    expect(identities.playerA.cookie).toMatch(/^tailfin_session=/);
    expect(identities.playerB.cookie).toMatch(/^tailfin_session=/);
    expect(identities.admin.cookie).toMatch(/^tailfin_session=/);
  });

  it('expresses the complete actor matrix in one request case', async () => {
    await authorization.expectAuthorization({
      request: { method: 'GET', url: '/api/admin/overview' },
      guest: 401,
      playerA: 403,
      playerB: 403,
      admin: 200,
    });
  });

  it('replaces any caller-supplied cookie with the matrix actor', async () => {
    const adminCookie = authorization.identities.admin.cookie!;
    await authorization.expectAuthorization({
      request: {
        method: 'GET',
        url: '/api/admin/overview',
        headers: { Cookie: adminCookie },
        cookies: { tailfin_session: adminCookie.slice(adminCookie.indexOf('=') + 1) },
      },
      guest: 401,
      playerA: 403,
      playerB: 403,
      admin: 200,
    });
  });

  it('reports a failure as an incident: actor, request, both statuses and the meaning', async () => {
    // Contrived: the administrator *is* allowed here, so demanding a refusal
    // makes the fixture report the direction that matters most (SEC-12).
    const failing = authorization.expectAuthorization({
      request: { method: 'GET', url: '/api/admin/overview' },
      guest: 401,
      playerA: 403,
      playerB: 403,
      admin: 418,
    });
    await expect(failing).rejects.toThrow(/1 AUTHORIZATION BREACH on GET \/api\/admin\/overview/);
    await expect(failing).rejects.toThrow(
      /AUTHORIZATION BREACH · admin · GET \/api\/admin\/overview · expected 418 · received 200 · access GRANTED where it must be refused/,
    );
  });

  it('cleans only its identities and recreates their deterministic ids', async () => {
    const first = await createAuthorizationTestSuite({
      db,
      env,
      suite: 'authorization-framework-cleanup',
    });
    const ids = [
      first.identities.playerA.playerId!,
      first.identities.playerB.playerId!,
      first.identities.admin.playerId!,
    ];
    await first.cleanup();

    const remaining = await db.db.select().from(player).where(inArray(player.id, ids));
    expect(remaining).toEqual([]);

    const second = await createAuthorizationTestSuite({
      db,
      env,
      suite: 'authorization-framework-cleanup',
    });
    expect([
      second.identities.playerA.playerId,
      second.identities.playerB.playerId,
      second.identities.admin.playerId,
    ]).toEqual(ids);
    await second.cleanup();
  });
});
