import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type WorldClock } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { world, worldEvent } from '../db/schema';

import {
  drainDueEvents,
  queueDepth,
  scheduleEvent,
  type HandlerRegistry,
  type WorldEventType,
} from './event-queue';

/**
 * The event queue, against a real Postgres.
 *
 * Nothing here can be checked by reading the code: the ordering guarantee, the
 * exactly-once guarantee and the backlog behaviour are all properties of the
 * database's locking, not of the TypeScript.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn('\n  [event-queue.test] DATABASE_URL not set — skipping queue tests.\n');
}
const describeDb = url ? describe : describe.skip;

const EPOCH = new Date('2024-10-20T00:00:00.000Z');
const LAUNCH = new Date('2026-08-18T00:00:00.000Z');
const clock: WorldClock = { epoch: EPOCH, launchDate: LAUNCH, speedMultiplier: 2 };

/** Real instant at which game time is `minutes` past the epoch. Speed 2, so half. */
function realAtGameMinutes(minutes: number): Date {
  return new Date(LAUNCH.getTime() + (minutes * 60_000) / 2);
}
function gameMinutes(minutes: number): Date {
  return new Date(EPOCH.getTime() + minutes * 60_000);
}

describeDb('event queue', () => {
  let db: DatabaseHandle;
  let worldId: string;

  beforeAll(async () => {
    db = createDatabase();
    const created = await db.db
      .insert(world)
      .values({
        name: `queue-test-${Math.random().toString(36).slice(2, 10)}`,
        epoch: EPOCH,
        launchDate: LAUNCH,
        speedMultiplier: '2',
        aircraftCatalogueVersion: 'test',
        economyConfigVersion: 'test',
      })
      .returning({ id: world.id });
    worldId = created[0]!.id;
  });

  afterAll(async () => {
    // Events cascade with the world.
    await db.db.delete(world).where(eq(world.id, worldId));
    await db.close();
  });

  afterEach(async () => {
    await db.db.delete(worldEvent).where(eq(worldEvent.worldId, worldId));
  });

  function recorder() {
    const fired: string[] = [];
    const handlers: HandlerRegistry = {};
    for (const type of ['FLIGHT_DEPART', 'FLIGHT_ARRIVE', 'TURNAROUND_COMPLETE'] as const) {
      handlers[type] = async (event, { payload }) => {
        const tag = typeof payload.tag === 'string' ? payload.tag : '';
        fired.push(`${event.type}:${tag}`);
        await Promise.resolve();
      };
    }
    return { fired, handlers };
  }

  async function schedule(
    tag: string,
    minutes: number,
    type: WorldEventType = 'FLIGHT_DEPART',
  ): Promise<boolean> {
    return scheduleEvent(db.db, {
      worldId,
      type,
      fireAt: gameMinutes(minutes),
      payload: { tag },
      idempotencyKey: `test:${tag}`,
    });
  }

  it('fires a due event and marks it done', async () => {
    await schedule('a', 10);
    const { fired, handlers } = recorder();

    const result = await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(20), handlers);

    expect(result.processed).toBe(1);
    expect(fired).toEqual(['FLIGHT_DEPART:a']);

    const rows = await db.db.select().from(worldEvent).where(eq(worldEvent.worldId, worldId));
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.processedAt).not.toBeNull();
  });

  it('leaves an event that is not due yet', async () => {
    await schedule('later', 100);
    const { fired, handlers } = recorder();

    const result = await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(20), handlers);

    expect(result.processed).toBe(0);
    expect(fired).toEqual([]);
  });

  it('fires events in game-time order, not insertion order', async () => {
    // The acceptance criterion. Inserted deliberately backwards.
    await schedule('third', 30);
    await schedule('first', 10);
    await schedule('second', 20);

    const { fired, handlers } = recorder();
    await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), handlers);

    expect(fired).toEqual(['FLIGHT_DEPART:first', 'FLIGHT_DEPART:second', 'FLIGHT_DEPART:third']);
  });

  it('keeps game-time order across a restart', async () => {
    // Simulated by draining in two passes with a fresh handler set, which is
    // what a restart looks like to the queue: the state is entirely in the table.
    await schedule('one', 10);
    await schedule('two', 20);
    await schedule('three', 30);

    const first = recorder();
    await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(15), first.handlers);
    expect(first.fired).toEqual(['FLIGHT_DEPART:one']);

    const second = recorder();
    await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), second.handlers);
    expect(second.fired).toEqual(['FLIGHT_DEPART:two', 'FLIGHT_DEPART:three']);
  });

  describe('exactly once', () => {
    it('refuses a second event under the same idempotency key', async () => {
      expect(await schedule('dup', 10)).toBe(true);
      expect(await schedule('dup', 10)).toBe(false);

      const rows = await db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(worldEvent)
        .where(eq(worldEvent.worldId, worldId));
      expect(rows[0]?.n).toBe(1);
    });

    it('does not replay an event a second drain sees', async () => {
      // The restart criterion: rerunning the drain must not fire it again.
      await schedule('once', 10);

      const first = recorder();
      await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), first.handlers);
      expect(first.fired).toHaveLength(1);

      const second = recorder();
      const result = await drainDueEvents(
        db.db,
        worldId,
        clock,
        realAtGameMinutes(60),
        second.handlers,
      );
      expect(second.fired).toEqual([]);
      expect(result.processed).toBe(0);
    });

    it('does not double-handle when two drains run at once', async () => {
      // `FOR UPDATE SKIP LOCKED` is what makes this safe; without it both
      // workers would claim the same row.
      for (let i = 0; i < 20; i += 1) await schedule(`c${String(i)}`, 10 + i);

      const a = recorder();
      const b = recorder();
      const [ra, rb] = await Promise.all([
        drainDueEvents(db.db, worldId, clock, realAtGameMinutes(600), a.handlers),
        drainDueEvents(db.db, worldId, clock, realAtGameMinutes(600), b.handlers),
      ]);

      expect(ra.processed + rb.processed).toBe(20);
      expect(new Set([...a.fired, ...b.fired]).size).toBe(20);
    });
  });

  describe('a backlog', () => {
    it('works through everything a ten-minute outage left behind', async () => {
      // Ten real minutes at speed 2 is twenty game minutes. An event a minute.
      for (let i = 0; i < 20; i += 1) await schedule(`b${String(i)}`, i);

      const { fired, handlers } = recorder();
      const result = await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(30), handlers);

      expect(result.processed).toBe(20);
      expect(fired).toHaveLength(20);

      const remaining = await queueDepth(db.db, worldId, clock, realAtGameMinutes(30));
      expect(remaining.due).toBe(0);
    });

    it('drops nothing when the batch size is smaller than the backlog', async () => {
      // A cap on one drain must delay events, never lose them.
      for (let i = 0; i < 12; i += 1) await schedule(`s${String(i)}`, i);

      const seen: string[] = [];
      for (let pass = 0; pass < 4; pass += 1) {
        const { fired, handlers } = recorder();
        await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), handlers, {
          batchSize: 5,
        });
        seen.push(...fired);
      }

      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
    });

    it('reports how deep the queue is', async () => {
      await schedule('d1', 5);
      await schedule('d2', 15);
      const depth = await queueDepth(db.db, worldId, clock, realAtGameMinutes(20));
      expect(depth.due).toBe(2);
      expect(depth.oldestDueAt?.getTime()).toBe(gameMinutes(5).getTime());
    });
  });

  describe('a handler that throws', () => {
    it('marks the event failed rather than leaving it to retry forever', async () => {
      // A permanently broken event left pending would be reclaimed every tick and
      // starve everything behind it.
      await schedule('bad', 10);
      const handlers: HandlerRegistry = {
        FLIGHT_DEPART: () => Promise.reject(new Error('handler exploded')),
      };

      const result = await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), handlers);
      expect(result.failed).toBe(1);

      const rows = await db.db.select().from(worldEvent).where(eq(worldEvent.worldId, worldId));
      expect(rows[0]?.status).toBe('failed');
      expect(rows[0]?.lastError).toContain('handler exploded');
      expect(rows[0]?.attempts).toBe(1);
    });

    it('does not block the events behind it', async () => {
      await schedule('bad', 10);
      await schedule('good', 20, 'FLIGHT_ARRIVE');

      const fired: string[] = [];
      const handlers: HandlerRegistry = {
        FLIGHT_DEPART: () => Promise.reject(new Error('nope')),
        FLIGHT_ARRIVE: (_event, { payload }) => {
          fired.push(String(payload.tag));
          return Promise.resolve();
        },
      };

      const result = await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), handlers);
      expect(result.failed).toBe(1);
      expect(result.processed).toBe(1);
      expect(fired).toEqual(['good']);
    });

    it('fails an event whose type has no handler, rather than quietly discarding it', async () => {
      // An unhandled type is a deployment problem. Marking it done would lose it.
      await schedule('orphan', 10, 'TURNAROUND_COMPLETE');
      const result = await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), {});

      expect(result.failed).toBe(1);
      const rows = await db.db.select().from(worldEvent).where(eq(worldEvent.worldId, worldId));
      expect(rows[0]?.lastError).toContain('No handler registered');
    });
  });

  it('carries the payload through to the handler', async () => {
    await scheduleEvent(db.db, {
      worldId,
      type: 'FLIGHT_ARRIVE',
      fireAt: gameMinutes(5),
      payload: { flightId: 'abc', delayMinutes: 12 },
      idempotencyKey: 'test:payload',
    });

    let seen: Record<string, unknown> = {};
    await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), {
      FLIGHT_ARRIVE: (_event, { payload }) => {
        seen = payload;
        return Promise.resolve();
      },
    });

    expect(seen).toEqual({ flightId: 'abc', delayMinutes: 12 });
  });
});
