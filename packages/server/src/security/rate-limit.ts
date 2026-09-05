import { type FastifyRequest } from 'fastify';

import { type ServerEnv } from '../env';

/**
 * Rate limits by endpoint class (SEC-HARD-09, ADR-0012).
 *
 * ## Why one number was the wrong shape
 *
 * The first tranche of SEC-HARD-09 put a single generous ceiling on everything,
 * which caps a request flood and nothing else. Tailfin is a real-time
 * competitive economy, so the interesting abuse is not CPU: a player who scripts
 * an action loop is gaining an unfair advantage in a shared world, and the damage
 * persists in other players' balance sheets. That is closer to anti-cheat than to
 * infrastructure protection.
 *
 * And the right budget for *"read my fleet"* and *"place an aircraft order"*
 * differ by orders of magnitude. One number has to be generous enough for the
 * first, which makes it useless for the second.
 *
 * ## Why the key is the player, not the address
 *
 * Two players behind one household or one campus NAT share an address. An
 * IP-keyed budget lets either exhaust the other's, which is a fairness bug
 * dressed as a security control — and it is the failure players would actually
 * report. So an authenticated request is counted against its **player id**, and
 * only an anonymous one falls back to the address.
 *
 * The class is part of the key, so the budgets are separate buckets rather than
 * one pool with several ceilings. Filling the read budget must not stop a player
 * placing an order.
 *
 * ## Why this runs at `preParsing`
 *
 * `request.player` is resolved in an `onRequest` hook, so a limiter running at
 * `onRequest` would see every request as anonymous and key everything on the
 * address — quietly, with no failure to notice. `preParsing` runs after every
 * `onRequest` hook and **before** the body is read, so the player is available
 * and a refused request still costs no parsing.
 *
 * ## What this deliberately does not solve
 *
 * **Counters are per process.** OPS-08 through OPS-16 plan multiple web nodes,
 * and in-memory counters would then divide every effective limit by the node
 * count — a limit of 1200 becomes 1200 per node. That is a real limitation and
 * the fix is a shared store, which needs the second node to exist first. It is
 * recorded here and on OPS-11 rather than solved today, because a Redis
 * dependency for a single-node deployment is a liability, not a control.
 *
 * **`trustProxy` is believed.** `request.ip` comes from `X-Forwarded-For`, so
 * any per-address budget is only as good as the guarantee that nothing reaches
 * the app port directly. Both hosts bind `127.0.0.1` (ADR-0025 checked this),
 * and SEC-HARD-28 owns the question properly.
 */

/**
 * What an endpoint costs, and therefore what it is allowed to be called.
 *
 * Six, and no more without a reason. A taxonomy with a class per feature stops
 * being a taxonomy: nobody can say what the classes mean, and every new route
 * gets its own budget by default.
 */
export const RATE_LIMIT_CLASSES = ['exempt', 'auth', 'read', 'write', 'report', 'admin'] as const;

export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

export interface RateLimitBudget {
  /** Requests permitted per window. */
  max: number;
  windowMs: number;
}

/**
 * The default budgets, per key, per window.
 *
 * Deliberately generous where a real player lives and tight where an attacker
 * does. The most likely failure of any rate limit is refusing somebody's actual
 * gameplay, and that failure is worse than the one it prevents — so the reads a
 * client makes constantly are capped far above what a human can produce, and
 * only sign-in and expensive reports are drawn close.
 *
 * Every number is overridable per environment; none is a game-balance figure.
 * Rate limits protect a *node*, not a world — an authentication attempt happens
 * before any world is known, and two worlds on one box share the same CPU — so
 * these are not `EconomyConfig` material and would be actively wrong there.
 */
export const DEFAULT_RATE_LIMIT_BUDGETS: Record<RateLimitClass, RateLimitBudget> = {
  // Never counted. Present so the class is a total function over every route.
  exempt: { max: Number.POSITIVE_INFINITY, windowMs: 60_000 },
  /*
   * Sign-in, per address, over a quarter of an hour rather than a minute.
   *
   * A human signs in once and takes two requests to do it. A long window is what
   * makes the limit mean anything: 20 a minute would still allow 28,800 attempts
   * a day, which is a brute-force budget rather than a limit.
   */
  auth: { max: 20, windowMs: 15 * 60_000 },
  // A player with the app open polls several endpoints; 20/s sustained is far
  // above that and far below what a script can produce.
  read: { max: 1_200, windowMs: 60_000 },
  // 4/s sustained, per player. Ordinary bursty UI — a form, a confirmation, a
  // refresh — is nowhere near it; an action loop is.
  write: { max: 240, windowMs: 60_000 },
  // Full-network reads and P&L: each is several joins over a world.
  report: { max: 60, windowMs: 60_000 },
  // Moderate rather than tight. An admin doing support work loads many records
  // in a burst, and refusing that is refusing the person fixing the problem.
  admin: { max: 600, windowMs: 60_000 },
};

