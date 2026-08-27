import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from './auth/session';
import { createDatabase, type DatabaseHandle } from './db/client';
import { type ServerEnv } from './env';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from './test-fixtures/authorization';
import { ABSENT_RESOURCE_UUID, MALFORMED_RESOURCE_IDS } from './test-fixtures/resource-id';

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

  it('answers 404, never 500, for every malformed UUID path identifier', async () => {
    // This is the complete UUID-parameterised admin-route inventory. The
    // economy-config version and office role paths are bounded domain keys, not
    // resource UUIDs, and are accounted for separately by the SEC-07 inventory.
    const requests = [
      (id: string): InjectOptions => ({ method: 'GET', url: `/api/admin/players/${id}` }),
      (id: string): InjectOptions => ({
        method: 'POST',
        url: `/api/admin/players/${id}/sessions/revoke`,
      }),
      (id: string): InjectOptions => ({ method: 'GET', url: `/api/admin/airlines/${id}` }),
      (id: string): InjectOptions => ({
        method: 'PATCH',
        url: `/api/admin/airlines/${id}/identity`,
        payload: {},
      }),
      (id: string): InjectOptions => ({
        method: 'POST',
        url: `/api/admin/worlds/${id}/speed`,
        payload: {},
      }),
      (id: string): InjectOptions => ({
        method: 'POST',
        url: `/api/admin/worlds/${id}/status`,
        payload: {},
      }),
      (id: string): InjectOptions => ({
        method: 'POST',
        url: `/api/admin/worlds/${id}/reset`,
        payload: {},
      }),
      (id: string): InjectOptions => ({
        method: 'POST',
        url: `/api/admin/worlds/${id}/economy-config`,
        payload: {},
      }),
      (id: string): InjectOptions => ({ method: 'GET', url: `/api/admin/worlds/${id}/npc` }),
    ];

    for (const malformed of MALFORMED_RESOURCE_IDS) {
      for (const makeRequest of requests) {
        const request = makeRequest(encodeURIComponent(malformed));
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
    }
  });

  it('does not turn a valid but missing or wrong-entity NPC world id into an empty report', async () => {
    const wrongEntityId = authorization.identities.playerA.playerId;
    if (wrongEntityId === null) throw new Error('SEC-07 player fixture was not seated');
    const responses = await Promise.all(
      [ABSENT_RESOURCE_UUID, wrongEntityId].map((worldId) =>
        authorization.app.inject({
          method: 'GET',
          url: `/api/admin/worlds/${worldId}/npc`,
          headers: { cookie: authorization.identities.admin.cookie! },
        }),
      ),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: 'world_not_found',
        message: 'No world with that id.',
      });
    }
    expect(responses[0]?.body).toBe(responses[1]?.body);
  });
});
