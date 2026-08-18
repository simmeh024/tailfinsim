import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { healthResponseJsonSchema, versionResponseJsonSchema } from '@tailfin/shared';

import { registerAuthRoutes } from './auth/routes';
import { readBuildInfo } from './build-info';
import { type DatabaseHandle } from './db/client';
import { type ServerEnv } from './env';

/**
 * The Fastify application (M0-08).
 *
 * Built as a function returning an instance rather than a module-level
 * singleton, so tests can construct one and drive it with `app.inject()` — no
 * port, no network, no cleanup. That is what makes the HTTP surface testable in
 * CI at all.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** Both resolve the same from `src` (dev) and `dist` (built) — each sits one level under packages/server. */
const HOLDING_PAGE = resolve(here, '..', '..', 'web', 'holding', 'index.html');
const CLIENT_DIR = resolve(here, '..', '..', 'web', 'dist', 'client');

export interface BuildAppOptions {
  env: ServerEnv;
  db: DatabaseHandle;
}

export function buildApp({ env, db }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.logLevel,
      // Pretty output locally; JSON everywhere else, because that is what
      // journald and any future log shipper want.
      ...(env.nodeEnv === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
      redact: {
        // Belt and braces: nothing should put these in a log line, but if
        // something does, it must not land in the journal.
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },

    /**
     * Honour an inbound `x-request-id` so a request can be followed across a
     * proxy, and generate a UUID otherwise. Fastify's default is a per-process
     * counter, which collides across restarts and tells you nothing once there
     * is more than one process.
     */
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      const supplied = Array.isArray(header) ? header[0] : header;
      return supplied && supplied.length <= 200 ? supplied : randomUUID();
    },

    // Caddy terminates TLS and sets X-Forwarded-*; without this every client
    // looks like 127.0.0.1 in the logs.
    trustProxy: true,

    // Note: no `disableRequestLogging`. Fastify 5 deprecates it (FSTDEP023) and
    // removes it in 6, and `false` was the default anyway. Per-route
    // `logLevel` is the supported way to quieten a noisy endpoint — see
    // /healthz below.
  });

  // Echo the request id back so a user reporting a problem can quote something
  // that appears in the logs.
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  /**
   * Cookies, then auth (M0-11).
   *
   * Registered before the surface routes so that `/api/auth/*` and `/api/me`
   * exist regardless of which surface `/` serves — the API is the same on the
   * holding page and in the app.
   *
   * The secret is only present when auth is configured. Without it
   * `@fastify/cookie` still parses and sets plain cookies; only *signed* cookies
   * need it, and the one signed cookie (the OAuth state) is written solely on a
   * path guarded by `env.authEnabled`.
   */
  app.register(fastifyCookie, env.sessionSecret ? { secret: env.sessionSecret } : {});
  registerAuthRoutes(app, { env, db });

  const startedAt = Date.now();

  app.get(
    '/healthz',
    {
      schema: { response: { 200: healthResponseJsonSchema, 503: healthResponseJsonSchema } },
      // Health checks are noise in the log once a timer polls them.
      logLevel: 'warn',
    },
    async (_request, reply) => {
      let dbState: 'up' | 'down' = 'down';
      try {
        await db.db.execute(sql`select 1`);
        dbState = 'up';
      } catch (cause) {
        app.log.error({ err: cause }, 'health check: database unreachable');
      }

      const body = {
        status: dbState === 'up' ? ('ok' as const) : ('degraded' as const),
        db: dbState,
        uptime: Math.round((Date.now() - startedAt) / 1000),
      };

      /**
       * 503 when the database is unreachable, not 200.
       *
       * M0-08's acceptance criterion says `/healthz` returns 200 with
       * `{status, db, uptime}` — that is the healthy case, and it holds. But a
       * health endpoint that returns 200 while degraded cannot be used to
       * decide anything, and `deploy.sh` polls this exact URL to decide whether
       * a release came up. A deploy that cannot reach its database should fail.
       */
      return reply.code(dbState === 'up' ? 200 : 503).send(body);
    },
  );

  /**
   * Which build is this? (M0-12)
   *
   * Answered by the server rather than baked into the client bundle, so the
   * badge always describes the instance actually being talked to. A stale cached
   * bundle reporting its own build number would defeat the point.
   *
   * Public and unauthenticated: it reveals a commit SHA of a public repository
   * and nothing else, and a bug report that quotes a build number is worth far
   * more than one that says "the live site".
   */
  const buildInfo = readBuildInfo();
  const startedAtIso = new Date().toISOString();

  app.get(
    '/api/version',
    { schema: { response: { 200: versionResponseJsonSchema } }, logLevel: 'warn' },
    async (_request, reply) =>
      reply.code(200).header('cache-control', 'no-store').send({
        build: buildInfo.build,
        commit: buildInfo.commit,
        environment: env.environmentLabel,
        startedAt: startedAtIso,
        // Read per request, unlike the rest of this payload.
        serverTime: new Date().toISOString(),
      }),
  );

  /**
   * The public surface at `/` — one of two, chosen by `WEB_SURFACE`.
   *
   * This is what lets dev show a feature while the front door still shows the
   * holding page, without maintaining two builds or two branches. Promoting to
   * production is a config change.
   */
  if (env.webSurface === 'holding') {
    // Exactly one asset, read once at boot, so there is no path to traverse.
    let holdingPage: Buffer;
    try {
      holdingPage = readFileSync(HOLDING_PAGE);
    } catch (cause) {
      throw new Error(`Could not read the holding page at ${HOLDING_PAGE}`, { cause });
    }

    app.get('/', async (_request, reply) =>
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        // Short, so the page can be changed without waiting out a cache.
        .header('cache-control', 'public, max-age=60')
        .header('x-content-type-options', 'nosniff')
        .send(holdingPage),
    );
  } else {
    // Fail at boot rather than 404ing every asset: a server told to serve the
    // app but with nothing built is a broken deploy, and deploy.sh should catch
    // it via the health check rather than shipping a white screen.
    if (!existsSync(resolve(CLIENT_DIR, 'index.html'))) {
      throw new Error(
        `WEB_SURFACE=app but no client build found at ${CLIENT_DIR}. Run: pnpm --filter @tailfin/web build`,
      );
    }

    app.register(fastifyStatic, {
      root: CLIENT_DIR,
      // The SPA fallback below handles unmatched paths; the plugin's own
      // wildcard would shadow it.
      wildcard: false,
      index: ['index.html'],
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    /**
     * Client-side routing means `/fleet` is a real URL the browser may request
     * directly, and the server has no such route. Serving index.html lets the
     * router resolve it.
     *
     * Narrowly scoped on purpose: only GETs, only when the client explicitly
     * accepts HTML, and never under `/api`. Otherwise a mistyped API path would
     * answer with a page instead of a 404, which is a genuinely confusing bug to
     * chase.
     */
    const wantsHtml = (request.headers.accept ?? '').includes('text/html');
    if (
      env.webSurface === 'app' &&
      request.method === 'GET' &&
      wantsHtml &&
      !request.url.startsWith('/api')
    ) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }

    return reply.code(404).send({ code: 'not_found', message: 'No such route' });
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'unhandled error');
    const status = error.statusCode ?? 500;
    // Never surface an internal message; the request id is how it gets traced.
    return reply.code(status).send({
      code: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? 'Something went wrong' : error.message,
    });
  });

  return app;
}
