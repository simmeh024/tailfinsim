import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HealthResponse, VersionResponse } from '@tailfin/shared';

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
  databaseConnectTimeoutMs: 500,
  // Quiet: these tests deliberately provoke errors and a 503.
  logLevel: 'silent',
  // The default surface, and the one production runs.
  webSurface: 'holding',
  environmentLabel: 'local',
  publicOrigin: 'http://localhost:3000',
  // Auth off, matching production until its own OAuth client exists. The auth
  // surface itself is covered by auth/session-cookie.test.ts.
  googleClientId: undefined,
  googleClientSecret: undefined,
  sessionSecret: undefined,
  authEnabled: false,
  sessionTtlHours: 24,
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

describe('GET /api/version', () => {
  /**
   * No database involved, so this runs everywhere. The handle points at a dead
   * port and is never queried — if `/api/version` ever starts touching the
   * database, this test hangs, which is the correct alarm.
   */
  async function withApp(
    label: 'local' | 'dev' | 'production',
    body: (app: ReturnType<typeof buildApp>) => Promise<void>,
  ): Promise<void> {
    const db = createDatabaseAt('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = buildApp({ env: { ...testEnv, environmentLabel: label }, db });
    await app.ready();
    try {
      await body(app);
    } finally {
      await app.close();
      await db.close().catch(() => undefined);
    }
  }

  it('answers with a build number, commit, environment and start time', async () => {
    await withApp('dev', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/version' });
      expect(res.statusCode).toBe(200);

      const parsed = VersionResponse.safeParse(res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.environment).toBe('dev');
      // Shape, not value. Whether a build stamp exists depends on whether this
      // package has been built on this machine, which is not something an HTTP
      // test should assert on — build-info.test.ts covers the values.
      expect(parsed.success && Number.isInteger(parsed.data.build)).toBe(true);
      expect(parsed.success && parsed.data.commit.length).toBeGreaterThan(0);
    });
  });

  it('reports the environment it was told, not NODE_ENV', async () => {
    // The whole point: NODE_ENV is `production` on the dev box too, so it cannot
    // be what the badge reads.
    await withApp('production', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/version' });
      expect(res.json()).toMatchObject({ environment: 'production' });
    });
  });

  it('is not cached, so a redeployed box does not keep claiming the old build', async () => {
    await withApp('dev', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/version' });
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  it('reports the same start time across requests', async () => {
    // It is process start, not request time — a value that changed every call
    // would say nothing about whether the box restarted.
    await withApp('dev', async (app) => {
      const a = await app.inject({ method: 'GET', url: '/api/version' });
      const b = await app.inject({ method: 'GET', url: '/api/version' });
      expect(a.json<{ startedAt: string }>().startedAt).toBe(
        b.json<{ startedAt: string }>().startedAt,
      );
    });
  });

  it('exposes nothing beyond the declared fields', async () => {
    await withApp('dev', async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/version' });
      expect(Object.keys(res.json<Record<string, unknown>>()).sort()).toEqual([
        'build',
        'commit',
        'deployedAt',
        'environment',
        'ref',
        'serverTime',
        'startedAt',
      ]);
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

/**
 * Builds a handle against an explicit URL, bypassing the environment.
 *
 * Also shortens the connect timeout. The production default is 5s, which is
 * sensible for a server and useless for a test that exists to observe the
 * failure — the assertion is about the *response*, not how long it took.
 */
function createDatabaseAt(connectionString: string): DatabaseHandle {
  const previousUrl = process.env.DATABASE_URL;
  const previousTimeout = process.env.DATABASE_CONNECT_TIMEOUT_MS;
  process.env.DATABASE_URL = connectionString;
  process.env.DATABASE_CONNECT_TIMEOUT_MS = '500';
  try {
    return createDatabase();
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousTimeout === undefined) delete process.env.DATABASE_CONNECT_TIMEOUT_MS;
    else process.env.DATABASE_CONNECT_TIMEOUT_MS = previousTimeout;
  }
}

describe('GET /api/routes/:routeId/waterfall is on the surface (M3-10)', () => {
  /**
   * Routing only, and deliberately so.
   *
   * `waterfall.test.ts` proves the decomposition against App. A.9's published
   * figures; what it cannot prove is that the handler is reachable at the path
   * the client asks for. A typo in either would leave both green and the
   * feature dead, so this asserts the wiring and nothing else.
   *
   * No database is touched. With `authEnabled: false` the session hook returns
   * before its query and `requireAuth` answers 401 — so a 401 here means the
   * route exists, and a 404 would mean it does not. If this ever hangs, the
   * handler has started querying before checking auth.
   */
  async function withApp(body: (app: ReturnType<typeof buildApp>) => Promise<void>): Promise<void> {
    const db = createDatabaseAt('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = buildApp({ env: testEnv, db });
    await app.ready();
    try {
      await body(app);
    } finally {
      await app.close();
      await db.close().catch(() => undefined);
    }
  }

  it('is registered, and guarded by auth rather than missing', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/routes/00000000-0000-4000-8000-000000000000/waterfall?cabin=economy&rival=a',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  it('answers without a cabin, because the common case is one click', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/routes/00000000-0000-4000-8000-000000000000/waterfall',
      });
      // Still the auth wall, not a 400 — the querystring is optional.
      expect(res.statusCode).toBe(401);
    });
  });

  it('is a GET and not anything else', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/routes/00000000-0000-4000-8000-000000000000/waterfall',
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
