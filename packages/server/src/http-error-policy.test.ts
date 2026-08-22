import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from './auth/session';
import { createDatabase, type DatabaseHandle } from './db/client';
import { type ServerEnv } from './env';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from './test-fixtures/authorization';

import type { InjectOptions } from 'fastify';

const url = process.env.DATABASE_URL;
if (!url)
  console.warn('\n  [http-error-policy.test] DATABASE_URL not set — skipping policy tests.\n');
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

describeDb('HTTP authorization and resource-concealment policy (SEC-03)', () => {
  let db: DatabaseHandle;
  let authorization: AuthorizationTestSuite;

  beforeAll(async () => {
    db = createDatabase();
    authorization = await createAuthorizationTestSuite({
      db,
      env,
      suite: 'http-error-policy',
    });
  });

  afterAll(async () => {
    await authorization.cleanup();
    await db.close();
  });

  it('uses 401 only when there is no valid session', async () => {
    for (const headers of [undefined, { cookie: `${SESSION_COOKIE}=not-a-valid-session` }]) {
      const response = await authorization.app.inject({
        method: 'GET',
        url: '/api/admin/overview',
        headers,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: 'unauthorized', message: 'Sign in required' });
    }
  });

  it('uses 403, never 401, when a signed-in player lacks the admin grant', async () => {
    const response = await authorization.app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: authorization.identities.playerA.cookie! },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      code: 'forbidden',
      message: 'Administrator access required',
    });
    expect(response.body).not.toContain('worlds');
    expect(response.body).not.toContain('players');
  });

  it('allows the granted identity through the same boundary', async () => {
    const response = await authorization.app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: authorization.identities.admin.cookie! },
    });

    expect(response.statusCode).toBe(200);
  });

  it('answers 404, never 500, for every malformed or unknown path identifier', async () => {
    // This is the complete parameterised admin-route inventory in the SEC-01
    // matrix. The three player-owned route surfaces are exercised together in
    // airline/context.test.ts, where cross-owner and missing ids can also be
    // compared byte-for-byte.
    const requests: InjectOptions[] = [
      { method: 'GET', url: '/api/admin/players/not-a-uuid' },
      { method: 'POST', url: '/api/admin/players/not-a-uuid/sessions/revoke' },
      { method: 'GET', url: '/api/admin/airlines/not-a-uuid' },
      { method: 'PATCH', url: '/api/admin/airlines/not-a-uuid/identity', payload: {} },
      { method: 'POST', url: '/api/admin/worlds/not-a-uuid/speed', payload: {} },
      { method: 'POST', url: '/api/admin/worlds/not-a-uuid/status', payload: {} },
      { method: 'POST', url: '/api/admin/worlds/not-a-uuid/reset', payload: {} },
      { method: 'GET', url: '/api/admin/economy-config/not-a-uuid' },
      { method: 'POST', url: '/api/admin/worlds/not-a-uuid/economy-config', payload: {} },
      { method: 'GET', url: '/api/admin/worlds/not-a-uuid/npc' },
    ];

    for (const request of requests) {
      const requestUrl =
        typeof request.url === 'string' ? request.url : (request.url?.pathname ?? '<unknown>');
      const response = await authorization.app.inject({
        ...request,
        headers: { cookie: authorization.identities.admin.cookie! },
      });

      expect(response.statusCode, `${request.method ?? 'GET'} ${requestUrl}`).toBe(404);
      expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
        'code',
        'message',
      ]);
    }
  });
});