/**
 * Reads whose cost is a query plan rather than a row lookup.
 *
 * Hand-written, because it cannot be derived: `GET /api/routes` is a list and
 * `GET /api/routes/:routeId/performance` aggregates a season of flights, and
 * nothing about the two paths says which is which.
 */
const REPORT_ROUTES = new Set([
  '/api/finance/pnl',
  '/api/world/map',
  '/api/network/connections',
  '/api/routes/:routeId/waterfall',
  '/api/routes/:routeId/performance',
  '/api/routes/:routeId/competition',
  '/api/airlines/founding-airports',
  '/api/world/airports',
]);

/**
 * Routes that are never counted.
 *
 * `/healthz` because `deploy.sh` polls it and a rate-limited health check makes
 * a deploy fail for a reason that has nothing to do with the deploy — the worst
 * kind of false alarm, arriving at the worst moment. `/` because it is the
 * static surface, served by the same process and not an API at all.
 */
const EXEMPT_ROUTES = new Set(['/healthz', '/']);

/**
 * Which budget a request is counted against.
 *
 * Total by construction: every path resolves to a class, and a route added
 * tomorrow gets the safe default for its method — `read` for a `GET`, `write`
 * for anything that changes something. A new route is therefore never
 * accidentally unlimited, which is the property that matters; getting a
 * more-specific class is an improvement somebody makes deliberately.
 *
 * `url` is the **route pattern** (`/api/routes/:routeId`), not the request path,
 * so one player cannot land in a different class by choosing an id.
 */
export function rateLimitClassFor(method: string, url: string): RateLimitClass {
  if (EXEMPT_ROUTES.has(url)) return 'exempt';
  if (url.startsWith('/api/auth/')) return 'auth';
  // Before the method check: an admin write is an admin action, and an admin
  // browsing records in a burst is not the abuse this is aimed at.
  if (url.startsWith('/api/admin/')) return 'admin';
  if (REPORT_ROUTES.has(url)) return 'report';
  return method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD' ? 'read' : 'write';
}

/** Per-class counts of refusals since this process started. */
const exceeded = new Map<RateLimitClass, number>();

export interface RateLimitCounter {
  class: RateLimitClass;
  max: number;
  windowMs: number;
  /** Requests refused since this process started. Zero is the ordinary state. */
  exceeded: number;
}

/**
 * What the limits are and how often they have fired, for this process.
 *
 * A limit nobody can see firing cannot be tuned, and the direction that hurts
 * is the false positive: a budget set slightly too low refuses real players and
 * looks, from the outside, exactly like the game being broken. So the counters
 * are surfaced on the admin console's System health page rather than left in a
 * log somebody would have to know to grep.
 *
 * Per process, and the page says so. With one web node that is the whole story;
 * with several it would be one node's share (OPS-11).
 */
export function rateLimitCounters(env: ServerEnv): RateLimitCounter[] {
  const budgets = rateLimitBudgets(env);
  return RATE_LIMIT_CLASSES.filter((name) => name !== 'exempt').map((name) => ({
    class: name,
    max: budgets[name].max,
    windowMs: budgets[name].windowMs,
    exceeded: exceeded.get(name) ?? 0,
  }));
}

/** Test seam. Never called by the server. */
export function resetRateLimitCounters(): void {
  exceeded.clear();
}

function recordExceeded(name: RateLimitClass): void {
  exceeded.set(name, (exceeded.get(name) ?? 0) + 1);
}

/**
 * The configured budgets, defaults where the environment says nothing.
 *
 * `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` are the spelling from the single
 * global ceiling this replaced. They now mean the **read** budget, which is what
 * that ceiling was — generous, and covering the requests a client actually
 * makes constantly. Kept so a box already setting them keeps the behaviour it
 * had; `RATE_LIMIT_READ_MAX` is the name to use, and wins if both are set.
 */
