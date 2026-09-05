import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { player, playerIdentity } from '../db/schema';
import { type ServerEnv } from '../env';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from '../test-fixtures/authorization';
import { collectRegisteredRoutes } from '../test-fixtures/route-inventory';

/**
 * The four facts that stand in for a CSRF token (SEC-HARD-07, ADR-0025).
 *
 * Tailfin authenticates with a cookie and has no CSRF token, and that is a
 * decision rather than an omission: `SameSite=Lax` + one origin + no CORS + no
 * state-changing `GET` already prevents the attack, so a token would add a
 * value to mint, rotate and fail against nothing.
 *
 * The decision is only safe while all four remain true, and each of them is the
 * sort of thing a reasonable change removes by accident — installing
 * `@fastify/cors` the way it is usually installed, or exposing one action as a
 * `GET` because it is convenient from a link. Nothing here defends against an
 * attacker; it defends against **us**, six months from now.
 *
 * The stake is `POST /api/admin/worlds/:worldId/reset`, which destroys every
 * airline in a world with no undo (ADR-0005). That is why this is tested rather
 * than reasoned about.
 *
 * The route-shape half needs no database and runs on every pull request. The
 * cookie and cross-origin halves need one; CI provides it.
 */

/* ------------------------------------------------------------------ facts 2 and 4 */

/**
 * Every `GET` route that changes nothing.
 *
 * Being in this list is a **claim**, not bookkeeping: it says a browser may
 * follow this route from any page on the internet, with the player's session
 * cookie attached, and nothing will happen. `SameSite=Lax` withholds the cookie
 * on a cross-site `POST` but sends it on a top-level cross-site `GET`, so a
 * `GET` that writes is reachable by any link anyone can get a player to click.
 *
 * Sorted as the router reports them, so the diff of an addition is one line.
 */
const READ_ONLY_GET_ROUTES = [
  '/',
  '/api/admin/admins',
  '/api/admin/airlines/:airlineId',
  '/api/admin/audit',
  '/api/admin/economy-config',
  '/api/admin/economy-config/:version',
  '/api/admin/economy-config/:version/diff',
  '/api/admin/overview',
  '/api/admin/players',
  '/api/admin/players/:playerId',
  '/api/admin/system-health',
  '/api/admin/world-presets',
  '/api/admin/worlds',
  '/api/admin/worlds/:worldId/config',
  '/api/admin/worlds/:worldId/npc',
  '/api/admin/worlds/health',
  '/api/airlines/founding-airports',
  '/api/airlines/founding-options',
  '/api/airlines/me',
  '/api/airports/:icao/slots',
  '/api/automation',
  '/api/crew',
  '/api/currencies',
  '/api/finance/pnl',
  '/api/fleet/airframes',
  '/api/fleet/airframes/:airframeId',
  '/api/fleet/catalogue',
  '/api/fleet/maintenance',
  '/api/fleet/orders',
  '/api/fleet/used-market',
  '/api/ground/:icao',
  '/api/ground/contracts',
  '/api/me',
  '/api/network/connections',
  '/api/office',
  '/api/office/executive',
  '/api/routes',
  '/api/routes/:routeId/competition',
  '/api/routes/:routeId/performance',
  '/api/routes/:routeId/waterfall',
  '/api/schedules',
  '/api/version',
  '/api/world/airports',
  '/api/world/clock',
  '/api/world/map',
  '/healthz',
] as const;

/**
 * The `GET` routes that **do** change state, and what protects each instead.
 *
 * Both are the sign-in flow rather than the game, and both must be `GET`: OAuth
 * returns the browser by top-level navigation, which is exactly the case
 * `SameSite=Lax` deliberately allows through.
 *
 * A third entry here is a decision, not a detail. Whoever adds one has to write
 * the control down in the same line.
 */
