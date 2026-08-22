import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { requeueUnsupportedEvents, validateRequeueRequest } from '../admin/events';
import { BOOTSTRAP_ACTOR } from '../admin/grants';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { world, worldEvent, type WorldRow } from '../db/schema';
import { createWorld } from '../world/lifecycle';

import {
  drainDueEvents,
  type HandlerRegistry,
  requeueSupportedEvents,
  scheduleEvent,
  unsupportedEvents,
} from './event-queue';

/**
 * An event type nobody handles must not be destroyed (SCALE-05).
 *
 * ADR-0019 called this a loaded gun: *"Start a worker against a queue holding
 * materialised departures and every one of those rows is marked failed on the
 * first tick."* These tests are the proof that it is unloaded.
 *
 * The distinction the whole change rests on: `failed` means **this event is
 * broken**, and `unsupported` means **this Worker cannot do this yet**. The
 * first is a data problem for an operator; the second is a deployment problem
 * that resolves itself when the handler ships, and only one of them should look
 * terminal.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [unsupported-events.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/** Well before any epoch, so everything scheduled is due immediately. */
const DUE = new Date('2024-10-01T00:00:00.000Z');
const REAL_NOW = new Date('2026-08-21T12:00:00.000Z');

describeDb('an event type this build cannot handle', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(world).where(eq(world.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeWorld(): Promise<WorldRow> {
    const created = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `scale05-${randomUUID().slice(0, 8)}`,
    });
    madeWorlds.push(created.world.id);
    return created.world;
  }

  const clockOf = (row: WorldRow) => ({
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  });

  /**
   * Schedule one event and return its id.
   *
   * `scheduleEvent` answers *"was it new?"* rather than handing back the row —
   * the right shape for the idempotent producer it serves, and not what a test
   * that needs to watch one row wants. Looked up by the idempotency key, which
   * is unique per world.
   */
  async function schedule(
    worldId: string,
    type: 'FLIGHT_DEPART' | 'FLIGHT_ARRIVE' | 'TURNAROUND_COMPLETE',
    fireAt = DUE,
  ): Promise<string> {
    const key = `${type}:${randomUUID()}`;
    await scheduleEvent(db.db, { worldId, type, fireAt, idempotencyKey: key, payload: {} });
    const rows = await db.db
      .select({ id: worldEvent.id })
      .from(worldEvent)
      .where(and(eq(worldEvent.worldId, worldId), eq(worldEvent.idempotencyKey, key)));
    const row = rows[0];
    if (!row) throw new Error(`event ${key} was not scheduled`);
    return row.id;
  }

  /** Counts a call rather than doing anything — enough to prove it ran. */
  function countingHandlers(): { handlers: HandlerRegistry; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      handlers: {
        FLIGHT_ARRIVE: (event) => {
          calls.push(event.id);
          return Promise.resolve();
        },
      },
    };
  }

  async function statusOf(id: string): Promise<{
    status: string;
    attempts: number;
    processedAt: Date | null;
    lastError: string | null;
  }> {
    const rows = await db.db
      .select({
        status: worldEvent.status,
        attempts: worldEvent.attempts,
        processedAt: worldEvent.processedAt,
        lastError: worldEvent.lastError,
      })
      .from(worldEvent)
      .where(eq(worldEvent.id, id));
    const row = rows[0];
    if (!row) throw new Error(`no event ${id}`);
    return row;
  }

  // ------------------------------------------------- the core guarantee

  it('is never marked failed just because no handler exists', async () => {
    const w = await makeWorld();
    const event = await schedule(w.id, 'FLIGHT_DEPART');

    const { handlers } = countingHandlers();
    const result = await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);

    expect(result.unsupported).toBe(1);
    expect(result.failed).toBe(0);

    const row = await statusOf(event);
    expect(row.status).toBe('unsupported');
    // Nothing was attempted, so nothing is recorded as attempted. A retry
    // policy reading this must not see a flaky event.
    expect(row.attempts).toBe(0);
    // And nothing processed it, so it carries no processed time. That is what
    // lets the requeue be a status change rather than a repair.
    expect(row.processedAt).toBeNull();
    expect(row.lastError).toMatch(/No handler registered for FLIGHT_DEPART/);
  });

  it('exercises TURNAROUND_COMPLETE too, the other type with this problem', async () => {
    const w = await makeWorld();
    const event = await schedule(w.id, 'TURNAROUND_COMPLETE');

    const { handlers } = countingHandlers();
    await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);
    expect((await statusOf(event)).status).toBe('unsupported');
  });

  it('is not reclaimed on the next tick', async () => {
    // The starvation guard. Left `pending`, an unhandled type at the head of a
    // world's queue would be claimed on every tick for ever.
    const w = await makeWorld();
    await schedule(w.id, 'FLIGHT_DEPART');

    const { handlers } = countingHandlers();
    const first = await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);
    const second = await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);

    expect(first.unsupported).toBe(1);
    expect(second.unsupported).toBe(0);
  });

  it('does not starve supported events queued behind it', async () => {
    // The mixed queue, with the unsupported event *first* in game time so it is
    // at the head of the claim order. If it blocked, nothing behind it would run.
    const w = await makeWorld();
    await schedule(w.id, 'FLIGHT_DEPART');
    const arrive = await schedule(w.id, 'FLIGHT_ARRIVE', new Date(DUE.getTime() + 60_000));

    const { handlers, calls } = countingHandlers();
    const result = await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);

    expect(result.processed).toBe(1);
    expect(result.unsupported).toBe(1);
    expect(calls).toEqual([arrive]);
    expect((await statusOf(arrive)).status).toBe('done');
  });

  it('still distinguishes a genuine handler exception', async () => {
    // The whole point of the split: `failed` has to keep meaning "broken".
    const w = await makeWorld();
    const event = await schedule(w.id, 'FLIGHT_ARRIVE');

    const handlers: HandlerRegistry = {
      FLIGHT_ARRIVE: () => Promise.reject(new Error('the handler itself is broken')),
    };
    const result = await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);

    expect(result.failed).toBe(1);
    expect(result.unsupported).toBe(0);

    const row = await statusOf(event);
    expect(row.status).toBe('failed');
    // A real attempt was made, and it is counted.
    expect(row.attempts).toBe(1);
    expect(row.processedAt).not.toBeNull();
    expect(row.lastError).toMatch(/the handler itself is broken/);
  });

  // ------------------------------------------- the handler ships later

  it('resumes the work when a build with the handler arrives', async () => {
    // The scenario the whole state exists for. ADR-0019 refused to invent
    // departure behaviour early; this is that refusal costing nothing.
    const w = await makeWorld();
    const event = await schedule(w.id, 'FLIGHT_DEPART');

    const { handlers } = countingHandlers();
    await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);
    expect((await statusOf(event)).status).toBe('unsupported');

    // A later build boots, knowing the type.
    const requeued = await requeueSupportedEvents(db.db, ['FLIGHT_DEPART']);
    expect(requeued).toBeGreaterThanOrEqual(1);
    expect((await statusOf(event)).status).toBe('pending');
    // The error from the previous build is cleared — it is no longer true.
    expect((await statusOf(event)).lastError).toBeNull();

    const departs: string[] = [];
    const withDepart: HandlerRegistry = {
      FLIGHT_DEPART: (e) => {
        departs.push(e.id);
        return Promise.resolve();
      },
    };
    const result = await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, withDepart);

    expect(result.processed).toBe(1);
    expect(departs).toEqual([event]);
    expect((await statusOf(event)).status).toBe('done');
    // Exactly once: nothing ran before, so this is the first and only execution.
    expect((await statusOf(event)).attempts).toBe(1);
  });

  it('leaves alone the types a build still cannot handle', async () => {
    const w = await makeWorld();
    const depart = await schedule(w.id, 'FLIGHT_DEPART');
    const turn = await schedule(w.id, 'TURNAROUND_COMPLETE');

    const { handlers } = countingHandlers();
    await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);

    await requeueSupportedEvents(db.db, ['FLIGHT_DEPART']);
    expect((await statusOf(depart)).status).toBe('pending');
    expect((await statusOf(turn)).status).toBe('unsupported');
  });

  // --------------------------------------------------- what an operator sees

  it('reports what is waiting, per world and per type', async () => {
    const w = await makeWorld();
    for (let i = 0; i < 3; i += 1) {
      await schedule(w.id, 'FLIGHT_DEPART', new Date(DUE.getTime() + i * 60_000));
    }

    const { handlers } = countingHandlers();
    await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);

    const groups = (await unsupportedEvents(db.db)).filter((g) => g.worldId === w.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe('FLIGHT_DEPART');
    expect(groups[0]?.count).toBe(3);
    // The oldest, so "how far behind" is answerable. `min()` is a raw aggregate
    // and comes back as a string from the driver — normalised, or this is a
    // `Date` that is really a string and every comparison lies.
    expect(groups[0]?.oldestFireAt).toBeInstanceOf(Date);
    expect(groups[0]?.oldestFireAt.toISOString()).toBe(DUE.toISOString());
  });

  // ----------------------------------------------- recovery without SQL

  it('can be requeued by an audited admin action', async () => {
    const w = await makeWorld();
    const event = await schedule(w.id, 'FLIGHT_DEPART');

    const { handlers } = countingHandlers();
    await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);

    const validated = validateRequeueRequest({ types: ['FLIGHT_DEPART'] });
    if (!validated.ok) throw new Error('expected a valid request');

    const outcome = await requeueUnsupportedEvents(db.db, validated.request, BOOTSTRAP_ACTOR);
    if (!outcome.ok) throw new Error(`expected success: ${outcome.message}`);

    expect(outcome.requeued).toBeGreaterThanOrEqual(1);
    expect((await statusOf(event)).status).toBe('pending');
  });

  it('refuses a request that names no types', () => {
    // Deliberately not defaulted to "all": requeueing a type whose handler still
    // does not exist just churns the rows and muddies the audit trail.
    expect(validateRequeueRequest({ types: [] }).ok).toBe(false);
    expect(validateRequeueRequest({}).ok).toBe(false);
    expect(validateRequeueRequest(null).ok).toBe(false);
  });

  it('says so rather than auditing a no-op', async () => {
    const validated = validateRequeueRequest({ types: ['TURNAROUND_COMPLETE'] });
    if (!validated.ok) throw new Error('expected a valid request');

    // Nothing paused for this type in a clean database.
    const outcome = await requeueUnsupportedEvents(db.db, validated.request, BOOTSTRAP_ACTOR);
    if (outcome.ok && outcome.requeued > 0) return; // another suite left work; fine
    expect(outcome.ok).toBe(false);
  });

  it('never destroys an unsupported event by any path in the drain', async () => {
    // The strongest form of the criterion: drain repeatedly, with and without
    // handlers, and the row is still there and still recoverable.
    const w = await makeWorld();
    const event = await schedule(w.id, 'FLIGHT_DEPART');

    const { handlers } = countingHandlers();
    for (let i = 0; i < 5; i += 1) {
      await drainDueEvents(db.db, w.id, clockOf(w), REAL_NOW, handlers);
    }

    const rows = await db.db
      .select({ id: worldEvent.id })
      .from(worldEvent)
      .where(and(eq(worldEvent.id, event), eq(worldEvent.status, 'unsupported')));
    expect(rows).toHaveLength(1);
    expect((await statusOf(event)).attempts).toBe(0);
  });
});
