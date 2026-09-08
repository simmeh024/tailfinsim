import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HealthResponse, VersionResponse } from '@tailfin/shared';

import { seedAircraftCatalogue } from './aircraft/catalogue';
import { buildApp } from './app';
import { createDatabase, type DatabaseHandle } from './db/client';
import { type ServerEnv } from './env';
import { clearLandingStatsCache } from './landing-stats';
import { makeTestEnv } from './test-fixtures/env';

/**
 * HTTP-surface tests driven through `app.inject()` — no port, no network.
 *
 * The database-backed cases need `DATABASE_URL` and skip loudly without it, the
 * same as the schema constraint tests. The routing and error-handling cases do
 * not, so they always run.
 */

const url = process.env.DATABASE_URL;

/**
 * Auth is off here, which is the fixture's default and is also deliberate:
 * it is what production runs until its own OAuth client exists. The auth
 * surface itself is covered by `auth/session-cookie.test.ts`.
 */
const testEnv: ServerEnv = makeTestEnv({
  // Short, because one case deliberately provokes a 503 from an
  // unreachable database and the suite should not wait five seconds for it.
  databaseConnectTimeoutMs: 500,
});

const describeDb = url ? describe : describe.skip;

describeDb('HTTP surface', () => {
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

  /**
   * The public landing page (LANDING-01, ADR-0028).
   *
   * Served at its own path on every surface, so it reaches production without
   * promoting the game client and without displacing dev's app at `/`.
   */
  describe('GET /landing', () => {
    it('serves the landing page as HTML on the holding surface', async () => {
      const res = await app.inject({ method: 'GET', url: '/landing' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toContain('Build an airline. Make it yours');
    });

    it('leaves `/` alone — the holding page still answers the front door', async () => {
      // The switchover is a launch decision with two named conditions in
      // ADR-0028, not a side effect of adding the page.
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.body).toContain('<title>Tailfin — coming soon</title>');
    });

    it('offers its providers as plain links, so the funnel needs no JavaScript', async () => {
      /*
       * On an instance that has them. The suite's fixture configures no provider
       * — which is the right default for every other case here and is what makes
       * the "no API path at all" assertion below meaningful — so this one builds
       * its own, because provider configuration is read at boot.
       */
      const configured = await buildApp({
        env: makeTestEnv({
          googleClientId: 'id',
          googleClientSecret: 'secret',
          googleEnabled: true,
          discordClientId: 'id',
          discordClientSecret: 'secret',
          discordEnabled: true,
          sessionSecret: 'x'.repeat(48),
          authEnabled: true,
        }),
        db,
      });
      await configured.ready();
      const res = await configured.inject({ method: 'GET', url: '/landing' });
      await configured.close();

      expect(res.body).toContain('href="/api/auth/google"');
      expect(res.body).toContain('href="/api/auth/discord"');

      /*
       * Both are ordinary anchors to server routes, so signing in works with
       * scripting off entirely.
       *
       * This used to assert the page carried no `<script>` at all. It carries one
       * now — the fleet carousel — and the assertion is narrowed rather than
       * dropped: whatever that script does, it must not be load-bearing for the
       * one thing the page exists to do. A funnel that needs JavaScript is a
       * funnel that fails silently.
       */
      const signIn = [...res.body.matchAll(/<a[^>]+href="\/api\/auth\/[^"]+"[^>]*>/g)];
      expect(signIn.length).toBeGreaterThanOrEqual(2);
      for (const anchor of signIn) {
        expect(anchor[0]).not.toMatch(/\son[a-z]+\s*=/i);
      }
    });

    it('makes no external request — no font, CDN or analytics origin', async () => {
      /*
       * Asserted against the things that actually cause a fetch, not against any
       * absolute URL in the document. An SVG `xmlns="http://www.w3.org/2000/svg"`
       * is a namespace identifier the browser never resolves, and `og:url` names
       * the site itself — neither is a request, and a regex that flagged them
       * would have to be silenced rather than satisfied.
       */
      const body = (await app.inject({ method: 'GET', url: '/landing' })).body;
      expect(body).not.toMatch(/\bsrc\s*=\s*["']https?:/i);
      expect(body).not.toMatch(/url\(\s*["']?https?:/i);
      expect(body).not.toMatch(/@import/i);
      // The one stylesheet is same-origin, which is what keeps the holding
      // page's "no fonts, no CDN, no analytics" property while satisfying
      // `style-src 'self'`.
      const sheets = [...body.matchAll(/<link[^>]+stylesheet[^>]*>/gi)].map((m) => m[0]);
      expect(sheets).toHaveLength(1);
      expect(sheets[0]).toContain('href="/landing.css"');
    });

    it('carries no inline style or inline script, which the enforced CSP would block', async () => {
      /*
       * The bug this exists to prevent, because it is invisible to every other
       * check we run. `style-src` at the edge is `'self'` plus **the holding
       * page's** hash. An inline `<style>` here parses, deploys, passes the
       * health check and the post-deploy browser smoke — and renders unstyled in
       * a real browser, because the hash does not match.
       *
       * It shipped exactly that way once. Nothing in CI could see it: the CSP
       * lives in the Caddyfile, `deploy.sh` does not install it, and an inject()
       * response has no browser to enforce it.
       */
      const body = (await app.inject({ method: 'GET', url: '/landing' })).body;
      expect(body).not.toMatch(/<style[\s>]/i);
      expect(body).not.toMatch(/\sstyle\s*=\s*["']/i);

      /*
       * The same rule for scripts, and it is the one the carousel could have
       * broken. `script-src` is `'self'` with no hashes at all, so an inline
       * `<script>` here would not merely be unstyled — the carousel would sit
       * dead on the page while every gate stayed green.
       *
       * Every `<script>` must therefore carry a same-origin `src`.
       */
      const scripts = [...body.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) {
        expect(tag).toMatch(/\ssrc\s*=\s*["']\//);
      }
    });

    it('serves the carousel script as JavaScript from the same origin', async () => {
      const res = await app.inject({ method: 'GET', url: '/landing.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toContain('data-carousel');
    });

    it('serves all five fleet aircraft, and keeps them small', async () => {
      const fleet = [
        '/fleet-atr72.webp',
        '/fleet-e190.webp',
        '/fleet-a321neo.webp',
        '/fleet-777.webp',
        '/fleet-747.webp',
      ];
      let total = 0;
      for (const route of fleet) {
        const res = await app.inject({ method: 'GET', url: route });
        expect(res.statusCode, route).toBe(200);
        expect(res.headers['content-type'], route).toBe('image/webp');
        total += res.rawPayload.length;
      }
      // The five sources were 1.2 MB each. LANDING-11 owns the budget, and five
      // aircraft are not allowed to cost more than the hero.
      expect(total).toBeLessThan(200_000);
    });

    it('shows an aircraft and its type without JavaScript', async () => {
      /*
       * The carousel is an enhancement, not the content. With no script the
       * track never moves, so the first aircraft stands as a static
       * illustration — and the arrows stay hidden, because a control that does
       * nothing reads as a bug rather than as graceful degradation.
       */
      const body = (await app.inject({ method: 'GET', url: '/landing' })).body;
      expect(body).toContain('src="/fleet-atr72.webp"');
      expect(body).toContain('ATR 72-600');
      // Five slides, each captioned.
      expect([...body.matchAll(/class="lp-fleet__slide"/g)]).toHaveLength(5);
      expect([...body.matchAll(/class="lp-fleet__type"/g)]).toHaveLength(5);
      // Every aircraft image carries alt text and explicit dimensions, so the
      // card does not reflow as they load.
      const images = [...body.matchAll(/<img[^>]+class="lp-fleet__image"[^>]*>/g)].map((m) => m[0]);
      expect(images).toHaveLength(5);
      for (const tag of images) {
        expect(tag).toMatch(/\salt="[^"]+"/);
        expect(tag).toMatch(/\swidth="\d+"/);
        expect(tag).toMatch(/\sheight="\d+"/);
      }
    });

    it('serves the hero backdrop as WebP, cached longer than the document', async () => {
      const res = await app.inject({ method: 'GET', url: '/landing-hero.webp' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // Immutable art, unlike the document and its styles: a day, not a minute.
      expect(res.headers['cache-control']).toContain('max-age=86400');
      /*
       * LANDING-11 owns this page's weight budget, and this is the whole of what
       * it spends on art. The ceiling is deliberately close to the current size
       * rather than generous: the source PNG was 1.7 MB, and the failure this
       * catches is somebody committing the original by accident or re-exporting
       * at a quality nobody costed. Raising it should be a decision with a
       * sentence attached, which is why it is asserted rather than assumed.
       */
      expect(res.rawPayload.length).toBeLessThan(300_000);
    });

    it('serves the stylesheet as CSS from the same origin', async () => {
      const res = await app.inject({ method: 'GET', url: '/landing.css' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/css/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // The token block LANDING-02 made the only place in this directory allowed a
      // colour. Its ground is pinned by `theme/landing-tokens.test.ts` to the
      // client's own `--bg-base`, so the front door and the product share one.
      expect(res.body).toContain('--lp-bg: #0b1017;');
      // Each provider wears its own brand colour: Google blue, Discord blurple.
      // They live here rather than in the document now that the styles do.
      expect(res.body).toContain('#4285f4');
      expect(res.body).toContain('#5865f2');
    });

    it('explains a refused sign-in, and does not let it be cached', async () => {
      /*
       * The regression LANDING-04 closes, at the HTTP boundary.
       *
       * A failed OAuth callback redirects to `/?auth_error=<code>` and leaves no
       * session cookie, so it lands on this document. Until now there was
       * nowhere to put the reason: the visitor bounced back to an unchanged page
       * that said nothing at all.
       *
       * `no-store` matters as much as the message. The response describes one
       * attempt; a shared cache holding it would show the next visitor somebody
       * else's refusal, and a cached back-navigation would resurrect one that
       * has already been read.
       */
      const res = await app.inject({
        method: 'GET',
        url: '/landing?auth_error=registration_closed',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('role="alert"');
      expect(res.body).toContain('Tailfin is not open for new accounts yet.');
      expect(res.headers['cache-control']).toBe('no-store');

      // And the ordinary request is unchanged: no alert, still cacheable.
      const clean = await app.inject({ method: 'GET', url: '/landing' });
      expect(clean.body).not.toContain('role="alert"');
      expect(clean.headers['cache-control']).toBe('public, max-age=60');
    });

    it('never reflects the failure code into the document', async () => {
      // `auth_error` is a query parameter on the one page every stranger
      // reaches, served from the origin that holds the session cookie. The code
      // selects a fixed sentence; it is never echoed. `landing-page.test.ts`
      // covers the vocabulary — this proves the wiring does not undo it.
      const res = await app.inject({
        method: 'GET',
        url: `/landing?auth_error=${encodeURIComponent('<img src=x onerror=alert(1)>')}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Sign-in failed. Please try again.');
      expect(res.body).not.toContain('onerror');
      expect(res.body).not.toContain('alert(1)');
    });

    it('states the account policy of this server rather than a build-time promise', async () => {
      // `makeTestEnv` leaves ALLOW_REGISTRATION at its production default of
      // false, so this fixture is the closed state — which is the one that would
      // otherwise lie.
      const res = await app.inject({ method: 'GET', url: '/landing' });
      expect(res.body).toContain('sign-in is limited to existing players');
      expect(res.body).not.toContain('New accounts are created automatically');
    });

    it('counts the real catalogue and the real airlines into the strip', async () => {
      /*
       * The query, against real Postgres — which is the half `landing-stats.test.ts`
       * deliberately does not cover. That file proves the caching and the failure
       * behaviour with a fake; this proves the SQL is valid and returns what the
       * page claims.
       *
       * The catalogue is seeded here rather than assumed: the web node seeds it at
       * startup in `main.ts`, not in `buildApp`, so a test database is only
       * guaranteed to have it if a test puts it there. The seed is insert-if-absent
       * and the rows are immutable, so doing it twice is a no-op.
       */
      await seedAircraftCatalogue(db.db);
      clearLandingStatsCache();

      const body = (await app.inject({ method: 'GET', url: '/landing' })).body;

      // App. C.1 ships eighteen types, and the count comes from the table rather
      // than from the shipped constant — nothing falls back to the build.
      expect(body).toContain('data-count="18"');

      // Airlines is whatever this database holds: a number, or an em-dash if the
      // count could not be taken. Never a fabricated figure, and never a `0`
      // standing in for "we did not manage to look".
      const airlines = /<!--tailfin:stat-airlines-->([\s\S]*?)<!--\//.exec(body)?.[1] ?? '';
      expect(airlines.trim()).toMatch(/^(&mdash;|<span data-count="\d+">[\d,]+<\/span>)$/);
    });

    it('every in-page nav link points at a section that exists', async () => {
      /*
       * The nav is in-page anchors, not routes (LANDING-04). A `World status`
       * link that scrolls nowhere is the failure mode when LANDING-09's strip is
       * eventually gated off, and it is silent — the browser simply does nothing.
       */
      const body = (await app.inject({ method: 'GET', url: '/landing' })).body;
      const targets = [...body.matchAll(/<a href="#([a-z-]+)"/g)].map((m) => m[1]);
      expect(targets.length).toBeGreaterThanOrEqual(3);
      for (const id of targets) {
        expect(body, `nav links to #${String(id)}, which no element has`).toContain(
          `id="${String(id)}"`,
        );
      }
    });

    it('ships no invented statistics', async () => {
      /*
       * LANDING-09 is titled "Real numbers, or no numbers". The mock's 21,547
       * airlines and 2.98M passengers are invented, and a marketing page that
       * ships fabricated statistics is lying about how busy the game is — the
       * kind of lie that survives to launch because everyone remembers it as
       * placeholder copy. The shape is here; the figures are not.
       */
      expect((await app.inject({ method: 'GET', url: '/landing' })).body).not.toMatch(
        /21,547|12,842|2\.98M|45,231/,
      );
    });

    it('reaches no protected data — the document fetches nothing at all', async () => {
      /*
       * The one security property of a public page: an anonymous visitor gets
       * marketing and nothing else. No player, airline or world is named, and
       * the only API paths referenced are sign-in routes.
       *
       * `makeTestEnv` configures no provider, so this fixture is also the
       * strongest version of the assertion: **no** API path at all. That is not
       * incidental — it is what proves the page offers no door this box cannot
       * open, which is the failure AUTH-08's third provider exposed. The nav's
       * "Start airline" used to be a hardcoded `/api/auth/google` and would show
       * up here even with Google switched off.
       */
      /*
       * Matched where a path can actually be *followed* — an `href` or a `src` —
       * rather than anywhere in the text.
       *
       * That is the more precise property and it is also the second thing this
       * assertion got wrong. It first scanned the raw body, and failed on the
       * comment explaining why the nav CTA stopped being a provider link: a path
       * discussed in prose is not a path the document offers. Stripping comments
       * first fixed that and introduced a worse shape — CodeQL's
       * `js/incomplete-multi-character-sanitization` is right that one pass of
       * `replace(/<!--…-->/)` can splice a fresh `<!--` out of what is left, and a
       * test that looks like a half-working sanitiser is a pattern somebody will
       * copy somewhere it matters.
       *
       * Nothing to strip if you never scan prose in the first place.
       */
      const body = (await app.inject({ method: 'GET', url: '/landing' })).body;
      const linked = [...body.matchAll(/(?:href|src)="(\/api\/[^"]*)"/g)].map((m) => m[1]);
      expect([...new Set(linked)].sort()).toEqual([]);
    });

    it('offers exactly the providers this instance has credentials for', async () => {
      /*
       * The positive half, since the fixture above has none. Built with a
       * throwaway app rather than the suite's, because provider configuration is
       * read at boot.
       */
      const configured = await buildApp({
        env: makeTestEnv({
          googleClientId: 'id',
          googleClientSecret: 'secret',
          googleEnabled: true,
          twitchClientId: 'id',
          twitchClientSecret: 'secret',
          twitchEnabled: true,
          sessionSecret: 'x'.repeat(48),
          authEnabled: true,
        }),
        db,
      });
      try {
        await configured.ready();
        const body = (await configured.inject({ method: 'GET', url: '/landing' })).body;
        expect(body).toContain('href="/api/auth/google"');
        expect(body).toContain('href="/api/auth/twitch"');
        // Discord is not configured on this instance, so it is not offered.
        expect(body).not.toContain('href="/api/auth/discord"');
      } finally {
        await configured.close();
      }
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
   * No database involved, so this runs everywhere.
   *
   * TIDY-02 measured the old fixture before changing it. One hundred unused
   * `pg.Pool` create/end cycles against its dead port took 0.59 ms total, while
   * the five isolated tests each took 96-221 ms because every test registered,
   * readied and closed the complete Fastify plugin tree. Under cross-project
   * CPU contention that redundant lifecycle sat inside each test's five-second
   * budget and occasionally lost to the scheduler.
   *
   * Keep one app per environment label instead. The database is a synchronous,
   * non-network alarm: any future database access fails immediately and names
   * the boundary, instead of waiting on a dead-port connection timeout. App
   * teardown remains awaited without swallowing errors.
   */
  const databaseAlarm = createDatabaseAccessAlarm('GET /api/version');
  let devApp: Awaited<ReturnType<typeof buildApp>>;
  let productionApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    devApp = await buildApp({ env: { ...testEnv, environmentLabel: 'dev' }, db: databaseAlarm });
    productionApp = await buildApp({
      env: { ...testEnv, environmentLabel: 'production' },
      db: databaseAlarm,
    });
    await Promise.all([devApp.ready(), productionApp.ready()]);
  });

  afterAll(async () => {
    await Promise.all([devApp.close(), productionApp.close()]);
  });

  it('keeps database access as an immediate, named failure', () => {
    expect(() => databaseAlarm.db.select()).toThrow(
      'GET /api/version unexpectedly accessed db.select',
    );
  });

  it('answers with a build number, commit, environment and start time', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/api/version' });
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

  it('reports the environment it was told, not NODE_ENV', async () => {
    // The whole point: NODE_ENV is `production` on the dev box too, so it cannot
    // be what the badge reads.
    const res = await productionApp.inject({ method: 'GET', url: '/api/version' });
    expect(res.json()).toMatchObject({ environment: 'production' });
  });

  it('is not cached, so a redeployed box does not keep claiming the old build', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/api/version' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('serves the rights-pending A320neo candidate only from dev', async () => {
    const stagedLengths: number[] = [];
    for (const fileName of ['aircraft-lod2.glb', 'aircraft-lod1.glb', 'aircraft-lod0.glb']) {
      const url = `/api/dev/assets/aircraft/${fileName}`;
      const dev = await devApp.inject({ method: 'HEAD', url });
      expect(dev.statusCode).toBe(200);
      expect(dev.headers['content-type']).toMatch(/^model\/gltf-binary/);
      expect(dev.headers['cache-control']).toBe('private, no-store');
      expect(dev.headers['x-content-type-options']).toBe('nosniff');
      stagedLengths.push(Number(dev.headers['content-length']));
      expect(dev.body).toBe('');

      const production = await productionApp.inject({ method: 'HEAD', url });
      expect(production.statusCode).toBe(404);
    }
    expect(stagedLengths[0]).toBeLessThan(stagedLengths[1]!);
    expect(stagedLengths[1]).toBeLessThan(stagedLengths[2]!);
  });

  it('serves an explicitly provisioned recovery export only to the dev review route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tailfin-quarantine-review-'));
    const recoveryPath = join(directory, 'a320neo-recovery.glb');
    const recovery = Buffer.from('glTF-test-recovery');
    writeFileSync(recoveryPath, recovery);
    const reviewApp = await buildApp({
      env: {
        ...testEnv,
        environmentLabel: 'dev',
        devQuarantineA320neoRecoveryGlb: recoveryPath,
      },
      db: databaseAlarm,
    });
    await reviewApp.ready();
    try {
      const response = await reviewApp.inject({
        method: 'GET',
        url: '/api/dev/assets/aircraft/quarantine-a320neo-recovery.glb',
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(recovery.toString());
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');

      const unavailable = await devApp.inject({
        method: 'GET',
        url: '/api/dev/assets/aircraft/quarantine-a320neo-recovery.glb',
      });
      expect(unavailable.statusCode).toBe(404);
      const production = await productionApp.inject({
        method: 'GET',
        url: '/api/dev/assets/aircraft/quarantine-a320neo-recovery.glb',
      });
      expect(production.statusCode).toBe(404);
    } finally {
      await reviewApp.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps dev available when a provisioned recovery export is removed', async () => {
    const reviewApp = await buildApp({
      env: {
        ...testEnv,
        environmentLabel: 'dev',
        devQuarantineA320neoRecoveryGlb: join(tmpdir(), 'tailfin-missing-recovery.glb'),
      },
      db: databaseAlarm,
    });
    await reviewApp.ready();
    try {
      const version = await reviewApp.inject({ method: 'GET', url: '/api/version' });
      expect(version.statusCode).toBe(200);
      const recovery = await reviewApp.inject({
        method: 'GET',
        url: '/api/dev/assets/aircraft/quarantine-a320neo-recovery.glb',
      });
      expect(recovery.statusCode).toBe(404);
    } finally {
      await reviewApp.close();
    }
  });

  it('serves a provisioned semantic authoring export only from its explicit dev route', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tailfin-quarantine-authoring-'));
    const authoringPath = join(directory, 'a320neo-authoring.glb');
    const authoring = Buffer.from('glTF-test-authoring');
    writeFileSync(authoringPath, authoring);
    const reviewApp = await buildApp({
      env: {
        ...testEnv,
        environmentLabel: 'dev',
        devQuarantineA320neoLiveryAuthoringGlb: authoringPath,
      },
      db: databaseAlarm,
    });
    await reviewApp.ready();
    try {
      const response = await reviewApp.inject({
        method: 'GET',
        url: '/api/dev/assets/aircraft/quarantine-a320neo-livery-authoring.glb',
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(authoring.toString());
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');

      const unavailable = await devApp.inject({
        method: 'GET',
        url: '/api/dev/assets/aircraft/quarantine-a320neo-livery-authoring.glb',
      });
      expect(unavailable.statusCode).toBe(404);
      const production = await productionApp.inject({
        method: 'GET',
        url: '/api/dev/assets/aircraft/quarantine-a320neo-livery-authoring.glb',
      });
      expect(production.statusCode).toBe(404);
    } finally {
      await reviewApp.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports the same start time across requests', async () => {
    // It is process start, not request time — a value that changed every call
    // would say nothing about whether the box restarted.
    const a = await devApp.inject({ method: 'GET', url: '/api/version' });
    const b = await devApp.inject({ method: 'GET', url: '/api/version' });
    expect(a.json<{ startedAt: string }>().startedAt).toBe(
      b.json<{ startedAt: string }>().startedAt,
    );
  });

  it('exposes nothing beyond the declared fields', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/api/version' });
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

describe('health degradation', () => {
  it('answers 503 when the database is unreachable', async () => {
    // Deliberately points at a port nothing listens on. deploy.sh polls
    // /healthz to decide whether a release came up, so a server that cannot
    // reach its database must not report success.
    const db = createDatabaseAt('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = await buildApp({ env: { ...testEnv, databaseUrl: 'postgres://unused' }, db });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
      // Still schema-valid — a degraded response is a contract, not a surprise.
      expect(HealthResponse.safeParse(res.json()).success).toBe(true);
    } finally {
      await app.close();
      await db.close();
    }
  });
});

/**
 * A zero-I/O handle for tests whose contract is that the database is untouched.
 * Access throws synchronously, so the failure identifies the forbidden boundary
 * rather than presenting as a connection timeout several seconds later.
 */
function createDatabaseAccessAlarm(context: string): DatabaseHandle {
  const inaccessible = <T extends object>(surface: string): T =>
    new Proxy(
      {},
      {
        get(_target, property): never {
          throw new Error(`${context} unexpectedly accessed ${surface}.${String(property)}`);
        },
        set(_target, property): never {
          throw new Error(`${context} unexpectedly wrote ${surface}.${String(property)}`);
        },
      },
    ) as T;

  return {
    db: inaccessible<DatabaseHandle['db']>('db'),
    pool: inaccessible<DatabaseHandle['pool']>('pool'),
    close: () => {
      throw new Error(`${context} unexpectedly closed its database alarm`);
    },
  };
}

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
   * before its query and `requireAirline` answers 401 — so a 401 here means the
   * route exists, and a 404 would mean it does not. If this ever hangs, the
   * handler has started querying before checking auth.
   */
  async function withApp(
    body: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<void>,
  ): Promise<void> {
    const db = createDatabaseAt('postgres://nobody:nothing@127.0.0.1:1/none');
    const app = await buildApp({ env: testEnv, db });
    await app.ready();
    try {
      await body(app);
    } finally {
      await app.close();
      await db.close();
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
