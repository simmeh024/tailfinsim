import { type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type DatabaseHandle } from '../db/client';
import { type ServerEnv } from '../env';
import { collectRegisteredRoutes } from '../test-fixtures/route-inventory';

import {
  DEFAULT_RATE_LIMIT_BUDGETS,
  RATE_LIMIT_CLASSES,
  rateLimitBudgets,
  rateLimitClassFor,
  rateLimitCounters,
  rateLimitOptions,
  resetRateLimitCounters,
  type RateLimitClass,
} from './rate-limit';

/**
 * Rate limits by endpoint class (SEC-HARD-09, ADR-0012).
 *
 * The first tranche put one generous ceiling on everything, which caps a flood
 * and nothing else. Tailfin's more interesting abuse is a scripted action loop
 * in a shared economy — closer to anti-cheat than to infrastructure protection —
 * and the right budget for *"read my fleet"* and *"place an aircraft order"*
 * differ by orders of magnitude.
 *
 * Two failure directions, and they are not equally bad. Refusing an attacker too
 * late costs CPU; refusing a real player too early looks, from their side,
 * exactly like the game being broken. So the assertions below are as concerned
 * with what must **not** be limited as with what must.
 *
 * No database: the classification is a pure function, and the endpoints
 * exercised over HTTP never touch the pool. So this runs on every pull request,
 * which matters because a control that only runs where `DATABASE_URL` is set is
 * one nobody notices breaking.
 */

const testEnv: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: 'postgres://rate-limit-unused',
  databasePoolMax: 1,
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
  // Tiny ceilings, so a handful of requests proves a limit without a flood.
  // Set per class, because the point is that they are separate.
  rateLimits: {
    read: { max: 2, windowMs: 60_000 },
    write: { max: 3, windowMs: 60_000 },
    auth: { max: 2, windowMs: 60_000 },
  },
};

/** A handle whose query surface throws: nothing here may reach the pool. */
const stubDatabase = {
  db: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`The rate-limit test queried the database (\`${String(property)}\`)`);
      },
    },
  ),
  pool: {},
  close: () => Promise.resolve(),
} as unknown as DatabaseHandle;

/** TEST-NET-3: routable, non-loopback, reserved for documentation. */
const CLIENT_IP = '203.0.113.7';
const OTHER_IP = '203.0.113.8';

beforeEach(() => {
  resetRateLimitCounters();
});

describe('which budget an endpoint is counted against', () => {
  it('classifies every registered route', async () => {
    // Total by construction rather than by a list somebody maintains: a route
    // added tomorrow gets `read` or `write` from its method, so it is never
    // accidentally unlimited. This asserts the property, not the table.
    const routes = await collectRegisteredRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(40);

    for (const route of routes) {
      const name = rateLimitClassFor(route.method, route.url);
      expect(RATE_LIMIT_CLASSES, `${route.key} resolved to ${name}`).toContain(name);
    }
  });

  it('puts each kind of endpoint where it belongs', () => {
    expect(rateLimitClassFor('GET', '/healthz')).toBe('exempt');
    expect(rateLimitClassFor('GET', '/api/auth/google')).toBe('auth');
    expect(rateLimitClassFor('GET', '/api/auth/google/callback')).toBe('auth');
    // An admin write is an admin action. An admin loading records in a burst is
    // not the abuse this exists for, and refusing them refuses the person
    // fixing the problem.
    expect(rateLimitClassFor('POST', '/api/admin/worlds/:worldId/reset')).toBe('admin');
    expect(rateLimitClassFor('GET', '/api/admin/overview')).toBe('admin');
    expect(rateLimitClassFor('GET', '/api/finance/pnl')).toBe('report');
    expect(rateLimitClassFor('GET', '/api/routes/:routeId/performance')).toBe('report');
    expect(rateLimitClassFor('GET', '/api/fleet/airframes')).toBe('read');
    expect(rateLimitClassFor('POST', '/api/schedules')).toBe('write');
    expect(rateLimitClassFor('DELETE', '/api/routes/:routeId')).toBe('write');
    expect(rateLimitClassFor('PUT', '/api/crew/policies')).toBe('write');
  });

  it('defaults an unclassified route to a limit rather than to none', () => {
    // The default has to be safe rather than convenient.
    expect(rateLimitClassFor('POST', '/api/something/invented/later')).toBe('write');
    expect(rateLimitClassFor('GET', '/api/something/invented/later')).toBe('read');
    expect(rateLimitClassFor('PATCH', '/api/something/invented/later')).toBe('write');
  });

  it('names only report routes that actually exist', async () => {
    // Otherwise the expensive list quietly becomes prose about renamed routes,
    // and the endpoints it was protecting drop back to the read budget.
    const registered = new Set((await collectRegisteredRoutes()).map((route) => route.url));
    for (const url of [
      '/api/finance/pnl',
      '/api/world/map',
      '/api/network/connections',
      '/api/routes/:routeId/waterfall',
      '/api/routes/:routeId/performance',
      '/api/routes/:routeId/competition',
      '/api/airlines/founding-airports',
      '/api/world/airports',
    ]) {
      expect(rateLimitClassFor('GET', url), `${url} left the report class`).toBe('report');
      expect(registered.has(url), `${url} is classified but not registered`).toBe(true);
    }
  });
});