export function rateLimitBudgets(env: ServerEnv): Record<RateLimitClass, RateLimitBudget> {
  const configured = env.rateLimits ?? {};
  const legacyRead = {
    ...(env.rateLimitMax === undefined ? {} : { max: env.rateLimitMax }),
    ...(env.rateLimitWindowMs === undefined ? {} : { windowMs: env.rateLimitWindowMs }),
  };

  const budgets = {} as Record<RateLimitClass, RateLimitBudget>;
  for (const name of RATE_LIMIT_CLASSES) {
    budgets[name] = {
      ...DEFAULT_RATE_LIMIT_BUDGETS[name],
      ...(name === 'read' ? legacyRead : {}),
      ...configured[name],
    };
  }
  return budgets;
}

/** Loopback, in the two spellings Node produces. */
function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * The plugin options.
 *
 * Built here rather than inline in `app.ts` so the policy is one testable
 * object, and so `rateLimitClassFor` is exercised by the same code the server
 * runs rather than by a copy of it.
 */
export function rateLimitOptions(env: ServerEnv) {
  const budgets = rateLimitBudgets(env);

  /** The class of the route this request matched, or `read` before routing. */
  function classOf(request: FastifyRequest): RateLimitClass {
    // `routeOptions.url` is the *pattern*. A request that matched no route has
    // none; it will 404, and counting it as a cheap read is right — refusing to
    // 404 somebody is not a control, and an unrouted flood is still capped.
    const url = request.routeOptions.url;
    return url === undefined ? 'read' : rateLimitClassFor(request.method, url);
  }

  return {
    /*
     * After `onRequest`, before the body is read.
     *
     * `request.player` is resolved in an `onRequest` hook, so a limiter at
     * `onRequest` would see every request as anonymous and key on the address —
     * silently, and only visible as players sharing a NAT throttling each other.
     */
    hook: 'preParsing' as const,

    /**
     * `<class>:<who>`, so each class is its own bucket.
     *
     * A player id where there is one: two players behind one address must not
     * be able to exhaust each other's budget, and an address is not an identity.
     */
    keyGenerator: (request: FastifyRequest): string => {
      const name = classOf(request);
      const player = request.player?.id;
      return player === undefined ? `${name}:ip:${request.ip}` : `${name}:player:${player}`;
    },

    max: (request: FastifyRequest): number => budgets[classOf(request)].max,
    timeWindow: (request: FastifyRequest): number => budgets[classOf(request)].windowMs,

    /**
     * Exempt: loopback, and the routes that must never be refused.
     *
     * Loopback covers the worker, local development and the whole in-process
     * test suite, none of which arrives with a forwarded address. A real client
     * behind Caddy never resolves to loopback, so exempting it costs nothing.
     */
    allowList: (request: FastifyRequest): boolean =>
      classOf(request) === 'exempt' || isLoopback(request.ip),

    onExceeded: (request: FastifyRequest, key: string): void => {
      const name = classOf(request);
      recordExceeded(name);
      /*
       * Warn, with the class and the route, once per refusal.
       *
       * The key is logged as its *kind* rather than its value: which player was
       * throttled is answerable from the request's own log line, and repeating an
       * id on every refusal turns a rate-limit log into a list of who was
       * playing. `keyKind` is what actually gets read — "everyone on one address"
       * and "one signed-in player" are different incidents.
       */
      request.log.warn(
        {
          rateLimitClass: name,
          keyKind: key.includes(':player:') ? 'player' : 'ip',
          route: request.routeOptions.url ?? request.url,
          max: budgets[name].max,
          windowMs: budgets[name].windowMs,
        },
        'rate limit exceeded',
      );
    },

    /**
     * ADR-0020's error shape, not the plugin's.
     *
     * The default is a bare Fastify error, which arrives at the client as a
     * different shape from every other refusal in the API and is logged as an
     * unhandled error. `Retry-After` is what lets a well-behaved client back off
     * instead of retrying into the same wall.
     */
    errorResponseBuilder: (
      request: FastifyRequest,
      context: { after: string; statusCode: number },
    ) => {
      // An `Error` carrying `statusCode`, because that is what the plugin throws
      // and what Fastify reads for the status. A plain object here answers 500 —
      // a rate limit reported as a crash, which is exactly backwards.
      const error = Object.assign(
        new Error(`Too many ${classOf(request)} requests. Try again in ${context.after}.`),
        { statusCode: context.statusCode, code: 'rate_limited' },
      );
      return error;
    },
  };
}
