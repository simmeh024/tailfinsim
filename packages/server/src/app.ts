import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { healthResponseJsonSchema } from '@tailfin/shared';

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
/** Resolves the same from `src` (dev) and `dist` (built) — both sit one level under packages/server. */
const HOLDING_PAGE = resolve(here, '..', '..', 'web', 'public', 'index.html');

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
   * The holding page, read once at boot.
   *
   * Deliberately not a general static handler: exactly one asset is served, so
   * there is no path to traverse. M0-09 replaces this with the built client and
   * will need a real static route.
   */
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

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ code: 'not_found', message: 'No such route' }),
  );

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
