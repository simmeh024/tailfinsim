import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG, type WorldConfig } from '@tailfin/shared';
import { gameTime, realTimeAtGameTime, type WorldClock } from '@tailfin/sim';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminGrant, player, world, worldEvent, type WorldRow } from '../db/schema';
import { type ServerEnv } from '../env';
import { drainDueEvents, scheduleEvent } from '../sim/event-queue';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from '../test-fixtures/authorization';
import { createWorld } from '../world/lifecycle';

import { readAudit } from './audit';
import { BOOTSTRAP_ACTOR, grantAdmin } from './grants';
import { changeWorldSpeed, validateSpeedRequest } from './speed';
import { listWorlds } from './worlds';

/**
 * Changing a running world's speed (M1A-03).
 *
 * The acceptance criteria, each with a test that fails if it stops being true:
 *
 *   - the in-game date is unchanged at the instant of the change
 *   - events scheduled beforehand still fire at the same in-game moment
 *   - the change is audited, with before and after
 *
 * The fourth — that the confirmation says what will happen — belongs to the
 * console and is tested in `worlds-ui.test.tsx`, because it is a claim about
 * what an admin is shown before agreeing.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [speed.test] DATABASE_URL not set — skipping speed tests.\n');
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

describe('validateSpeedRequest', () => {
  const good = { speedMultiplier: 3, expectedSpeedMultiplier: 2 };

  it('accepts a plain change', () => {
    expect(validateSpeedRequest(good).ok).toBe(true);
  });

  it('refuses a speed that would freeze or reverse the world', () => {
    for (const speedMultiplier of [0, -1, -0.5]) {
      expect(validateSpeedRequest({ ...good, speedMultiplier }).ok).toBe(false);
    }
  });

  it('refuses a speed the column cannot hold', () => {
    // `numeric(4,2)` stops at 99.99. Above it Postgres raises a numeric overflow,
    // which is not a constraint violation and so has no translated message — it
    // would reach an admin as a 500.
    expect(validateSpeedRequest({ ...good, speedMultiplier: 100 }).ok).toBe(false);
    expect(validateSpeedRequest({ ...good, speedMultiplier: 99.99 }).ok).toBe(true);
  });

  it('refuses more precision than it can keep, rather than rounding it away', () => {
    // An admin who types 3.333 and is told "done" would be looking at a world
    // running at 3.33 — a speed nobody chose.
    const result = validateSpeedRequest({ ...good, speedMultiplier: 3.333 });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.fields.speedMultiplier?.[0]).toMatch(/decimal places/);
    expect(result.fields.speedMultiplier?.[0]).toContain('3.33');
  });

  it('requires the caller to say what speed it thinks the world is running at', () => {
    // Without it the confirmation an admin read cannot be checked against the
    // world it is about to change.
    expect(validateSpeedRequest({ speedMultiplier: 3 }).ok).toBe(false);
  });

  it('refuses nonsense rather than throwing on it', () => {
    for (const input of [null, 'faster', 42, [], {}, { speedMultiplier: 'two' }]) {
      expect(validateSpeedRequest(input).ok).toBe(false);
    }
  });
});

describeDb('changing a world speed', () => {
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

  /**
   * A world that has been running for thirty days, and the instant to judge it at.
   *
   * Backdating `launch_date` rather than waiting is the point: a world created a
   * moment ago has almost no elapsed real time for a speed change to misapply, so
   * these tests would pass even with the re-anchoring removed entirely.
   *
   * The pair of instants is fixed rather than derived from `Date.now()` so the
   * arithmetic is exact. Thirty days at 2× is 5,184,000,000 game milliseconds,
   * which divides cleanly by every speed used below — so the tests can assert
   * *equality* on the in-game date instead of a tolerance that would quietly
   * accept a real fault. The residue is real and has its own test; it should not
   * be smeared across all of them.
   */
  const LAUNCHED_AT = new Date('2026-07-19T00:00:00.000Z');
  const THIRTY_DAYS_ON = new Date('2026-08-18T00:00:00.000Z');

  async function runningWorld(speed = 2): Promise<WorldRow> {
    const config: WorldConfig = {
      ...FLAGSHIP_CONFIG,
      name: `speed-${Math.random().toString(36).slice(2, 10)}`,
      speedMultiplier: speed,
    };
    const { world: created } = await createWorld(db.db, config);
    madeWorlds.push(created.id);

    const rows = await db.db
      .update(world)
      .set({ launchDate: LAUNCHED_AT })
      .where(eq(world.id, created.id))
      .returning();
    return rows[0]!;
  }

  function clockOf(row: WorldRow): WorldClock {
    return {
      epoch: row.epoch,
      launchDate: row.launchDate,
      speedMultiplier: Number(row.speedMultiplier),
    };
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

  async function change(worldId: string, to: number, from: number, at = THIRTY_DAYS_ON) {
    return changeWorldSpeed(
      db.db,
      worldId,
      { speedMultiplier: to, expectedSpeedMultiplier: from },
      { playerId: null, label: 'test' },
      at,
    );
  }

  it('leaves the in-game date where it was', async () => {
    // The first acceptance criterion, measured across the change rather than
    // asserted from the formula.
    const row = await runningWorld();
    const at = THIRTY_DAYS_ON;
    const expected = gameTime(clockOf(row), at);

    const result = await change(row.id, 3, 2, at);
    if (!result.ok) throw new Error(`refused: ${result.message}`);

    expect(Date.parse(result.after.inGameDate)).toBe(expected.getTime());
    expect(result.before.inGameDate).toBe(result.after.inGameDate);
    expect(result.driftMs).toBe(0);
  });

  it('would have jumped the calendar by a month without the re-anchoring', async () => {
    // States the size of the bug being prevented. Thirty real days at 2× is
    // sixty game days; writing 3 alone would make it ninety.
    const row = await runningWorld();
    const at = THIRTY_DAYS_ON;
    const naive = gameTime({ ...clockOf(row), speedMultiplier: 3 }, at);
    const actual = gameTime(clockOf(row), at);

    expect(naive.getTime() - actual.getTime()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);

    const result = await change(row.id, 3, 2, at);
    if (!result.ok) throw new Error('refused');
    expect(Date.parse(result.after.inGameDate)).toBe(actual.getTime());
  });

  it('moves launch_date, never the epoch', async () => {
    const row = await runningWorld();
    const result = await change(row.id, 4, 2);
    if (!result.ok) throw new Error('refused');

    expect(result.world.epoch.getTime()).toBe(row.epoch.getTime());
    expect(result.world.launchDate.getTime()).not.toBe(row.launchDate.getTime());
    expect(Number(result.world.speedMultiplier)).toBe(4);
  });

  it('runs at the new speed from then on', async () => {
    const row = await runningWorld();
    const at = THIRTY_DAYS_ON;
    const result = await change(row.id, 6, 2, at);
    if (!result.ok) throw new Error('refused');

    const anHourLater = new Date(at.getTime() + 60 * 60 * 1000);
    const advanced =
      gameTime(clockOf(result.world), anHourLater).getTime() -
      gameTime(clockOf(result.world), at).getTime();
    expect(advanced).toBe(6 * 60 * 60 * 1000);
  });

  it('leaves a scheduled event on the same in-game moment, reached sooner', async () => {
    // The second acceptance criterion. `fire_at` is a game-time instant, so the
    // row is not rewritten at all — proven by reading it back byte for byte —
    // and what moves is the real instant it becomes due.
    const row = await runningWorld();
    const at = THIRTY_DAYS_ON;
    const fireAt = new Date(gameTime(clockOf(row), at).getTime() + 6 * 60 * 60 * 1000);

    await scheduleEvent(db.db, {
      worldId: row.id,
      type: 'FLIGHT_ARRIVE',
      fireAt,
      payload: { flightId: 'test' },
      idempotencyKey: 'speed-test:arrive',
    });

    const realBefore = realTimeAtGameTime(clockOf(row), fireAt);
    const result = await change(row.id, 4, 2, at);
    if (!result.ok) throw new Error('refused');

    const stored = await db.db.select().from(worldEvent).where(eq(worldEvent.worldId, row.id));
    expect(stored[0]?.fireAt.getTime()).toBe(fireAt.getTime());

    // Six game hours: three real hours at 2×, ninety real minutes at 4×.
    const realAfter = realTimeAtGameTime(clockOf(result.world), fireAt);
    expect(realBefore.getTime() - at.getTime()).toBe(3 * 60 * 60 * 1000);
    expect(realAfter.getTime() - at.getTime()).toBe(90 * 60 * 1000);
    expect(result.pendingEvents).toBe(1);
  });

  it('does not let a speed change fire an event that was not due', async () => {
    // The failure mode worth guarding: an admin speeds the world up and a flight
    // that should still be in the air lands instantly because the calendar
    // lurched past it. Tested against the real drain, not against arithmetic.
    const row = await runningWorld();
    const at = THIRTY_DAYS_ON;
    const handled: string[] = [];

    await scheduleEvent(db.db, {
      worldId: row.id,
      type: 'FLIGHT_ARRIVE',
      // One in-game minute away: close enough that any forward lurch catches it.
      fireAt: new Date(gameTime(clockOf(row), at).getTime() + 60_000),
      payload: { flightId: 'not-yet' },
      idempotencyKey: 'speed-test:not-yet',
    });

    const result = await change(row.id, 50, 2, at);
    if (!result.ok) throw new Error('refused');

    const drained = await drainDueEvents(db.db, row.id, clockOf(result.world), at, {
      FLIGHT_ARRIVE: async (event) => {
        handled.push(event.idempotencyKey);
        return Promise.resolve();
      },
    });

    expect(drained.processed).toBe(0);
    expect(handled).toEqual([]);
  });

  it('is audited, with the in-game date on both sides', async () => {
    // The third criterion. The entry has to carry its own evidence: months later
    // nobody will recompute a calendar from a launch date to check that the
    // change was clean.
    const actor = await makeAdmin();
    const row = await runningWorld();

    const result = await changeWorldSpeed(
      db.db,
      row.id,
      { speedMultiplier: 5, expectedSpeedMultiplier: 2 },
      { playerId: actor, label: 'Test Admin' },
      // The fixed instant, so the division lands on a whole millisecond and the
      // two in-game dates below are *equal* rather than close. Left to the wall
      // clock this asserted equality and failed in CI on a 2ms residue — which
      // is the documented behaviour, not a fault, and belongs in the test that
      // measures the bound rather than in this one.
      THIRTY_DAYS_ON,
    );
    if (!result.ok) throw new Error('refused');

    const entries = (await readAudit(db.db, { limit: 500 })).filter(
      (entry) => entry.subjectId === row.id,
    );
    const changed = entries.find((entry) => entry.action === 'world.speed_changed');
    expect(changed).toBeDefined();
    expect(changed?.actorPlayerId).toBe(actor);

    const before = JSON.parse(changed?.before ?? '{}') as Record<string, unknown>;
    const after = JSON.parse(changed?.after ?? '{}') as Record<string, unknown>;
    expect(before.speedMultiplier).toBe(2);
    expect(after.speedMultiplier).toBe(5);
    expect(before.inGameDate).toBe(after.inGameDate);
    expect(after.launchDate).not.toBe(before.launchDate);
  });

  it('writes nothing at all when the audit write fails', async () => {
    // The two share a transaction, as every M1A action does. Proven by killing
    // the transaction after the change and finding the world untouched.
    const row = await runningWorld();
    await expect(
      db.db.transaction(async (tx) => {
        await changeWorldSpeed(
          tx,
          row.id,
          { speedMultiplier: 9, expectedSpeedMultiplier: 2 },
          { playerId: null, label: 'test' },
        );
        throw new Error('the audit failed');
      }),
    ).rejects.toThrow('the audit failed');

    const after = await db.db.select().from(world).where(eq(world.id, row.id));
    expect(Number(after[0]?.speedMultiplier)).toBe(2);
    expect(after[0]?.launchDate.getTime()).toBe(row.launchDate.getTime());
  });

  it('refuses when somebody else changed the speed first', async () => {
    // The confirmation named a speed; if that is not the speed any more, the
    // sentence the admin agreed to is not the one that would be carried out.
    const row = await runningWorld();
    const first = await change(row.id, 3, 2);
    expect(first.ok).toBe(true);

    const second = await change(row.id, 4, 2);
    if (second.ok) throw new Error('expected a refusal');
    expect(second.code).toBe('speed_stale');
    expect(second.fields.form?.[0]).toContain('3.00×');
    expect(second.fields.form?.[0]).toMatch(/somebody else/i);
  });

  it('refuses the speed it is already running at, and records nothing', async () => {
    const row = await runningWorld();
    const result = await change(row.id, 2, 2);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.code).toBe('speed_unchanged');

    const entries = (await readAudit(db.db, { limit: 500 })).filter(
      (entry) => entry.subjectId === row.id,
    );
    expect(entries.filter((entry) => entry.action === 'world.speed_changed')).toHaveLength(0);
  });

  it('refuses an archived world', async () => {
    const row = await runningWorld();
    await db.db.update(world).set({ status: 'archived' }).where(eq(world.id, row.id));

    const result = await change(row.id, 3, 2);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.code).toBe('world_archived');
  });

  it('refuses a world that is not there', async () => {
    const result = await change('11111111-2222-3333-4444-555555555555', 3, 2);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.code).toBe('world_not_found');
  });

  it('counts what is waiting, so the list can say so before anyone confirms', async () => {
    const row = await runningWorld();
    const future = new Date(gameTime(clockOf(row), new Date()).getTime() + 3_600_000);
    for (const n of [1, 2, 3]) {
      await scheduleEvent(db.db, {
        worldId: row.id,
        type: 'FLIGHT_DEPART',
        fireAt: future,
        payload: {},
        idempotencyKey: `speed-test:pending-${String(n)}`,
      });
    }

    const listed = (await listWorlds(db.db)).find((entry) => entry.id === row.id);
    expect(listed?.pendingEvents).toBe(3);
  });

  describe('over HTTP', () => {
    let authorization: AuthorizationTestSuite;

    beforeAll(async () => {
      authorization = await createAuthorizationTestSuite({ db, env, suite: 'admin-speed' });
    });

    afterAll(async () => {
      await authorization.cleanup();
    });

    async function cookieFor(playerId: string): Promise<string> {
      const { token } = await createSession(db.db, playerId, 1);
      return `${SESSION_COOKIE}=${token}`;
    }

    it('enforces the canonical actor matrix before changing world speed', async () => {
      const row = await runningWorld();
      await authorization.expectAuthorization({
        request: { method: 'POST', url: `/api/admin/worlds/${row.id}/speed`, payload: {} },
        guest: 401,
        playerA: 403,
        playerB: 403,
        admin: 400,
      });

      // Invalid admin input reaches validation but no actor changes the world.
      const after = await db.db.select().from(world).where(eq(world.id, row.id));
      expect(Number(after[0]?.speedMultiplier)).toBe(2);
    });

    it('changes the speed and answers with both sides of the clock', async () => {
      const actor = await makeAdmin();
      const row = await runningWorld();
      const app = await buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: `/api/admin/worlds/${row.id}/speed`,
          payload: { speedMultiplier: 3, expectedSpeedMultiplier: 2 },
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(200);
        const body = reply.json<{
          world: { speedMultiplier: number; pendingEvents: number };
          before: { speedMultiplier: number; inGameDate: string };
          after: { speedMultiplier: number; inGameDate: string };
          driftMs: number;
        }>();

        expect(body.world.speedMultiplier).toBe(3);
        expect(body.before.speedMultiplier).toBe(2);

        // Over HTTP the change happens at whatever instant the request arrives,
        // so the division does not land on a whole millisecond and the residue
        // is real. This is the bound `reanchorForSpeed` documents, asserted
        // under production conditions: never forwards, and under `speed + 1`
        // milliseconds behind.
        expect(body.driftMs).toBeLessThanOrEqual(0);
        expect(body.driftMs).toBeGreaterThan(-4);
      } finally {
        await app.close();
      }
    });

    it('maps each refusal to the status it deserves', async () => {
      const actor = await makeAdmin();
      const row = await runningWorld();
      const app = await buildApp({ env, db });
      try {
        const cookie = await cookieFor(actor);
        async function statusOf(worldId: string, to: number, from: number): Promise<number> {
          const reply = await app.inject({
            method: 'POST',
            url: `/api/admin/worlds/${worldId}/speed`,
            payload: { speedMultiplier: to, expectedSpeedMultiplier: from },
            headers: { cookie },
          });
          return reply.statusCode;
        }

        const missing = '11111111-2222-3333-4444-555555555555';

        // A bad value, and a value that is not a change, are both the request's
        // fault: the thing to alter is what was submitted.
        expect(await statusOf(row.id, 0, 2)).toBe(400);
        expect(await statusOf(row.id, 2, 2)).toBe(400);

        // A world that is not there — including an id that is not a uuid, which
        // would otherwise reach Postgres and come back as a 500.
        expect(await statusOf(missing, 3, 2)).toBe(404);
        expect(await statusOf('not-a-uuid', 3, 2)).toBe(404);

        // A conflict with the world's state rather than with the request: the
        // same message a minute earlier would have worked.
        expect(await statusOf(row.id, 3, 9)).toBe(409);
      } finally {
        await app.close();
      }
    });

    it('says why, in words, against the field that was wrong', async () => {
      const actor = await makeAdmin();
      const row = await runningWorld();
      const app = await buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: `/api/admin/worlds/${row.id}/speed`,
          payload: { speedMultiplier: 3.333, expectedSpeedMultiplier: 2 },
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(400);
        const body = reply.json<{ fields: Record<string, string[]> }>();
        expect(body.fields.speedMultiplier?.[0]).toMatch(/decimal places/);
        // Never a column type or a constraint name.
        expect(JSON.stringify(body)).not.toMatch(/numeric|constraint/i);
      } finally {
        await app.close();
      }
    });
  });
});
