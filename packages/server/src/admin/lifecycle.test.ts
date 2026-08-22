import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG, type WorldConfig, type WorldStatus } from '@tailfin/shared';
import { gameTime } from '@tailfin/sim';

import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminGrant, airline, player, world, worldEvent, type WorldRow } from '../db/schema';
import { type ServerEnv } from '../env';
import { drainDueEvents, scheduleEvent } from '../sim/event-queue';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { createWorld } from '../world/lifecycle';

import { readAudit } from './audit';
import { BOOTSTRAP_ACTOR, grantAdmin } from './grants';
import { changeWorldStatus, resetWorldAsAdmin, validateResetRequest } from './lifecycle';
import { listWorlds } from './worlds';

/**
 * A world's lifecycle (M1A-04).
 *
 * The four acceptance criteria, each with a test that fails if it stops being
 * true:
 *
 *   - after a reset, `gameTime(world, now)` equals the epoch
 *   - pending events from before the reset cannot fire against the new timeline
 *   - an open world cannot be reset without an explicit confirmation naming it
 *   - every transition is audited, with before and after
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [lifecycle.test] DATABASE_URL not set — skipping lifecycle tests.\n');
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

describe('validateResetRequest', () => {
  const good = { confirmName: 'Flagship', reason: 'go-live rehearsal', expectedStatus: 'open' };

  it('accepts a complete request', () => {
    expect(validateResetRequest(good).ok).toBe(true);
  });

  it('refuses a reset with no reason, and says what the reason is for', () => {
    // ADR-0005 asks for a mandatory reason in the log. The entry that matters is
    // the one read months later by somebody asking why a world went to zero.
    for (const reason of ['', '   ', 'x']) {
      const result = validateResetRequest({ ...good, reason });
      if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(reason)}`);
      expect(result.fields.reason?.[0]).toMatch(/audit log/i);
    }
  });

  it('refuses a request with no name typed', () => {
    expect(validateResetRequest({ ...good, confirmName: '' }).ok).toBe(false);
  });

  it('refuses nonsense rather than throwing on it', () => {
    for (const input of [null, 'reset it', 42, [], {}]) {
      expect(validateResetRequest(input).ok).toBe(false);
    }
  });
});

describeDb('the world lifecycle', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(worldEvent).where(eq(worldEvent.worldId, id));
      await db.db.delete(airline).where(eq(airline.worldId, id));
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

  const ACTOR = { playerId: null, label: 'test' };

  async function makeWorld(status: WorldStatus = 'staging'): Promise<WorldRow> {
    const config: WorldConfig = {
      ...FLAGSHIP_CONFIG,
      name: `life-${Math.random().toString(36).slice(2, 10)}`,
    };
    const { world: created } = await createWorld(db.db, config);
    madeWorlds.push(created.id);

    // Backdated, so the clock has somewhere to rewind *from*. A world created a
    // moment ago is already at its epoch, and a reset that did nothing at all
    // would pass every assertion below.
    const rows = await db.db
      .update(world)
      .set({ status, launchDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
      .where(eq(world.id, created.id))
      .returning();
    return rows[0]!;
  }

  async function makePlayer(): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `player-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    return id;
  }

  async function makeAdmin(): Promise<string> {
    const id = await makePlayer();
    await grantAdmin(db.db, id, BOOTSTRAP_ACTOR);
    return id;
  }

  /**
   * An airline in the world, which is the thing a reset destroys.
   *
   * The codes have to satisfy the schema's format checks — `^[A-Z0-9]{2}$`,
   * `^[A-Z]{3}$`, `^[A-Z]{2}$` — so they are built rather than improvised.
   */
  async function makeAirline(worldId: string, suffix: string): Promise<string> {
    const code = suffix.slice(0, 2).toUpperCase();
    const created = await fixtures.create({
      worldId,
      name: `Test Air ${suffix}`,
      iataCode: code,
      icaoCode: `T${code}`,
      callsign: `TEST${code}`,
      baseCountry: 'GB',
    });
    // The owner, so a test can assert about that player rather than counting a
    // table other test files are inserting into at the same time.
    return created.player.id;
  }

  async function auditFor(worldId: string) {
    return (await readAudit(db.db, { limit: 500 })).filter((entry) => entry.subjectId === worldId);
  }

  describe('transitions', () => {
    it('opens a staging world, and records it', async () => {
      const row = await makeWorld('staging');
      const result = await changeWorldStatus(
        db.db,
        row.id,
        { status: 'open', expectedStatus: 'staging' },
        ACTOR,
      );

      if (!result.ok) throw new Error(`refused: ${result.message}`);
      expect(result.world.status).toBe('open');

      const entry = (await auditFor(row.id)).find((e) => e.action === 'world.opened');
      expect(entry).toBeDefined();
      expect(entry?.before).toContain('staging');
      expect(entry?.after).toContain('open');
    });

    it('walks the whole path a world actually takes', async () => {
      // staging → open → locked → open → locked → archived, each step legal, and
      // the verbs in the log distinct enough to read afterwards.
      const row = await makeWorld('staging');
      const steps: [WorldStatus, WorldStatus][] = [
        ['staging', 'open'],
        ['open', 'locked'],
        ['locked', 'open'],
        ['open', 'locked'],
        ['locked', 'archived'],
      ];

      for (const [from, to] of steps) {
        const result = await changeWorldStatus(
          db.db,
          row.id,
          { status: to, expectedStatus: from },
          ACTOR,
        );
        if (!result.ok) throw new Error(`${from} → ${to} refused: ${result.message}`);
        expect(result.world.status).toBe(to);
      }

      const actions = (await auditFor(row.id)).map((entry) => entry.action);
      expect(actions).toContain('world.opened');
      expect(actions).toContain('world.locked');
      expect(actions).toContain('world.unlocked');
      expect(actions).toContain('world.archived');
    });

    it('refuses to archive an open world in one step', async () => {
      // The decision: archiving is permanent, so doing it to a world with players
      // in it takes two deliberate acts. The refusal teaches the path.
      const row = await makeWorld('open');
      const result = await changeWorldStatus(
        db.db,
        row.id,
        { status: 'archived', expectedStatus: 'open' },
        ACTOR,
      );

      if (result.ok) throw new Error('expected a refusal');
      expect(result.code).toBe('illegal_transition');
      expect(result.fields.form?.[0]).toContain('locked');

      const after = await db.db.select().from(world).where(eq(world.id, row.id));
      expect(after[0]?.status).toBe('open');
    });

    it('will not move an archived world at all', async () => {
      const row = await makeWorld('archived');
      for (const status of ['open', 'locked', 'staging'] as WorldStatus[]) {
        const result = await changeWorldStatus(
          db.db,
          row.id,
          { status, expectedStatus: 'archived' },
          ACTOR,
        );
        if (result.ok) throw new Error(`archived → ${status} should have been refused`);
        expect(result.code).toBe('illegal_transition');
      }
    });

    it('refuses when somebody else moved the world first', async () => {
      const row = await makeWorld('staging');
      await changeWorldStatus(db.db, row.id, { status: 'open', expectedStatus: 'staging' }, ACTOR);

      const second = await changeWorldStatus(
        db.db,
        row.id,
        { status: 'archived', expectedStatus: 'staging' },
        ACTOR,
      );
      if (second.ok) throw new Error('expected a refusal');
      expect(second.code).toBe('status_stale');
      expect(second.fields.form?.[0]).toMatch(/is open, not staging/);
    });

    it('records nothing when a transition is refused', async () => {
      const row = await makeWorld('open');
      await changeWorldStatus(db.db, row.id, { status: 'archived', expectedStatus: 'open' }, ACTOR);
      expect(await auditFor(row.id)).toHaveLength(0);
    });
  });

  describe('reset', () => {
    const RESET = {
      confirmName: '',
      reason: 'go-live rehearsal',
      expectedStatus: 'staging' as const,
    };

    it('returns the in-game date to the epoch', async () => {
      // The first acceptance criterion, measured from the row that was written
      // rather than from the arithmetic that wrote it.
      const row = await makeWorld('staging');
      const before = gameTime(
        {
          epoch: row.epoch,
          launchDate: row.launchDate,
          speedMultiplier: Number(row.speedMultiplier),
        },
        new Date(),
      );
      // Sixty game days in, so returning to the epoch is a real journey.
      expect(before.getTime() - row.epoch.getTime()).toBeGreaterThan(59 * 24 * 60 * 60 * 1000);

      const result = await resetWorldAsAdmin(
        db.db,
        row.id,
        { ...RESET, confirmName: row.name },
        ACTOR,
      );
      if (!result.ok) throw new Error(`refused: ${result.message}`);

      expect(result.inGameDate.getTime()).toBe(row.epoch.getTime());
      expect(result.world.status).toBe('staging');
    });

    it('destroys the airlines, and says how many', async () => {
      const row = await makeWorld('open');
      await makeAirline(row.id, 'aa');
      await makeAirline(row.id, 'bb');

      const result = await resetWorldAsAdmin(
        db.db,
        row.id,
        { confirmName: row.name, reason: 'clearing the test world', expectedStatus: 'open' },
        ACTOR,
      );
      if (!result.ok) throw new Error(`refused: ${result.message}`);

      expect(result.destroyed.airlines).toBe(2);
      const left = await db.db.select().from(airline).where(eq(airline.worldId, row.id));
      expect(left).toHaveLength(0);
    });

    it('leaves the player behind a destroyed airline alone', async () => {
      // An airline is a player's presence in one world, not the account. §22.10's
      // anonymise-not-delete rule is about erasing a person; this is wiping a
      // world, and signing in afterwards should work and simply find no airline.
      //
      // Asserted about *this* player rather than by counting the table. CI runs
      // test files in parallel against one database, so a global count is not a
      // fact about this test — it failed on a player another file inserted
      // between the two snapshots.
      const row = await makeWorld('open');
      const ownerId = await makeAirline(row.id, 'cc');

      const result = await resetWorldAsAdmin(
        db.db,
        row.id,
        { confirmName: row.name, reason: 'wiping the world', expectedStatus: 'open' },
        ACTOR,
      );
      if (!result.ok) throw new Error(`refused: ${result.message}`);
      expect(result.destroyed.airlines).toBe(1);

      const survivors = await db.db.select().from(player).where(eq(player.id, ownerId));
      expect(survivors).toHaveLength(1);
      // And their airline really is gone, so this is not passing because nothing
      // happened.
      const airlines = await db.db.select().from(airline).where(eq(airline.playerId, ownerId));
      expect(airlines).toHaveLength(0);
    });

    it('stops pending events from firing against the new timeline', async () => {
      // The second acceptance criterion, tested against the real drain rather
      // than by inspecting rows. An event scheduled for a game-time instant that
      // the old clock had already passed would fire immediately; after the reset
      // it must not exist at all.
      const row = await makeWorld('staging');
      const handled: string[] = [];
      const oldTimelineInstant = new Date(row.epoch.getTime() + 30 * 24 * 60 * 60 * 1000);

      await scheduleEvent(db.db, {
        worldId: row.id,
        type: 'FLIGHT_ARRIVE',
        fireAt: oldTimelineInstant,
        payload: { flightId: 'ghost' },
        idempotencyKey: 'lifecycle-test:ghost',
      });

      const result = await resetWorldAsAdmin(
        db.db,
        row.id,
        { ...RESET, confirmName: row.name },
        ACTOR,
      );
      if (!result.ok) throw new Error(`refused: ${result.message}`);
      expect(result.destroyed.events).toBe(1);

      const remaining = await db.db.select().from(worldEvent).where(eq(worldEvent.worldId, row.id));
      expect(remaining).toHaveLength(0);

      // And nothing fires, now or when the new timeline reaches that date again.
      const clock = {
        epoch: result.world.epoch,
        launchDate: result.world.launchDate,
        speedMultiplier: Number(result.world.speedMultiplier),
      };
      const drained = await drainDueEvents(db.db, row.id, clock, new Date(), {
        FLIGHT_ARRIVE: (event) => {
          handled.push(event.idempotencyKey);
          return Promise.resolve();
        },
      });
      expect(drained.processed).toBe(0);
      expect(handled).toEqual([]);
    });

    it('refuses unless the world is named exactly', async () => {
      // The third acceptance criterion. Checked against the locked row, not
      // against whatever the console was showing.
      const row = await makeWorld('open');
      for (const confirmName of [row.name.toUpperCase(), `${row.name}x`, 'Flagship', '']) {
        const result = await resetWorldAsAdmin(
          db.db,
          row.id,
          { confirmName, reason: 'trying it on', expectedStatus: 'open' },
          ACTOR,
        );
        if (result.ok) throw new Error(`"${confirmName}" should not have been accepted`);
        expect(['name_mismatch', 'invalid_request']).toContain(result.code);
      }

      // Nothing happened to the world on any of those attempts.
      const after = await db.db.select().from(world).where(eq(world.id, row.id));
      expect(after[0]?.launchDate.getTime()).toBe(row.launchDate.getTime());
      expect(await auditFor(row.id)).toHaveLength(0);
    });

    it('refuses a world that was opened while the confirmation was on screen', async () => {
      const row = await makeWorld('staging');
      await changeWorldStatus(db.db, row.id, { status: 'open', expectedStatus: 'staging' }, ACTOR);

      const result = await resetWorldAsAdmin(
        db.db,
        row.id,
        { confirmName: row.name, reason: 'stale confirmation', expectedStatus: 'staging' },
        ACTOR,
      );
      if (result.ok) throw new Error('expected a refusal');
      expect(result.code).toBe('status_stale');
    });

    it('refuses an archived world, whose history is the point of it', async () => {
      const row = await makeWorld('archived');
      const result = await resetWorldAsAdmin(
        db.db,
        row.id,
        { confirmName: row.name, reason: 'should not work', expectedStatus: 'archived' },
        ACTOR,
      );
      if (result.ok) throw new Error('expected a refusal');
      expect(result.code).toBe('world_archived');
    });

    it('is audited with the reason, and both sides of the clock', async () => {
      // The fourth criterion. The reason is the part that cannot be
      // reconstructed from anything else later.
      const actor = await makeAdmin();
      const row = await makeWorld('open');
      await makeAirline(row.id, 'dd');

      const result = await resetWorldAsAdmin(
        db.db,
        row.id,
        {
          confirmName: row.name,
          reason: '  rehearsing the go-live reset  ',
          expectedStatus: 'open',
        },
        { playerId: actor, label: 'Test Admin' },
      );
      if (!result.ok) throw new Error(`refused: ${result.message}`);

      const entry = (await auditFor(row.id)).find((e) => e.action === 'world.reset');
      expect(entry).toBeDefined();
      expect(entry?.actorPlayerId).toBe(actor);

      const before = JSON.parse(entry?.before ?? '{}') as Record<string, unknown>;
      const after = JSON.parse(entry?.after ?? '{}') as Record<string, unknown>;
      expect(before.airlines).toBe(1);
      expect(before.status).toBe('open');
      expect(after.status).toBe('staging');
      expect(after.reason).toBe('rehearsing the go-live reset');
      expect(after.inGameDate).toBe(row.epoch.toISOString());
      expect(before.inGameDate).not.toBe(after.inGameDate);
    });

    it('destroys nothing when the audit write fails', async () => {
      // One transaction, as every M1A action is. Proven by killing it afterwards
      // and finding the airlines still there.
      const row = await makeWorld('open');
      await makeAirline(row.id, 'ee');

      await expect(
        db.db.transaction(async (tx) => {
          await resetWorldAsAdmin(
            tx,
            row.id,
            { confirmName: row.name, reason: 'this will roll back', expectedStatus: 'open' },
            ACTOR,
          );
          throw new Error('the audit failed');
        }),
      ).rejects.toThrow('the audit failed');

      const left = await db.db.select().from(airline).where(eq(airline.worldId, row.id));
      expect(left).toHaveLength(1);
      const after = await db.db.select().from(world).where(eq(world.id, row.id));
      expect(after[0]?.launchDate.getTime()).toBe(row.launchDate.getTime());
    });

    it('counts what is there, so the console can say so first', async () => {
      const row = await makeWorld('open');
      await makeAirline(row.id, 'ff');
      await makeAirline(row.id, 'gg');
      await scheduleEvent(db.db, {
        worldId: row.id,
        type: 'FLIGHT_DEPART',
        fireAt: new Date(row.epoch.getTime() + 90 * 24 * 60 * 60 * 1000),
        payload: {},
        idempotencyKey: 'lifecycle-test:counted',
      });

      const listed = (await listWorlds(db.db)).find((entry) => entry.id === row.id);
      expect(listed?.airlines).toBe(2);
      expect(listed?.pendingEvents).toBe(1);
    });
  });

  describe('over HTTP', () => {
    async function cookieFor(playerId: string): Promise<string> {
      const { token } = await createSession(db.db, playerId, 1);
      return `${SESSION_COOKIE}=${token}`;
    }

    it('refuses an anonymous request with 401 and a signed-in player with 403', async () => {
      const row = await makeWorld('staging');
      const ordinaryId = await makePlayer();

      const app = buildApp({ env, db });
      try {
        for (const path of ['status', 'reset']) {
          const payload =
            path === 'status'
              ? { status: 'open', expectedStatus: 'staging' }
              : { confirmName: row.name, reason: 'should not work', expectedStatus: 'staging' };

          const anon = await app.inject({
            method: 'POST',
            url: `/api/admin/worlds/${row.id}/${path}`,
            payload,
          });
          expect(anon.statusCode).toBe(401);

          const asPlayer = await app.inject({
            method: 'POST',
            url: `/api/admin/worlds/${row.id}/${path}`,
            payload,
            headers: { cookie: await cookieFor(ordinaryId) },
          });
          expect(asPlayer.statusCode).toBe(403);
        }

        // And the world is exactly as it was.
        const after = await db.db.select().from(world).where(eq(world.id, row.id));
        expect(after[0]?.status).toBe('staging');
        expect(after[0]?.launchDate.getTime()).toBe(row.launchDate.getTime());
      } finally {
        await app.close();
      }
    });

    it('opens a world and answers with both sides', async () => {
      const actor = await makeAdmin();
      const row = await makeWorld('staging');
      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: `/api/admin/worlds/${row.id}/status`,
          payload: { status: 'open', expectedStatus: 'staging' },
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(200);
        const body = reply.json<{ before: string; after: string; world: { status: string } }>();
        expect(body.before).toBe('staging');
        expect(body.after).toBe('open');
        expect(body.world.status).toBe('open');
      } finally {
        await app.close();
      }
    });

    it('resets a world and reports what it destroyed', async () => {
      const actor = await makeAdmin();
      const row = await makeWorld('open');
      await makeAirline(row.id, 'hh');
      const app = buildApp({ env, db });
      try {
        const reply = await app.inject({
          method: 'POST',
          url: `/api/admin/worlds/${row.id}/reset`,
          payload: {
            confirmName: row.name,
            reason: 'rehearsing the reset',
            expectedStatus: 'open',
          },
          headers: { cookie: await cookieFor(actor) },
        });

        expect(reply.statusCode).toBe(200);
        const body = reply.json<{
          destroyed: { airlines: number; events: number };
          inGameDate: string;
          world: { status: string; airlines: number };
        }>();
        expect(body.destroyed.airlines).toBe(1);
        expect(body.inGameDate).toBe(row.epoch.toISOString());
        expect(body.world.status).toBe('staging');
        // Nothing left in it, and the summary says so rather than repeating the
        // count it had a moment ago.
        expect(body.world.airlines).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('maps each refusal to the status it deserves', async () => {
      const actor = await makeAdmin();
      const row = await makeWorld('open');
      const app = buildApp({ env, db });
      try {
        const cookie = await cookieFor(actor);
        async function statusOf(
          path: string,
          payload: Record<string, unknown>,
          worldId = row.id,
        ): Promise<number> {
          const reply = await app.inject({
            method: 'POST',
            url: `/api/admin/worlds/${worldId}/${path}`,
            payload,
            headers: { cookie },
          });
          return reply.statusCode;
        }

        const missing = '11111111-2222-3333-4444-555555555555';

        // A reason too short, or a name not typed, is the request's fault.
        expect(
          await statusOf('reset', { confirmName: row.name, reason: '', expectedStatus: 'open' }),
        ).toBe(400);
        expect(
          await statusOf('reset', {
            confirmName: 'wrong',
            reason: 'trying it on',
            expectedStatus: 'open',
          }),
        ).toBe(400);

        // A world that is not there — including an id that is not a uuid.
        expect(
          await statusOf('status', { status: 'locked', expectedStatus: 'open' }, missing),
        ).toBe(404);
        expect(
          await statusOf('status', { status: 'locked', expectedStatus: 'open' }, 'not-a-uuid'),
        ).toBe(404);

        // A conflict with the world's state rather than with the request.
        expect(await statusOf('status', { status: 'archived', expectedStatus: 'open' })).toBe(409);
        expect(await statusOf('status', { status: 'locked', expectedStatus: 'staging' })).toBe(409);
      } finally {
        await app.close();
      }
    });
  });
});
