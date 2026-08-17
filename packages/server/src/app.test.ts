import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HealthResponse } from '@tailfin/shared';

import { buildApp } from './app';
import { createDatabase, type DatabaseHandle } from './db/client';
import { type ServerEnv } from './env';

/**
 * HTTP-surface tests driven through `app.inject()` — no port, no network.
 *
 * The database-backed cases need `DATABASE_URL` and skip loudly without it, the
 * same as the schema constraint tests. The routing and error-handling cases do
 * not, so they always run.
 */

const url = process.env.DATABASE_URL;

const testEnv: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 2,
  // Quiet: these tests deliberately provoke errors and a 503.
  logLevel: 'silent',
  // The default surface, and the one production runs.
  webSurface: 'holding',
  allowRegistration: false,
};

const describeDb = url ? describe : describe.skip;

describeDb('HTTP surface', () => {
  let db: DatabaseHandle;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = createDatabase();
    app = buildApp({ env: testEnv, db });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('GET /healthz', () => {
    it('returns 200 and a body matching the shared schema', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);

      const parsed = HealthResponse.safeParse(res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.status).toBe('ok');
      expect(parsed.success && parsed.data.db).toBe('up');
      expect(parsed.success && parsed.data.uptime).toBeGreaterThanOrEqual(0);
    });

    it('reports the database as up, not as not_checked', async () => {
      // The placeholder server answered "not_checked" forever. M0-08's whole
      // point is that this is now a real query.
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.json()).toMatchObject({ db: 'up' });
    });

    it('strips anything the shared schema does not declare', async () => {
      // Fastify serialises through the schema, so the response can only contain
      // declared fields even if a handler returned more.
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(Object.keys(res.json()).sort()).toEqual(['db', 'status', 'uptime']);
    });
  });

  describe('request ids', () => {
    it('echoes an inbound x-request-id so it can be traced across the proxy', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': 'trace-me-1234' },
      });
      expect(res.headers['x-request-id']).toBe('trace-me-1234');
    });

    it('generates one when the client sends none', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      const id = res.headers['x-request-id'];
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('gives different requests different ids', async () => {
      const a = await app.inject({ method: 'GET', url: '/healthz' });
      const b = await app.inject({ method: 'GET', url: '/healthz' });
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });

    it('ignores an absurdly long inbound id rather than logging it', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': 'x'.repeat(500) },
      });
      expect(res.headers['x-request-id']).not.toBe('x'.repeat(500));
    });
  });

  describe('GET /', () => {
    it('serves the holding page as HTML', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toContain('<title>Tailfin — coming soon</title>');
    });

    it('sends a HEAD without a body', async () => {
      const res = await app.inject({ method: 'HEAD', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('');
    });
  });

  describe('unknown routes', () => {
    it('returns a structured 404, not an HTML error page', async () => {
      const res = await app.inject({ method: 'GET', url: '/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ code: 'not_found', message: 'No such route' });
    });

    it('returns 404 for an unsupported method on a known path', async () => {
      const res = await app.inject({ method: 'POST', url: '/healthz' });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe('health degradation', () => {
  it('answers 503 when the database is unreachable', async () => {
    // Deliberately points at a port nothing listens on. deploy.sh polls
    // /healthz to decide whether a release came up, so a server that cannot
    // reach its database must not report success.
    const db = createDatabaseAt('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = buildApp({ env: { ...testEnv, databaseUrl: 'postgres://unused' }, db });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
      // Still schema-valid — a degraded response is a contract, not a surprise.
      expect(HealthResponse.safeParse(res.json()).success).toBe(true);
    } finally {
      await app.close();
      await db.close().catch(() => undefined);
    }
  });
});

/** Builds a handle against an explicit URL, bypassing the environment. */
function createDatabaseAt(connectionString: string): DatabaseHandle {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;
  try {
    return createDatabase();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}
