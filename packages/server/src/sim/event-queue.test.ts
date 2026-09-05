import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type WorldClock } from '@tailfin/sim';

import { type Database, createDatabase, type DatabaseHandle } from '../db/client';
import { world, worldEvent } from '../db/schema';

import {
  drainDueEvents,
  errorDetail,
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

/**
 * What a failed event says it went wrong with.
 *
 * A unit test, so it runs without a database: this is the half of the failure
 * record that decides whether an operator can act on it, and it would otherwise
 * only be exercised where `DATABASE_URL` happens to be set.
 */
describe('errorDetail', () => {
  it('puts the cause before the wrapper', () => {
    // Drizzle prefixes every driver error with `Failed query:` and the whole
    // failing statement. Keeping that order would spend the column on SQL and
    // never reach the reason — the trap CLAUDE.md records.
    const cause = new Error('duplicate key value violates unique constraint "world_event_key"');
    const wrapped = new Error('Failed query: insert into "world_event" ...', { cause });

    expect(errorDetail(wrapped)).toBe(
      'duplicate key value violates unique constraint "world_event_key" | ' +
        'Failed query: insert into "world_event" ...',
    );
  });

  it('bounds the result to what the column holds', () => {
    const long = new Error('x'.repeat(900));
    expect(errorDetail(long)).toHaveLength(500);
    expect(errorDetail(long, 10)).toHaveLength(10);
  });

  it('survives something thrown that is not an Error', () => {
    // A handler is arbitrary code; `throw 'nope'` is legal JavaScript, and the
    // failure record still has to say something.
    expect(errorDetail('nope')).toBe('nope');
    expect(errorDetail(undefined)).toBe('undefined');
  });

  it('skips an empty message rather than emitting a stray separator', () => {
    const cause = new Error('the real reason');
    expect(errorDetail(new Error('', { cause }))).toBe('the real reason');
  });
});

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
        seed: 'queue-test-seed',
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
      // A real Date, not the string the driver hands back for a raw min()
      // aggregate. Asserting the type and not only the value, because the first
      // version returned a string that typechecked as a Date.
      expect(depth.oldestDueAt).toBeInstanceOf(Date);
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

    /**
     * A handler's own writes, so a rollback has something to undo.
     *
     * `world_event` is the table, which keeps the fixture to one already-cleaned
     * table rather than founding an airline to observe a rollback. What matters
     * is that the write is real, made by the same transaction as the claim, and
     * visible afterwards if it survives.
     */
    function sideEffectHandler(
      key: string,
      then: (tx: Database) => Promise<void>,
    ): HandlerRegistry {
      return {
        FLIGHT_DEPART: async (_event, { tx }) => {
          await tx.insert(worldEvent).values({
            worldId,
            type: 'FLIGHT_ARRIVE',
            fireAt: gameMinutes(9_999),
            payload: '{}',
            idempotencyKey: key,
          });
          await then(tx);
        },
      };
    }

    /** Inserting `key` a second time violates `(world_id, idempotency_key)`. */
    function collide(key: string): (tx: Database) => Promise<void> {
      return async (tx) => {
        await tx.insert(worldEvent).values({
          worldId,
          type: 'FLIGHT_ARRIVE',
          fireAt: gameMinutes(9_999),
          payload: '{}',
          idempotencyKey: key,
        });
      };
    }

    async function keysInWorld(): Promise<string[]> {
      const rows = await db.db
        .select({ key: worldEvent.idempotencyKey })
        .from(worldEvent)
        .where(eq(worldEvent.worldId, worldId));
      return rows.map((row) => row.key).sort();
    }

    it('rolls back what the handler wrote before it threw', async () => {
      /*
       * IMPROVE-01. The handler and the failure record used to share one
       * transaction, so a handler that wrote and *then* threw had its writes
       * committed alongside `status = 'failed'` — a half-finished flight
       * settlement, recorded as not having happened.
       *
       * Which is the worst of the three possible outcomes. Rolled back is
       * recoverable; committed and marked done is at least consistent; committed
       * and marked failed is a lie no later drain can detect.
       */
      await schedule('writer', 10);

      const result = await drainDueEvents(
        db.db,
        worldId,
        clock,
        realAtGameMinutes(60),
        sideEffectHandler('test:side-effect', () =>
          Promise.reject(new Error('exploded after writing')),
        ),
      );

      expect(result.failed).toBe(1);
      // The claim and the failure survive; the handler's write does not.
      expect(await keysInWorld()).toEqual(['test:writer']);

      const rows = await db.db.select().from(worldEvent).where(eq(worldEvent.worldId, worldId));
      expect(rows[0]?.status).toBe('failed');
      expect(rows[0]?.lastError).toContain('exploded after writing');
      expect(rows[0]?.attempts).toBe(1);
    });

    it('records a SQL error as failed instead of losing the claim to it', async () => {
      /*
       * The second half of IMPROVE-01, and the more damaging one.
       *
       * A statement error aborts the whole PostgreSQL transaction, so the
       * `UPDATE ... status = 'failed'` in the catch failed too, taking the claim
       * with it. The event returned to `pending` and was reclaimed on the next
       * tick, for ever. Worse, the rejection escaped `drainDueEvents`, so the
       * tick died with it: every sweep after the drain, and every world after
       * this one, stopped running until somebody deleted the row by hand.
       *
       * A duplicate idempotency key is the cheapest real statement error, and
       * the unique index is the queue's own — a failure a handler could
       * genuinely produce by rescheduling badly.
       */
      await schedule('poison', 10);

      const result = await drainDueEvents(
        db.db,
        worldId,
        clock,
        realAtGameMinutes(60),
        sideEffectHandler('test:collide', collide('test:collide')),
      );

      expect(result.failed).toBe(1);
      expect(await keysInWorld()).toEqual(['test:poison']);

      const rows = await db.db.select().from(worldEvent).where(eq(worldEvent.worldId, worldId));
      // `pending` here would mean the claim was rolled back, and this event
      // would be reclaimed on every tick for ever.
      expect(rows[0]?.status).toBe('failed');
      expect(rows[0]?.attempts).toBe(1);
      // PostgreSQL's own words, not Drizzle's wrapper. Drizzle prefixes every
      // driver error with `Failed query:` and the whole failing statement, which
      // would fill the column with SQL before reaching the reason — the trap
      // CLAUDE.md records, here deciding what a human reads on System health.
      expect(rows[0]?.lastError).toMatch(/duplicate key value violates unique constraint/i);
      // Bounded, because that statement is long.
      expect((rows[0]?.lastError ?? '').length).toBeLessThanOrEqual(500);
    });

    it('keeps draining after a SQL failure, in the same pass', async () => {
      // The acceptance criterion the old code could not meet at all: the
      // rejection escaped the drain, so nothing behind the poisonous event ran.
      await schedule('poison', 10);
      await schedule('good', 20, 'FLIGHT_ARRIVE');

      const fired: string[] = [];
      const handlers: HandlerRegistry = {
        ...sideEffectHandler('test:collide', collide('test:collide')),
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

    it('applies a successful side effect once when two drains race', async () => {
      /*
       * The savepoint must not weaken exactly-once. Two drains run against the
       * same due event; `FOR UPDATE SKIP LOCKED` means one claims it and the
       * other skips, so the handler's write must appear exactly once — not twice,
       * and not zero times because the loser rolled the winner back.
       *
       * The unique index would refuse a second insert anyway, which is why the
       * assertion counts rows *and* checks the drains agree on who did the work.
       */
      await schedule('raced', 10);
      const handlers = sideEffectHandler('test:side-effect', () => Promise.resolve());

      const [first, second] = await Promise.all([
        drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), handlers),
        drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), handlers),
      ]);

      expect(first.processed + second.processed).toBe(1);
      expect(first.failed + second.failed).toBe(0);
      expect(await keysInWorld()).toEqual(['test:raced', 'test:side-effect']);
    });

    it('does not re-apply a side effect when the event is drained again', async () => {
      // Replay, as distinct from concurrency. The event is `done`, so a second
      // drain must not reach the handler at all.
      await schedule('once', 10);
      const handlers = sideEffectHandler('test:side-effect', () => Promise.resolve());

      await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), handlers);
      const again = await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), handlers);

      expect(again.processed).toBe(0);
      expect(again.failed).toBe(0);
      expect(await keysInWorld()).toEqual(['test:once', 'test:side-effect']);
    });

    it('still commits a handler’s writes when it succeeds', async () => {
      // The other direction, and the one a savepoint could plausibly break:
      // isolating the handler must not stop its work being committed together
      // with the event's completion.
      await schedule('writer', 10);

      const result = await drainDueEvents(
        db.db,
        worldId,
        clock,
        realAtGameMinutes(60),
        sideEffectHandler('test:side-effect', () => Promise.resolve()),
      );

      expect(result.processed).toBe(1);
      expect(await keysInWorld()).toEqual(['test:side-effect', 'test:writer']);

      const claimed = await db.db
        .select()
        .from(worldEvent)
        .where(eq(worldEvent.idempotencyKey, 'test:writer'));
      expect(claimed[0]?.status).toBe('done');
    });

    it('pauses an event whose type has no handler, rather than failing or discarding it', async () => {
      // An unhandled type is a deployment problem, and since SCALE-05 it is
      // recorded as one. This assertion used to read `result.failed` and was
      // correct until then; conflating "no handler in this build" with "the
      // handler threw" made a rising `failed` count meaningless and made
      // recoverable work look destroyed.
      await schedule('orphan', 10, 'TURNAROUND_COMPLETE');
      const result = await drainDueEvents(db.db, worldId, clock, realAtGameMinutes(60), {});

      expect(result.unsupported).toBe(1);
      expect(result.failed).toBe(0);

      const rows = await db.db.select().from(worldEvent).where(eq(worldEvent.worldId, worldId));
      expect(rows[0]?.status).toBe('unsupported');
      expect(rows[0]?.lastError).toContain('No handler registered');
      // Nothing was attempted and nothing processed it, which is what makes the
      // way back a status change rather than a repair.
      expect(rows[0]?.attempts).toBe(0);
      expect(rows[0]?.processedAt).toBeNull();
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
