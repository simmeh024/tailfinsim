import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyInstance, type RouteOptions } from 'fastify';

import { healthResponseJsonSchema, versionResponseJsonSchema } from '@tailfin/shared';

import { registerAdminRoutes } from './admin/routes';
import { registerAircraftRoutes } from './aircraft/routes';
import { type AirlineCodeAllocationPolicy } from './airline/codes';
import { registerPlayerAirlineContext } from './airline/context';
import { type AirlineIdentityModerator } from './airline/moderation';
import { registerAirlineRoutes } from './airline/routes';
import { type GoogleAuthOperations, registerAuthRoutes } from './auth/routes';
import { registerAutomationRoutes } from './automation/routes';
import { readBuildInfo } from './build-info';
import { registerCrewRoutes } from './crew/routes';
import { type DatabaseHandle } from './db/client';
import { readDeployInfo } from './deploy-info';
import { type ServerEnv } from './env';
import { registerFinanceRoutes } from './finance/routes';
import { registerGroundRoutes } from './ground/routes';
import { createEconomicsProvider } from './network/economics';
import { registerNetworkRoutes } from './network/routes';
import { registerOfficeRoutes } from './office/routes';
import { registerScheduleRoutes } from './schedule/routes';
import { registerWorldRoutes } from './world/routes';

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
const DEV_A320NEO_CANDIDATE_DIRECTORY = resolve(
  here,
  '..',
  '..',
  '..',
  'assets',
  'aircraft',
  'candidates',
  'a320neo',
  '1.0.0',
);

const DEV_A320NEO_CANDIDATE_FILES = [
  'aircraft-lod0.glb',
  'aircraft-lod1.glb',
  'aircraft-lod2.glb',
] as const;
let devA320neoCandidateCache: ReadonlyMap<string, Buffer> | null = null;

function readDevA320neoCandidates(
  environment: ServerEnv['environmentLabel'],
): ReadonlyMap<string, Buffer> {
  if (environment !== 'dev') return new Map();
  if (devA320neoCandidateCache !== null) return devA320neoCandidateCache;
  const candidates = new Map<string, Buffer>();
  for (const fileName of DEV_A320NEO_CANDIDATE_FILES) {
    const path = resolve(DEV_A320NEO_CANDIDATE_DIRECTORY, fileName);
    if (existsSync(path)) candidates.set(fileName, readFileSync(path));
  }
  devA320neoCandidateCache = candidates;
  return devA320neoCandidateCache;
}

export interface BuildAppOptions {
  env: ServerEnv;
  db: DatabaseHandle;
  /** AIR-02 policy plug-in; omitted until M13-10 supplies one. */
  identityModerator?: AirlineIdentityModerator;
  /** AIR-04/M11-08 allocation strategy; defaults to per-world availability. */
  airlineCodePolicy?: AirlineCodeAllocationPolicy;
  /** Test seam at the external OAuth boundary; production uses the real provider. */
  googleAuth?: GoogleAuthOperations;
  /**
   * Called once for every route as it is registered (SEC-04).
   *
   * The authorization matrix in `docs/authorization-matrix.md` is the *intended*
   * boundary for every route, and it is only worth anything if a route cannot be
   * added without one. Proving that needs the list of routes the app actually
   * registered, and the honest way to get it is to be told as it happens.
   *
   * `app.printRoutes()` is the alternative and it is worse: it renders a tree for
   * a human, so reading it back means parsing indentation and re-joining path
   * segments, and a cosmetic change to that output would silently weaken the
   * gate. Fastify's `onRoute` hook hands over `method` and `url` directly.
   *
   * It has to be an option rather than something a test adds afterwards, because
   * `onRoute` fires *during* registration and every route here is registered
   * before this function returns. A hook added to the instance we hand back is
   * always too late.
   *
   * Observation only. Nothing in the request path reads it, and production never
   * passes it.
   */
  onRoute?: (route: RouteOptions) => void;
}

