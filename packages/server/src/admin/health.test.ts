import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';
import { gameTime } from '@tailfin/sim';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminGrant, player, world, worldEvent, type WorldRow } from '../db/schema';
import { type ServerEnv } from '../env';
import { scheduleEvent } from '../sim/event-queue';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from '../test-fixtures/authorization';
import { createWorld } from '../world/lifecycle';

import { BOOTSTRAP_ACTOR, grantAdmin } from './grants';
import { assessTick, BEHIND_AFTER_MS, buildWorldHealth } from './health';

/**
 * World health (M1A-06).
 *
 * The acceptance criteria:
 *
 *   - a stalled tick loop is visible within a minute
 *   - a growing backlog is visible as a trend, not only as a number
 *   - the page costs one request per refresh
 *   - a world with no players does not divide by zero
 *
 * The trend is the console's half and is tested in `health-ui.test.tsx`; the
 * rest is here. `assessTick` is pure and is tested without a database, because
 * the judgement is the part most worth pinning down.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [health.test] DATABASE_URL not set — skipping health tests.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 2,
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

const NOW = new Date('2026-08-19T12:00:00.000Z');

describe('assessTick', () => {
  it('calls an empty, never-used queue nothing scheduled rather than idle', () => {
    // A world that has never done anything must not read the same as one that is
    // up to date. "Idle" implies caught up; this one has never had work.
    const result = assessTick({ pending: 0, overdueRealMs: null, lastProcessedAt: null, now: NOW });
    expect(result.state).toBe('no_events');
    expect(result.detail).toMatch(/nothing has ever been scheduled/i);
  });

  it('calls a queue with nothing due idle, and says how much is waiting', () => {
    const result = assessTick({
      pending: 7,
      overdueRealMs: null,
      lastProcessedAt: new Date(NOW.getTime() - 5_000),
      now: NOW,
    });
    expect(result.state).toBe('idle');
    expect(result.detail).toContain('7');
  });

  it('calls work that is due and never processed stalled', () => {
    // The state this page exists for, and the one that is true today: nothing
    // starts the tick loop, so a world with due work has nothing handling it.
    const result = assessTick({
      pending: 3,
      overdueRealMs: 1_000,
      lastProcessedAt: null,
      now: NOW,
    });
    expect(result.state).toBe('stalled');
    expect(result.detail).toMatch(/no tick loop is running/i);
  });

  it('calls a loop that has stopped stalled, within a minute', () => {
    // The acceptance criterion, as arithmetic: due work plus nothing processed
    // for longer than the budget.
    const justOver = new Date(NOW.getTime() - BEHIND_AFTER_MS - 1_000);
    const result = assessTick({
      pending: 1,
      overdueRealMs: 90_000,
      lastProcessedAt: justOver,
      now: NOW,
    });
    expect(result.state).toBe('stalled');
    expect(BEHIND_AFTER_MS).toBeLessThanOrEqual(60_000);
  });

  it('calls a loop that is running but late behind, not stalled', () => {
    // Different problems, different answers: one needs restarting, the other
    // needs more capacity.
    const result = assessTick({
      pending: 40,
      overdueRealMs: 120_000,
      lastProcessedAt: new Date(NOW.getTime() - 2_000),
      now: NOW,
    });
    expect(result.state).toBe('behind');
    expect(result.detail).toMatch(/not keeping up/i);
  });

  it('calls a loop handling due work promptly keeping up', () => {
    const result = assessTick({
      pending: 5,
      overdueRealMs: 2_000,
      lastProcessedAt: new Date(NOW.getTime() - 1_000),
      now: NOW,
    });
    expect(result.state).toBe('keeping_up');
  });

  it('never divides by anything, so an empty world is just quiet', () => {
    // The fourth criterion. No ratios anywhere in the assessment — a world with
    // no players, no airlines and no events produces a sentence, not a NaN.
    for (const pending of [0, 1]) {
      const result = assessTick({ pending, overdueRealMs: null, lastProcessedAt: null, now: NOW });
      expect(result.detail).not.toContain('NaN');
      expect(result.detail).not.toContain('Infinity');
    }
  });
});

describeDb('world health over a database', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(worldEvent).where(eq(worldEvent.worldId, id));
      await db.db.delete(world).where(eq(world.id, id));
    }
    for (const id of madePlayers.splice(0)) {
      await db.db.delete(adminGrant).where(eq(adminGrant.playerId, id));
      await db.db.delete(player).where(eq(player.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeWorld(speed = 2): Promise<WorldRow> {
    const { world: created } = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `health-${Math.random().toString(36).slice(2, 10)}`,
      speedMultiplier: speed,
    });
    madeWorlds.push(created.id);
    return created;
  }

  async function healthOf(worldId: string, now = new Date()) {
    const report = await buildWorldHealth(db.db, now);
    const found = report.worlds.find((entry) => entry.worldId === worldId);
    if (!found) throw new Error('world missing from the health report');
    return found;
  }

  it('reports a brand-new world as quiet rather than broken', async () => {
    // The empty case, which is every world until M2 schedules anything.
    const row = await makeWorld();
    const health = await healthOf(row.id);

    expect(health.tick).toBe('no_events');
    expect(health.queue.pending).toBe(0);
    expect(health.queue.overdueRealMs).toBeNull();
    expect(health.airlines).toBe(0);
    expect(health.realAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('shows the in-game date and the speed the world is actually running at', async () => {
    const row = await makeWorld(4);
    const at = new Date(row.launchDate.getTime() + 60 * 60 * 1000);
    const health = await healthOf(row.id, at);

    expect(health.speedMultiplier).toBe(4);
    // One real hour at 4× is four game hours past the epoch.
    expect(Date.parse(health.inGameDate) - row.epoch.getTime()).toBe(4 * 60 * 60 * 1000);
    expect(health.realAgeMs).toBe(60 * 60 * 1000);
  });

  it('counts what is waiting and finds the oldest', async () => {
    const row = await makeWorld();
    const gameNow = gameTime(
      { epoch: row.epoch, launchDate: row.launchDate, speedMultiplier: 2 },
      new Date(),
    );
    const oldest = new Date(gameNow.getTime() + 60_000);

    for (const [i, offset] of [0, 120_000, 240_000].entries()) {
      await scheduleEvent(db.db, {
        worldId: row.id,
        type: 'FLIGHT_DEPART',
        fireAt: new Date(oldest.getTime() + offset),
        payload: {},
        idempotencyKey: `health:pending-${String(i)}`,
      });
    }

    const health = await healthOf(row.id);
    expect(health.queue.pending).toBe(3);
    expect(health.queue.oldestPendingAt).toBe(oldest.toISOString());
    // Nothing due yet, so nothing is late.
    expect(health.queue.overdueRealMs).toBeNull();
    expect(health.tick).toBe('idle');
  });

  it('measures lateness in real time, not game time', async () => {
    // A world at 4× is four times less forgiving of the same delay, and the
    // question this page answers is whether the loop keeps up with the wall
    // clock. Four game minutes late at 4× is one real minute late.
    const row = await makeWorld(4);
    const at = new Date(row.launchDate.getTime() + 60 * 60 * 1000);
    const gameNow = gameTime(
      { epoch: row.epoch, launchDate: row.launchDate, speedMultiplier: 4 },
      at,
    );

    await scheduleEvent(db.db, {
      worldId: row.id,
      type: 'FLIGHT_ARRIVE',
      fireAt: new Date(gameNow.getTime() - 4 * 60_000),
      payload: {},
      idempotencyKey: 'health:late',
    });

    const health = await healthOf(row.id, at);
    expect(health.queue.overdueRealMs).toBe(60_000);
  });

  it('reports a world with due work and no loop as stalled', async () => {
    // True of every world today: `createTickLoop` exists and nothing calls it.
    // The page saying so is the most useful thing it can currently do.
    const row = await makeWorld();
    const at = new Date(row.launchDate.getTime() + 60 * 60 * 1000);
    const gameNow = gameTime(
      { epoch: row.epoch, launchDate: row.launchDate, speedMultiplier: 2 },
      at,
    );

    await scheduleEvent(db.db, {
      worldId: row.id,
      type: 'FLIGHT_ARRIVE',
      fireAt: new Date(gameNow.getTime() - 10 * 60_000),
      payload: {},
      idempotencyKey: 'health:stalled',
    });

    const health = await healthOf(row.id, at);
    expect(health.tick).toBe('stalled');
    expect(health.queue.lastProcessedAt).toBeNull();
  });

  it('keeps each world out of the others figures', async () => {
    const quiet = await makeWorld();
    const busy = await makeWorld();
    const gameNow = gameTime(
      { epoch: busy.epoch, launchDate: busy.launchDate, speedMultiplier: 2 },
      new Date(),
    );

    for (const i of [1, 2, 3, 4]) {
      await scheduleEvent(db.db, {
        worldId: busy.id,
        type: 'FLIGHT_DEPART',
        fireAt: new Date(gameNow.getTime() + 600_000),
        payload: {},
        idempotencyKey: `health:busy-${String(i)}`,
      });
    }

    expect((await healthOf(busy.id)).queue.pending).toBe(4);
    expect((await healthOf(quiet.id)).queue.pending).toBe(0);
  });

  it('reports the datasets the worlds are built on', async () => {
    // Present in CI, which imports the dataset. Asserted as a shape rather than
    // a value so it does not depend on which import ran.
    const report = await buildWorldHealth(db.db);
    for (const entry of report.datasets) {
      expect(entry.dataset).toBeTruthy();
      expect(Number.isNaN(Date.parse(entry.importedAt))).toBe(false);
    }
    // No duplicates: one row per dataset, the newest import.
    const names = report.datasets.map((entry) => entry.dataset);
    expect(new Set(names).size).toBe(names.length);
  });

  describe('over HTTP', () => {
    let authorization: AuthorizationTestSuite;

    beforeAll(async () => {
      authorization = await createAuthorizationTestSuite({ db, env, suite: 'admin-health' });
    });

    afterAll(async () => {
      await authorization.cleanup();
    });

    async function cookieFor(playerId: string): Promise<string> {
      const { token } = await createSession(db.db, playerId, 1);
      return `${SESSION_COOKIE}=${token}`;
    }

    async function makeAdmin(): Promise<string> {
      const rows = await db.db
        .insert(player)
        .values({ displayName: `admin-${Math.random().toString(36).slice(2, 8)}` })
        .returning({ id: player.id });
      const id = rows[0]?.id;
      if (!id) throw new Error('no player created');
      madePlayers.push(id);
      await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);
      return id;
    }

    it('enforces the canonical actor matrix on world health', async () => {
      await authorization.expectAuthorization({
        request: { method: 'GET', url: '/api/admin/worlds/health' },
        guest: 401,
        playerA: 403,
        playerB: 403,
        admin: 200,
      });
    });

    it('answers every statistic in one request', async () => {
      // The third acceptance criterion. One call returns every world, the queue
      // figures and the dataset versions — a page that costs a request per
      // statistic is a page that cannot refresh on a timer.
      const actor = await makeAdmin();
      await makeWorld();
      const app = await buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'GET',
          url: '/api/admin/worlds/health',
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(200);
        const body = reply.json<{
          worlds: { queue: unknown; tick: string; inGameDate: string }[];
          datasets: unknown[];
          serverTime: string;
          behindAfterMs: number;
        }>();

        expect(body.worlds.length).toBeGreaterThan(0);
        expect(body.worlds[0]?.queue).toBeDefined();
        expect(body.worlds[0]?.tick).toBeTruthy();
        expect(Array.isArray(body.datasets)).toBe(true);
        // The anchor the console ticks its local clock from.
        expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
        expect(body.behindAfterMs).toBe(BEHIND_AFTER_MS);
      } finally {
        await app.close();
      }
    });

    it('is not confused by a world called anything, because health is not an id', async () => {
      // `/worlds/health` sits beside `/worlds/:worldId/speed`. Asserted rather
      // than assumed, because a router that resolved this the other way would
      // fail in a way nobody would guess from the symptom.
      const actor = await makeAdmin();
      const app = await buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'GET',
          url: '/api/admin/worlds/health',
          headers: { cookie: await cookieFor(actor) },
        });
        expect(reply.statusCode).toBe(200);
        expect(reply.json<{ worlds: unknown[] }>().worlds).toBeDefined();
      } finally {
        await app.close();
      }
    });
  });
});
