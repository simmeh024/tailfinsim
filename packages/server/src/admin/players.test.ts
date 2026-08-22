import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminGrant, airline, player, playerIdentity, session, world } from '../db/schema';
import { type ServerEnv } from '../env';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from '../test-fixtures/authorization';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { createWorld } from '../world/lifecycle';

import { readAudit } from './audit';
import { BOOTSTRAP_ACTOR, grantAdmin } from './grants';
import { listPlayers, readPlayer } from './players';

/**
 * Browsing players (M1A-08).
 *
 * The acceptance criteria, each with a test that fails if it stops being true:
 *
 *   - no route added here writes to player data
 *   - search across 10,000 players returns inside a second
 *   - email addresses never leave the admin API
 *   - a player's detail never renders a session token, only metadata
 *   - the decision on auditing views is recorded — and here, enforced
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [players.test] DATABASE_URL not set — skipping player tests.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 4,
  databaseConnectTimeoutMs: 5000,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  publicOrigin: 'http://localhost:3000',
  googleClientId: 'test-client-id.apps.googleusercontent.com',
  googleClientSecret: 'test-client-secret',
  sessionSecret: 'a'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

describeDb('browsing players', () => {
  let db: DatabaseHandle;
  const madePlayers: string[] = [];
  const madeWorlds: string[] = [];
  let fixtures: FoundedAirlineFixtureHarness;
  /** Unique per run, so a search cannot match rows another test file left behind. */
  const tag = Math.random().toString(36).slice(2, 8);

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  /**
   * Deletes in batches.
   *
   * The 10,000-player test makes `madePlayers` long enough that a single
   * `IN (…)` would bind ten thousand parameters — under Postgres's limit, but
   * only just, and slow. Batching keeps cleanup boring however large a test gets.
   */
  async function deleteInBatches(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      await db.db.delete(airline).where(inArray(airline.playerId, batch));
      await db.db.delete(session).where(inArray(session.playerId, batch));
      await db.db.delete(playerIdentity).where(inArray(playerIdentity.playerId, batch));
      await db.db.delete(adminGrant).where(inArray(adminGrant.playerId, batch));
      await db.db.delete(player).where(inArray(player.id, batch));
    }
  }

  afterEach(async () => {
    await fixtures.cleanup();
    if (madePlayers.length > 0) {
      await deleteInBatches(madePlayers.splice(0));
    }
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(world).where(eq(world.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  const ACTOR = { playerId: null, label: 'test admin' };

  async function makePlayer(displayName: string): Promise<string> {
    const rows = await db.db.insert(player).values({ displayName }).returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    return id;
  }

  async function makeWorld(): Promise<string> {
    const { world: created } = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `players-${Math.random().toString(36).slice(2, 10)}`,
    });
    madeWorlds.push(created.id);
    await db.db.update(world).set({ status: 'open' }).where(eq(world.id, created.id));
    return created.id;
  }

  /**
   * The schema's format checks are strict and differ between the two codes:
   * IATA is `^[A-Z0-9]{2}$` and ICAO is `^[A-Z]{3}$`. Building the ICAO by
   * prefixing the IATA produced `XM1` for a code containing a digit, which
   * Postgres refused — so the letters are taken from an alphabet rather than
   * from the caller's code.
   */
  async function makeAirline(
    worldId: string,
    playerId: string,
    name: string,
    code: string,
  ): Promise<string> {
    const created = await fixtures.create({
      worldId,
      playerId,
      name,
      iataCode: code.slice(0, 2).toUpperCase(),
      baseCountry: 'GB',
    });
    return created.airline.icaoCode;
  }

  describe('the list', () => {
    it('shows a player with what they hold', async () => {
      const worldId = await makeWorld();
      const id = await makePlayer(`Amelia ${tag}`);
      await makeAirline(worldId, id, `Hart Air ${tag}`, 'ha');

      const page = await listPlayers(db.db, { query: tag });
      const found = page.players.find((entry) => entry.id === id);

      expect(found).toBeDefined();
      expect(found?.displayName).toBe(`Amelia ${tag}`);
      expect(found?.airlines).toBe(1);
      expect(found?.airlineLinks).toEqual([
        expect.objectContaining({ name: `Hart Air ${tag}`, worldId, status: 'active' }),
      ]);
      expect(found?.isAdmin).toBe(false);
      expect(found?.lastSeenAt).toBeNull();
    });

    it('counts each thing once, however many of the other there are', async () => {
      // Two airlines and three sessions on one player. Joined rather than
      // correlated, this returns six rows and reports six airlines.
      const worldA = await makeWorld();
      const worldB = await makeWorld();
      const id = await makePlayer(`Multi ${tag}`);
      await makeAirline(worldA, id, `First ${tag}`, 'aa');
      await makeAirline(worldB, id, `Second ${tag}`, 'bb');
      for (let i = 0; i < 3; i += 1) await createSession(db.db, id, 24);

      const page = await listPlayers(db.db, { query: `Multi ${tag}` });
      expect(page.players).toHaveLength(1);
      expect(page.players[0]?.airlines).toBe(2);
      expect(page.total).toBe(1);
    });

    it('reports the newest session as last seen', async () => {
      const id = await makePlayer(`Seen ${tag}`);
      await createSession(db.db, id, 24);

      const page = await listPlayers(db.db, { query: `Seen ${tag}` });
      const seen = page.players[0]?.lastSeenAt;
      expect(seen).not.toBeNull();
      // A real ISO instant, not the string Postgres hands back for a raw
      // aggregate — `sql<Date>` is an assertion, not a conversion.
      expect(Number.isNaN(Date.parse(seen ?? ''))).toBe(false);
    });

    it('marks an admin as one', async () => {
      const id = await makePlayer(`Boss ${tag}`);
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);

      const page = await listPlayers(db.db, { query: `Boss ${tag}` });
      expect(page.players[0]?.isAdmin).toBe(true);
    });

    it('never puts an email address in the list', async () => {
      const id = await makePlayer(`Mailed ${tag}`);
      await db.db.insert(playerIdentity).values({
        playerId: id,
        provider: 'google',
        subject: `sub-${tag}`,
        email: `secret-${tag}@example.com`,
      });

      const page = await listPlayers(db.db, { query: `Mailed ${tag}` });
      // Asserted against the whole serialised page, not against a field: the
      // point is that there is nowhere for it to appear, including somewhere
      // added later.
      expect(JSON.stringify(page)).not.toContain('secret-');
      expect(JSON.stringify(page)).not.toContain('@example.com');
    });
  });

  describe('search', () => {
    it('finds a player by their own name', async () => {
      const id = await makePlayer(`Findable ${tag}`);
      const page = await listPlayers(db.db, { query: `findable ${tag}` });
      expect(page.players.map((entry) => entry.id)).toContain(id);
    });

    it('finds a player by their airline name, which is what support is quoted', async () => {
      const worldId = await makeWorld();
      const id = await makePlayer(`Quiet ${tag}`);
      await makeAirline(worldId, id, `Loud Airways ${tag}`, 'la');

      const page = await listPlayers(db.db, { query: `loud airways ${tag}` });
      expect(page.players.map((entry) => entry.id)).toContain(id);
    });

    it('finds a player by the code on the side of the aircraft', async () => {
      const worldId = await makeWorld();
      const id = await makePlayer(`Coded ${tag}`);
      const icao = await makeAirline(worldId, id, `Coded Air ${tag}`, 'zq');

      // Both codes, and case-insensitively — support is quoting what they were
      // told, not what the database stores.
      expect((await listPlayers(db.db, { query: 'ZQ' })).players.map((e) => e.id)).toContain(id);
      expect(
        (await listPlayers(db.db, { query: icao.toLowerCase() })).players.map((e) => e.id),
      ).toContain(id);
    });

    it('returns one row for a player whose several airlines all match', async () => {
      const worldA = await makeWorld();
      const worldB = await makeWorld();
      const id = await makePlayer(`Fleet ${tag}`);
      await makeAirline(worldA, id, `Match ${tag} one`, 'm1');
      await makeAirline(worldB, id, `Match ${tag} two`, 'm2');

      const page = await listPlayers(db.db, { query: `Match ${tag}` });
      expect(page.players.filter((entry) => entry.id === id)).toHaveLength(1);
    });

    it('treats % and _ as text, not as wildcards', async () => {
      // Otherwise searching for `_` returns every player, which reads as a
      // broken search rather than a working one.
      await makePlayer(`Percent ${tag}`);
      const all = await listPlayers(db.db, { query: '' });
      const wild = await listPlayers(db.db, { query: '%' });
      const underscore = await listPlayers(db.db, { query: '_' });

      expect(all.total).toBeGreaterThan(0);
      expect(wild.total).toBeLessThan(all.total);
      expect(underscore.total).toBeLessThan(all.total);
    });

    it('pages, and says how many there are in total', async () => {
      for (let i = 0; i < 5; i += 1) await makePlayer(`Paged ${tag} ${String(i)}`);

      const first = await listPlayers(db.db, { query: `Paged ${tag}`, limit: 2 });
      const second = await listPlayers(db.db, { query: `Paged ${tag}`, limit: 2, offset: 2 });

      expect(first.total).toBe(5);
      expect(first.players).toHaveLength(2);
      expect(second.players).toHaveLength(2);
      // Different pages, not the same one twice — the order has to be total, so
      // `id` breaks ties between rows created in the same millisecond.
      const ids = new Set([...first.players, ...second.players].map((entry) => entry.id));
      expect(ids.size).toBe(4);
    });

    it('echoes the query back, so a slow answer cannot be shown against a newer one', async () => {
      const page = await listPlayers(db.db, { query: '  spaced  ' });
      expect(page.query).toBe('spaced');
    });

    it('searches 10,000 players inside a second', async () => {
      // The acceptance criterion, measured rather than asserted. Ten thousand
      // rows inserted in bulk, then the search timed against them.
      //
      // Measured on the CI runner, which is not the production box — that is a
      // 2-core Xeon E5-2620 v4, roughly five times slower than a development
      // machine (see CLAUDE.md). The budget here is one second and the observed
      // figure is milliseconds, so the margin absorbs the difference many times
      // over. If it ever stops doing so, the note in `players.ts` about
      // `pg_trgm` is the next step.
      const names = Array.from({ length: 10_000 }, (_, i) => ({
        displayName: `Bulk ${tag} ${String(i).padStart(5, '0')}`,
      }));
      for (let i = 0; i < names.length; i += 1000) {
        const inserted = await db.db
          .insert(player)
          .values(names.slice(i, i + 1000))
          .returning({ id: player.id });
        madePlayers.push(...inserted.map((row) => row.id));
      }

      const total = await db.db.select({ n: sql<number>`count(*)::int` }).from(player);
      expect(total[0]?.n ?? 0).toBeGreaterThanOrEqual(10_000);

      // Fastest of three: a single sample on a shared runner measures the
      // neighbours as much as the query.
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        const page = await listPlayers(db.db, { query: `Bulk ${tag} 07421` });
        best = Math.min(best, performance.now() - started);
        expect(page.total).toBe(1);
      }

      // Printed so the CI log carries the actual figure rather than only a pass:
      // a budget met by 5ms and a budget met by 900ms are different situations,
      // and the difference is invisible from a green tick. `warn` because that
      // is what the lint config permits, and this is a note about the run.
      console.warn(`  [players.test] search over 10,000 players: ${best.toFixed(1)}ms`);
      expect(best).toBeLessThan(1000);
    }, 60_000);
  });

  describe('one player in detail', () => {
    it('shows identities, sessions and airlines', async () => {
      const worldId = await makeWorld();
      const id = await makePlayer(`Detailed ${tag}`);
      await db.db.insert(playerIdentity).values({
        playerId: id,
        provider: 'google',
        subject: `sub-detailed-${tag}`,
        email: `detailed-${tag}@example.com`,
      });
      await createSession(db.db, id, 24);
      await makeAirline(worldId, id, `Detail Air ${tag}`, 'dt');

      const detail = await readPlayer(db.db, id, ACTOR);
      if (!detail) throw new Error('expected a player');

      expect(detail.displayName).toBe(`Detailed ${tag}`);
      expect(detail.identities).toHaveLength(1);
      expect(detail.identities[0]?.provider).toBe('google');
      expect(detail.identities[0]?.email).toBe(`detailed-${tag}@example.com`);
      expect(detail.sessions).toHaveLength(1);
      expect(detail.airlines).toHaveLength(1);
      expect(detail.airlines[0]?.worldName).toBeTruthy();
      expect(detail.airlines[0]?.reputation).toBeCloseTo(0.35, 2);
    });

    it('never returns a session token, in any form', async () => {
      // The database holds only a SHA-256 of it, and the response shape has
      // nowhere to put one. Asserted against the whole payload rather than a
      // field, so a field added later is caught too.
      const id = await makePlayer(`Tokened ${tag}`);
      const { token } = await createSession(db.db, id, 24);

      const detail = await readPlayer(db.db, id, ACTOR);
      const serialised = JSON.stringify(detail);

      expect(serialised).not.toContain(token);
      expect(serialised).not.toContain('tokenHash');
      expect(serialised).not.toContain('token_hash');
      // 64 hex characters would be the hash. There should be no such string.
      expect(/[0-9a-f]{64}/.test(serialised)).toBe(false);
    });

    it('says whether a session is still live, judged on the server', async () => {
      const id = await makePlayer(`Expiring ${tag}`);
      await createSession(db.db, id, 24);

      const live = await readPlayer(db.db, id, ACTOR);
      expect(live?.sessions[0]?.expired).toBe(false);

      // The same session, judged an hour after it expires.
      const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const stale = await readPlayer(db.db, id, ACTOR, later);
      expect(stale?.sessions[0]?.expired).toBe(true);
    });

    it('answers null for a player that is not there', async () => {
      expect(await readPlayer(db.db, '11111111-2222-3333-4444-555555555555', ACTOR)).toBeNull();
    });

    it('writes nothing to player data', async () => {
      // The criterion, checked rather than trusted: the whole row is compared
      // either side of the read.
      const id = await makePlayer(`Untouched ${tag}`);
      const before = await db.db.select().from(player).where(eq(player.id, id));
      await readPlayer(db.db, id, ACTOR);
      const after = await db.db.select().from(player).where(eq(player.id, id));
      expect(after).toEqual(before);
    });
  });

  describe('looking is recorded', () => {
    it('audits a detail view, with what was disclosed', async () => {
      const id = await makePlayer(`Watched ${tag}`);
      await readPlayer(db.db, id, ACTOR);

      const entries = (await readAudit(db.db, { limit: 500, includeViews: true })).filter(
        (entry) => entry.subjectId === id,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe('player.viewed');
      expect(entries[0]?.actorLabel).toBe('test admin');
      // Counts of what was shown, not a second copy of it. The log must not
      // become the thing it guards.
      expect(entries[0]?.after).toContain('sessions');
      expect(entries[0]?.after).not.toContain('@example.com');
    });

    it('does not audit a search', async () => {
      const id = await makePlayer(`Searched ${tag}`);
      await listPlayers(db.db, { query: `Searched ${tag}` });

      const entries = (await readAudit(db.db, { limit: 500, includeViews: true })).filter(
        (entry) => entry.subjectId === id,
      );
      expect(entries).toHaveLength(0);
    });

    it('keeps views out of the log by default', async () => {
      // The other half of the decision. Views are recorded and are *not* what
      // the log shows first, because "who reset the world?" must not be buried
      // under three hundred page views.
      const id = await makePlayer(`Hidden ${tag}`);
      await readPlayer(db.db, id, ACTOR);

      const defaultView = await readAudit(db.db, { limit: 500 });
      expect(defaultView.some((entry) => entry.subjectId === id)).toBe(false);
      expect(defaultView.some((entry) => entry.action === 'player.viewed')).toBe(false);

      const withViews = await readAudit(db.db, { limit: 500, includeViews: true });
      expect(withViews.some((entry) => entry.subjectId === id)).toBe(true);
    });
  });

  describe('over HTTP', () => {
    let authorization: AuthorizationTestSuite;

    beforeAll(async () => {
      authorization = await createAuthorizationTestSuite({ db, env, suite: 'admin-players' });
    });

    afterAll(async () => {
      await authorization.cleanup();
    });

    async function cookieFor(playerId: string): Promise<string> {
      const { token } = await createSession(db.db, playerId, 1);
      return `${SESSION_COOKIE}=${token}`;
    }

    async function makeAdmin(): Promise<string> {
      const id = await makePlayer(`admin-${tag}-${Math.random().toString(36).slice(2, 6)}`);
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);
      return id;
    }

    it('enforces the canonical actor matrix on the player browser', async () => {
      const paths = [
        '/api/admin/players',
        `/api/admin/players/${authorization.identities.playerA.playerId!}`,
      ];
      for (const path of paths) {
        await authorization.expectAuthorization({
          request: { method: 'GET', url: path },
          guest: 401,
          playerA: 403,
          playerB: 403,
          admin: 200,
        });
      }
    });

    it('lists players to an admin', async () => {
      const actor = await makeAdmin();
      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'GET',
          url: `/api/admin/players?q=${encodeURIComponent(tag)}`,
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(200);
        const body = reply.json<{ players: unknown[]; total: number; query: string }>();
        expect(Array.isArray(body.players)).toBe(true);
        expect(body.query).toBe(tag);
      } finally {
        await app.close();
      }
    });

    it('answers 404 for a player that is not there, and for an id that is not a uuid', async () => {
      const actor = await makeAdmin();
      const app = buildApp({ env, db });
      try {
        const cookie = await cookieFor(actor);
        for (const id of ['11111111-2222-3333-4444-555555555555', 'not-a-uuid']) {
          const reply = await app.inject({
            method: 'GET',
            url: `/api/admin/players/${id}`,
            headers: { cookie },
          });
          expect(reply.statusCode).toBe(404);
        }
      } finally {
        await app.close();
      }
    });

    it('serves the detail an admin needs, and nothing that authenticates anyone', async () => {
      const actor = await makeAdmin();
      const subject = await makePlayer(`Subject ${tag}`);
      await db.db.insert(playerIdentity).values({
        playerId: subject,
        provider: 'google',
        subject: `sub-http-${tag}`,
        email: `http-${tag}@example.com`,
      });
      const { token } = await createSession(db.db, subject, 24);

      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'GET',
          url: `/api/admin/players/${subject}`,
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(200);
        expect(reply.body).toContain(`http-${tag}@example.com`);
        // Serialised through the response schema, which strips anything not
        // declared — so this holds even if the handler started returning more.
        expect(reply.body).not.toContain(token);
        expect(/[0-9a-f]{64}/.test(reply.body)).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('leaves views out of the audit endpoint unless asked', async () => {
      const actor = await makeAdmin();
      const subject = await makePlayer(`Viewed ${tag}`);
      await readPlayer(db.db, subject, ACTOR);

      const app = buildApp({ env, db });
      try {
        const cookie = await cookieFor(actor);
        const plain = await app.inject({
          method: 'GET',
          url: '/api/admin/audit',
          headers: { cookie },
        });
        const withViews = await app.inject({
          method: 'GET',
          url: '/api/admin/audit?includeViews=true',
          headers: { cookie },
        });

        expect(plain.json<{ entries: { action: string }[] }>().entries).not.toContainEqual(
          expect.objectContaining({ action: 'player.viewed' }),
        );
        expect(withViews.json<{ entries: { action: string }[] }>().entries).toContainEqual(
          expect.objectContaining({ action: 'player.viewed' }),
        );
      } finally {
        await app.close();
      }
    });
  });
});