describe('who a budget belongs to', () => {
  const key = (request: Partial<FastifyRequest>): string =>
    String(rateLimitOptions(testEnv).keyGenerator(request as FastifyRequest));

  const asRequest = (
    method: string,
    url: string,
    ip: string,
    playerId?: string,
  ): Partial<FastifyRequest> =>
    ({
      method,
      ip,
      routeOptions: { url },
      player: playerId === undefined ? undefined : { id: playerId },
    }) as unknown as Partial<FastifyRequest>;

  it('counts an authenticated request against the player, not the address', () => {
    // The failure this prevents is a fairness bug dressed as a security control:
    // two players in one household share an address, and an address-keyed budget
    // lets either exhaust the other's.
    const alice = key(asRequest('POST', '/api/schedules', CLIENT_IP, 'alice'));
    const bob = key(asRequest('POST', '/api/schedules', CLIENT_IP, 'bob'));

    expect(alice).not.toBe(bob);
    expect(alice).toContain('player:alice');
    expect(alice).not.toContain(CLIENT_IP);
  });

  it('follows a player across addresses rather than handing out a fresh budget', () => {
    // The other half. A script rotating through a proxy pool would otherwise get
    // a new budget per address.
    expect(key(asRequest('POST', '/api/schedules', CLIENT_IP, 'alice'))).toBe(
      key(asRequest('POST', '/api/schedules', OTHER_IP, 'alice')),
    );
  });

  it('falls back to the address when nobody is signed in', () => {
    const anonymous = key(asRequest('GET', '/api/version', CLIENT_IP));
    expect(anonymous).toContain(`ip:${CLIENT_IP}`);
    expect(anonymous).not.toBe(key(asRequest('GET', '/api/version', OTHER_IP)));
  });

  it('gives each class its own bucket for the same caller', () => {
    // Filling the read budget must not stop a player placing an order.
    const read = key(asRequest('GET', '/api/fleet/airframes', CLIENT_IP, 'alice'));
    const write = key(asRequest('POST', '/api/schedules', CLIENT_IP, 'alice'));
    expect(read).not.toBe(write);
    expect(read.startsWith('read:')).toBe(true);
    expect(write.startsWith('write:')).toBe(true);
  });

  it('keys on the route pattern, so an id cannot choose a cheaper class', () => {
    // `routeOptions.url` is the pattern Fastify matched. Using `request.url`
    // would make `/api/finance/pnl` and `/api/finance/pnl?x=1` two budgets.
    expect(key(asRequest('GET', '/api/routes/:routeId/performance', CLIENT_IP, 'alice'))).toContain(
      'report:',
    );
  });
});

