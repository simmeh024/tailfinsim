import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { type ServerEnv } from '../env';

/**
 * The denial-of-service guard (SEC-HARD-09, ADR-0012).
 *
 * Two properties, and both matter. Loopback is exempt, so the worker, local
 * development and the whole in-process test suite — every one of which reaches
 * the app from `127.0.0.1` — are never throttled however hard they hit it. A
 * real client, identified by a forwarded IP that is not loopback, is limited
 * once it crosses the ceiling. No database and no port: `/api/version` is public
 * and never touches Postgres, so this always runs.
 */

const testEnv: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: 'postgres://unused',
  databasePoolMax: 2,
  databaseConnectTimeoutMs: 500,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  publicOrigin: 'http://localhost:3000',
  googleClientId: undefined,
  googleClientSecret: undefined,
  sessionSecret: undefined,
  authEnabled: false,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
  // A tiny ceiling, so a handful of requests proves the limit without a flood.
  rateLimitMax: 2,
  rateLimitWindowMs: 60_000,
};

describe('rate limiting', () => {
  let db: DatabaseHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    db = createDatabase();
    app = await buildApp({ env: testEnv, db });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('never throttles loopback, however many requests it makes', async () => {
    // Well past the ceiling of 2 — all served, because 127.0.0.1 is exempt.
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/api/version' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('limits a real client IP once it crosses the ceiling', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/version',
        // `trustProxy` resolves the client IP from this header — exactly how Caddy
        // identifies the real caller. TEST-NET-3, a routable, non-loopback address.
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      codes.push(res.statusCode);
    }
    // max = 2: the first two are served, the rest are refused with 429.
    expect(codes.filter((c) => c === 200)).toHaveLength(2);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });
});