export async function buildApp({
  env,
  db,
  identityModerator,
  airlineCodePolicy,
  googleAuth,
  onRoute,
}: BuildAppOptions): Promise<FastifyInstance> {
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

    // Keep resource-shaped parameters inside the application long enough for
    // each handler's UUID guard to produce the same 400/404 policy response as
    // any other malformed id (SEC-07). Fastify's 100-character default answers
    // 414 before routing, which makes an overlong id observably different.
    // 512 is still a deliberately small, bounded parsing ceiling.
    routerOptions: { maxParamLength: 512 },

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
  // Before any registration, or it sees nothing: `onRoute` fires as each route is
  // added, and every route below is added before this function returns.
  if (onRoute) app.addHook('onRoute', onRoute);

  /**
   * A denial-of-service guard on every route (SEC-HARD-09, ADR-0012, §16).
   *
   * Registered before the routes so `global: true` reaches all of them, and
   * keyed on the client IP — which `trustProxy` above resolves to the real caller
   * behind Caddy, not to the proxy, so one abusive client is throttled without
   * taking every user sharing the edge down with it. That resolves the
   * "trusted-proxy semantics" half of the finding ADR-0013 deferred here.
   *
   * **Loopback is exempt.** The worker, local development and the in-process test
   * suite all reach the app from `127.0.0.1` with no forwarded IP, so exempting
   * loopback keeps them unthrottled while a real client hammering the public host
   * (whose forwarded IP is never loopback) is limited. The ceiling is deliberately
   * generous — a player loading the SPA and polling stays far under it — because
   * the job is to cap abuse, not to shape ordinary traffic; `RATE_LIMIT_MAX` tunes
   * it without a code change.
   *
   * **Awaited, and before the routes.** The plugin attaches itself by adding an
   * `onRoute` hook, which only wraps routes registered *after* it has loaded — so
   * loading it here, ahead of every `register*Routes` call below, is what makes
   * the guard actually cover them. This is why `buildApp` is async.
   */
  await app.register(fastifyRateLimit, {
    max: env.rateLimitMax ?? 1200,
    timeWindow: env.rateLimitWindowMs ?? 60_000,
    allowList: ['127.0.0.1', '::1'],
  });

  app.register(fastifyCookie, env.sessionSecret ? { secret: env.sessionSecret } : {});
  registerAuthRoutes(app, { env, db, googleAuth });
  // Resolves "my airline" from the authenticated session and active world.
  // Founding itself does not use the guard because having no airline is its
  // precondition; player-airline operations registered later do (AIR-05).
  registerPlayerAirlineContext(app, { db });
  // After the auth routes, which is where `requireAdmin` is decorated. Fastify
  // resolves decorators at registration time, so the order is not cosmetic.
  registerAdminRoutes(app, { db });

  // Founding is the first player operation and the precondition for the
  // network routes registered below it (AIR-01).
  registerAirlineRoutes(app, { db, identityModerator, codePolicy: airlineCodePolicy });

  // The first player-facing API. Economics are injected rather than looked up
  // because the fleet does not exist yet — see `network/economics.ts` for which
  // half of it is real.
  registerNetworkRoutes(app, { db, economicsFor: createEconomicsProvider(db.db) });
  registerScheduleRoutes(app, { db, economicsFor: createEconomicsProvider(db.db) });
  registerAircraftRoutes(app, { db });
  // The world's own clock. Behind the same airline boundary, because which world
  // a player is in is what decides whose clock they get.
  registerWorldRoutes(app, { db });
  // Crew, behind the same airline boundary (M5-01).
  registerCrewRoutes(app, { db });
  registerOfficeRoutes(app, { db });
  registerAutomationRoutes(app, { db });
  registerGroundRoutes(app, { db });
  registerFinanceRoutes(app, { db });

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
  // Read once at boot, like the build stamp. Neither changes while the
  // process lives — a redeploy restarts it.
  const deployInfo = readDeployInfo();
  const startedAtIso = new Date().toISOString();
  const devA320neoCandidates = readDevA320neoCandidates(env.environmentLabel);

  app.get(
    '/api/version',
    { schema: { response: { 200: versionResponseJsonSchema } }, logLevel: 'warn' },
    async (_request, reply) =>
      reply
        .code(200)
        .header('cache-control', 'no-store')
        .send({
          build: buildInfo.build,
          commit: buildInfo.commit,
          environment: env.environmentLabel,
          startedAt: startedAtIso,
          ref: deployInfo?.ref ?? null,
          deployedAt: deployInfo?.deployedAt ?? null,
          // Read per request, unlike the rest of this payload.
          serverTime: new Date().toISOString(),
        }),
  );

  /**
   * Review-only bridge for the rights-pending A320neo candidate.
   *
   * The candidate deliberately remains outside the runtime registry. Serving it
   * here is keyed to the server's explicit environment label, so a production
   * process cannot expose it even if the repository checkout contains the file.
   * No public cache may retain the candidate while its licence pack is pending.
   */
  if (env.environmentLabel === 'dev') {
    for (const [fileName, candidate] of devA320neoCandidates) {
      app.get(
        `/api/dev/assets/aircraft/${fileName}`,
        { logLevel: 'warn' },
        async (_request, reply) =>
          reply
            .code(200)
            .type('model/gltf-binary')
            .header('cache-control', 'private, no-store')
            .header('content-length', String(candidate.byteLength))
            .header('x-content-type-options', 'nosniff')
            .send(candidate),
      );
    }
  }

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