describe('what a limited client is told', () => {
  async function appFor(env: ServerEnv = testEnv) {
    const app = await buildApp({ env, db: stubDatabase });
    await app.ready();
    return app;
  }

  it('answers 429 with Retry-After and the API’s own error shape', async () => {
    const app = await appFor();
    try {
      const codes: number[] = [];
      let refused: Awaited<ReturnType<typeof app.inject>> | undefined;
      for (let i = 0; i < 4; i += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/version',
          headers: { 'x-forwarded-for': CLIENT_IP },
        });
        codes.push(response.statusCode);
        if (response.statusCode === 429) refused ??= response;
      }

      expect(codes.filter((code) => code === 200)).toHaveLength(2);
      expect(refused).toBeDefined();

      // `Retry-After` is what lets a well-behaved client back off rather than
      // retrying into the same wall. Without it, 429 is only "no".
      expect(refused?.headers['retry-after']).toBeDefined();
      // ADR-0020's shape, not the plugin's default error — otherwise this one
      // refusal arrives looking unlike every other refusal in the API.
      const body: { code: string; message: string } = refused!.json();
      expect(body.code).toBe('rate_limited');
      expect(body.message).toMatch(/try again/i);
    } finally {
      await app.close();
    }
  });

  it('keeps the classes as separate budgets over HTTP', async () => {
    // The unit test above proves the keys differ; this proves the plugin honours
    // them. Exhaust the read budget, then show another class is still served.
    const app = await appFor();
    try {
      for (let i = 0; i < 4; i += 1) {
        await app.inject({
          method: 'GET',
          url: '/api/version',
          headers: { 'x-forwarded-for': CLIENT_IP },
        });
      }

      const other = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { 'x-forwarded-for': CLIENT_IP },
      });
      expect(other.statusCode).not.toBe(429);
    } finally {
      await app.close();
    }
  });

  it('never limits /healthz, however hard it is polled', async () => {
    /*
     * `deploy.sh` polls `/healthz` and fails the deploy if it does not answer.
     * A rate-limited health check turns an unrelated burst of traffic into a
     * failed deploy — a false alarm arriving at the worst possible moment.
     *
     * Polled from a *non-loopback* address on purpose: the loopback exemption
     * would make this pass for the wrong reason, and the deploy script is not
     * the only thing that ever polls it.
     */
    const app = await appFor();
    try {
      for (let i = 0; i < 12; i += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-forwarded-for': CLIENT_IP },
        });
        // Not "200": this build has no database, so /healthz answers 503. The
        // property under test is that it is never *refused*.
        expect(response.statusCode, `poll ${String(i)} was rate limited`).not.toBe(429);
      }
    } finally {
      await app.close();
    }
  });

  it('never limits loopback, which is the worker and every test', async () => {
    const app = await appFor();
    try {
      for (let i = 0; i < 8; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/api/version' });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('counts every refusal, so a limit can be seen firing', async () => {
    /*
     * The direction that hurts is the false positive, and a budget set slightly
     * too low looks from outside exactly like the game being broken. So the
     * counters are surfaced on the admin console rather than left in a log
     * somebody would have to know to grep.
     */
    const app = await appFor();
    try {
      for (let i = 0; i < 5; i += 1) {
        await app.inject({
          method: 'GET',
          url: '/api/version',
          headers: { 'x-forwarded-for': CLIENT_IP },
        });
      }

      const counters = rateLimitCounters(testEnv);
      const read = counters.find((counter) => counter.class === 'read');
      expect(read?.exceeded).toBe(3);
      // The budget travels with the count: "it fired three times" is not
      // actionable without knowing what it fired against.
      expect(read?.max).toBe(2);
      expect(read?.windowMs).toBe(60_000);
      // `exempt` has no budget to report and is left out rather than shown as an
      // infinity nobody can act on.
      expect(counters.map((counter) => counter.class)).not.toContain('exempt');
    } finally {
      await app.close();
    }
  });
});

describe('the budgets themselves', () => {
  const perSecond = (name: RateLimitClass): number =>
    DEFAULT_RATE_LIMIT_BUDGETS[name].max / (DEFAULT_RATE_LIMIT_BUDGETS[name].windowMs / 1000);

  it('is generous enough that ordinary play never notices', () => {
    /*
     * The E2E journey (E2E-05) is the real check; this is the arithmetic that
     * would have to be wrong for that journey to start failing.
     *
     * A player with the app open polls a handful of endpoints every few seconds.
     * Twenty reads a second sustained, and four writes a second sustained, are
     * both far above what a person produces through a UI and far below what a
     * script produces.
     */
    expect(perSecond('read')).toBeGreaterThanOrEqual(20);
    expect(perSecond('write')).toBeGreaterThanOrEqual(4);
    // A sign-in is two requests. Ten attempts in a quarter of an hour is a
    // generous allowance for a person and a useless one for a brute force.
    expect(DEFAULT_RATE_LIMIT_BUDGETS.auth.max).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_RATE_LIMIT_BUDGETS.auth.windowMs).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('is tighter where a request costs more', () => {
    // The ordering is the policy. A report budget above a read budget would mean
    // the classes had stopped meaning anything.
    expect(perSecond('read')).toBeGreaterThan(perSecond('write'));
    expect(perSecond('write')).toBeGreaterThan(perSecond('report'));
    expect(perSecond('report')).toBeGreaterThan(perSecond('auth'));
  });

  it('takes an override for one class without resetting the others', () => {
    const budgets = rateLimitBudgets({ ...testEnv, rateLimits: { report: { max: 7 } } });
    expect(budgets.report.max).toBe(7);
    // The window it did not name is still the default, not zero.
    expect(budgets.report.windowMs).toBe(DEFAULT_RATE_LIMIT_BUDGETS.report.windowMs);
    expect(budgets.read.max).toBe(DEFAULT_RATE_LIMIT_BUDGETS.read.max);
  });

  it('still honours the single-ceiling variables this replaced, as the read budget', () => {
    // A box already setting `RATE_LIMIT_MAX` keeps the behaviour it had rather
    // than silently jumping to the shipped default.
    const budgets = rateLimitBudgets({
      ...testEnv,
      rateLimits: {},
      rateLimitMax: 50,
      rateLimitWindowMs: 30_000,
    });
    expect(budgets.read).toEqual({ max: 50, windowMs: 30_000 });
    expect(budgets.write.max).toBe(DEFAULT_RATE_LIMIT_BUDGETS.write.max);
  });

  it('lets the explicit class name win over the legacy one', () => {
    const budgets = rateLimitBudgets({
      ...testEnv,
      rateLimitMax: 50,
      rateLimits: { read: { max: 9 } },
    });
    expect(budgets.read.max).toBe(9);
  });
});