const STATE_CHANGING_GET_ROUTES: { url: string; instead: string }[] = [
  {
    url: '/api/auth/google',
    instead:
      'Writes the signed `tailfin_oauth` state cookie and nothing else. Forging the request ' +
      'grants no access — it starts a sign-in the attacker cannot finish.',
  },
  {
    url: '/api/auth/google/callback',
    instead:
      'Creates a session, and is guarded by the OAuth `state` parameter matching the signed ' +
      '`tailfin_oauth` cookie — the standard login-CSRF control. `session-cookie.test.ts` ' +
      'proves a callback arriving without that cookie is refused.',
  },
];

describe('no state-changing endpoint is reachable by GET (ADR-0025, fact 4)', () => {
  it('has every registered GET route classified as safe or as a named exception', async () => {
    const registered = (await collectRegisteredRoutes())
      .filter((route) => route.method === 'GET')
      .map((route) => route.url);

    // Guards the guard: two empty sets agree perfectly, so a broken enumeration
    // would otherwise turn this file into a pass.
    expect(registered.length).toBeGreaterThanOrEqual(40);

    const classified = new Set<string>([
      ...READ_ONLY_GET_ROUTES,
      ...STATE_CHANGING_GET_ROUTES.map((route) => route.url),
    ]);
    const unclassified = registered.filter((url) => !classified.has(url)).sort();

    expect(
      unclassified,
      'A GET route was added without deciding whether it is safe.\n\n' +
        'This matters more than it looks. Session cookies are SameSite=Lax, which withholds them ' +
        'on a cross-site POST but SENDS them on a top-level cross-site GET — so a GET that ' +
        'changes anything can be triggered from any page on the internet by getting a signed-in ' +
        'player to follow a link. There is no CSRF token to catch it (ADR-0025).\n\n' +
        'If these routes change nothing, add them to READ_ONLY_GET_ROUTES. If one of them does ' +
        'change something, it almost certainly wants to be a POST instead; if it genuinely ' +
        'cannot be, add it to STATE_CHANGING_GET_ROUTES and name the control that replaces ' +
        `SameSite.\n\n  ${unclassified.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the state-changing GET exceptions down to the sign-in flow', async () => {
    // Not merely "the list is short": the two entries are named, so moving a
    // game action into this list fails rather than passing as a longer list.
    expect(STATE_CHANGING_GET_ROUTES.map((route) => route.url)).toEqual([
      '/api/auth/google',
      '/api/auth/google/callback',
    ]);

    // And the exception has to still exist, or the list is stale prose.
    const registered = new Set((await collectRegisteredRoutes()).map((route) => route.key));
    for (const route of STATE_CHANGING_GET_ROUTES) {
      expect(registered.has(`GET ${route.url}`), `${route.url} is listed but not registered`).toBe(
        true,
      );
      expect(route.instead.length).toBeGreaterThan(40);
    }
  });

  it('claims nothing about a route that no longer exists', async () => {
    // The other direction. A read-only claim about a deleted route is harmless
    // on its own, but it makes the list drift, and a drifting list stops being
    // read — which is how the real entry gets missed.
    const registered = new Set(
      (await collectRegisteredRoutes()).filter((r) => r.method === 'GET').map((r) => r.url),
    );
    const stale = READ_ONLY_GET_ROUTES.filter((url) => !registered.has(url));

    expect(
      stale,
      `These routes are declared read-only but are no longer registered. Remove them:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('registers no OPTIONS route, so a CORS preflight cannot succeed (fact 2)', async () => {
    /*
     * The half of "no CORS" that is easiest to lose.
     *
     * Anything that is not a *simple* request — a JSON `POST`, which is every
     * mutation the client makes — is preflighted, and a preflight that gets no
     * answer fails closed. Registering `OPTIONS` is what `@fastify/cors` does
     * first, so this fails the moment somebody installs it, which is the point:
     * the install would look like a routine convenience.
     */
    const options = (await collectRegisteredRoutes()).filter((route) => route.method === 'OPTIONS');
    expect(
      options.map((route) => route.url),
      'An OPTIONS route was registered. If CORS is now wanted, ADR-0025 has to be amended in ' +
        'the same change — SameSite=Lax stops being sufficient once cross-origin requests are ' +
        'answered. See SEC-HARD-08.',
      // The enumeration filters HEAD and OPTIONS as derived methods, so this is
      // belt and braces against that filter changing rather than the router.
    ).toEqual([]);
  });
});

/* --------------------------------------------------------------- facts 1 and 2 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [security/csrf.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const baseEnv: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 2,
  databaseConnectTimeoutMs: 5_000,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  // http, so `Secure` is off and the cookie travels under inject(). The https
  // case is asserted separately, because that is the one production runs.
  publicOrigin: 'http://localhost:3000',
  googleClientId: 'test-client-id.apps.googleusercontent.com',
  googleClientSecret: 'test-client-secret',
  sessionSecret: 'c'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

/** A page that is not us. Nothing here should ever treat it as one. */
const HOSTILE_ORIGIN = 'https://tailfinsim.com.evil.example';

function setCookieHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers['set-cookie'];
  const all: string[] = Array.isArray(raw)
    ? (raw as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];
  return all.find((entry) => entry.startsWith(`${name}=`));
}

describeDb('the cookie and the origin are what stop a forged request', () => {
  let db: DatabaseHandle;
  let suite: AuthorizationTestSuite;

  beforeAll(async () => {
    db = createDatabase();
    suite = await createAuthorizationTestSuite({ db, env: baseEnv, suite: 'csrf' });
  });

  afterAll(async () => {
    await suite.cleanup();
    await suite.app.close();
    await db.close();
  });

  /**
   * A request that could not succeed at doing anything.
   *
   * `POST /api/admin/worlds` with an empty body: validation refuses it before
   * the handler acts, so the assertions below reach the *guard* without ever
   * reaching the effect. Naming the reset route here instead would be a better
   * story and a worse test — it destroys a world when it works.
   */
  const forgedWorldCreate = {
    method: 'POST' as const,
    url: '/api/admin/worlds',
    payload: {},
    headers: {
      origin: HOSTILE_ORIGIN,
      referer: `${HOSTILE_ORIGIN}/free-aircraft`,
      'content-type': 'application/json',
    },
  };

  it('refuses a cross-origin admin POST that arrives without the session cookie', async () => {
    // Which is what a browser actually sends. `SameSite=Lax` means the cookie
    // is simply not attached to a cross-site POST, so the forged request is
    // indistinguishable from a stranger's — and gets a stranger's answer.
    const response = await suite.app.inject(forgedWorldCreate);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('would carry it out if the cookie arrived, which is why SameSite is the control', async () => {
    /*
     * The uncomfortable half, asserted deliberately.
     *
     * The same forged request — hostile `Origin`, hostile `Referer` — passes the
     * admin guard the moment the cookie is present, and is refused at 400 by
     * body validation rather than by anything security-related. Fastify does not
     * inspect `Origin`, and nothing here does either.
     *
     * So the server cannot tell a forged request from a real one. The browser
     * can, and `SameSite=Lax` is how it is told. If this test ever starts
     * returning 403, something began checking `Origin` server-side, and ADR-0025
     * should be updated to say so rather than left describing a control that has
     * moved.
     */
    const response = await suite.app.inject({
      ...forgedWorldCreate,
      headers: { ...forgedWorldCreate.headers, cookie: suite.identities.admin.cookie ?? '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(403);
  });

  it('answers a cross-origin request with no Access-Control-Allow-Origin (fact 2)', async () => {
    /*
     * So the response is unreadable to the calling page even when the request
     * itself goes through. This is the fact `@fastify/cors` would remove, and it
     * is swept across the shapes that matter rather than one route: an
     * unauthenticated read, an authenticated read, and a mutation.
     */
    const requests = [
      { method: 'GET' as const, url: '/api/version' },
      { method: 'GET' as const, url: '/api/me' },
      {
        method: 'GET' as const,
        url: '/api/admin/worlds',
        headers: { cookie: suite.identities.admin.cookie ?? '' },
      },
      forgedWorldCreate,
    ];

    for (const request of requests) {
      const response = await suite.app.inject({
        ...request,
        headers: { ...('headers' in request ? request.headers : {}), origin: HOSTILE_ORIGIN },
      });

      const cors = Object.keys(response.headers).filter((name) =>
        name.toLowerCase().startsWith('access-control-'),
      );
      expect(
        cors,
        `${request.method} ${request.url} answered a cross-origin request with ${cors.join(', ')}. ` +
          'ADR-0025 treats the absence of CORS as one of the four facts replacing a CSRF token.',
      ).toEqual([]);
    }
  });
});

describeDb('the session cookie carries the attribute the decision rests on', () => {
  let db: DatabaseHandle;
  let playerId: string;
  const subject = `csrf-cookie-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    db = createDatabase();
    // An identity that already exists, so the sign-in below is a returning
    // player rather than a registration — `allowRegistration` is false here as
    // it is in production, and a new subject would be turned away without ever
    // reaching the cookie this test is about.
    const created = await db.db
      .insert(player)
      .values({ displayName: 'CSRF Cookie Pilot' })
      .returning({ id: player.id });
    playerId = created[0]!.id;
    await db.db.insert(playerIdentity).values({
      playerId,
      provider: 'google',
      subject,
      email: `${subject}@example.test`,
    });
  });

  afterAll(async () => {
    // Identity and sessions cascade with the player.
    await db.db.delete(player).where(eq(player.id, playerId));
    await db.close();
  });

  /**
   * Sign in for real, and hand back the raw `Set-Cookie` line.
   *
   * Asserted on the header rather than on the options object in
   * `auth/routes.ts`. The options object is what somebody would read to check;
   * the header is what the browser obeys. They have been the same so far, and a
   * test that read the source would keep passing if a plugin or a later
   * `setCookie` overrode it.
   */
  async function signIn(env: ServerEnv): Promise<string | undefined> {
    const app = await buildApp({
      env,
      db,
      googleAuth: {
        exchangeCode: () => Promise.resolve('provider-access-token'),
        fetchProfile: () =>
          Promise.resolve({
            subject,
            email: `${subject}@example.test`,
            name: 'CSRF Cookie Pilot',
            picture: null,
          }),
      },
    });
    await app.ready();

    try {
      const start = await app.inject({ method: 'GET', url: '/api/auth/google' });
      const state = new URL(start.headers.location!).searchParams.get('state')!;
      const oauth = setCookieHeader(start.headers, 'tailfin_oauth')!;
      const value = decodeURIComponent(oauth.slice(oauth.indexOf('=') + 1, oauth.indexOf(';')));

      const signedIn = await app.inject({
        method: 'GET',
        url: `/api/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`,
        cookies: { tailfin_oauth: value },
      });
      expect(signedIn.statusCode, 'the sign-in fixture did not complete').toBe(302);
      return setCookieHeader(signedIn.headers, SESSION_COOKIE);
    } finally {
      await app.close();
    }
  }

  it('is SameSite=Lax or stricter, HttpOnly, and scoped to the whole site', async () => {
    const cookie = await signIn(baseEnv);

    expect(cookie, 'the sign-in issued no session cookie at all').toBeDefined();
    // Lax or Strict. Not None — which is the value a future embed or a second
    // origin would push it towards, and the one that removes the protection
    // entirely (ADR-0025 revisit trigger 3).
    expect(cookie).toMatch(/SameSite=(Lax|Strict)/);
    expect(cookie).not.toMatch(/SameSite=None/i);
    // Not part of the CSRF argument, but the same options object writes them,
    // so a change that dropped one probably dropped the other.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/');
  });

  it('is Secure whenever the public origin is https, as both deployed hosts are', async () => {
    const cookie = await signIn({ ...baseEnv, publicOrigin: 'https://dev.tailfinsim.com' });
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/SameSite=(Lax|Strict)/);
  });
});
