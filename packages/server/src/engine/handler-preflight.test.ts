import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { world, worldEvent } from '../db/schema';
import {
  drainDueEvents,
  scheduleEvent,
  type HandlerRegistry,
  type WorldEventType,
} from '../sim/event-queue';
import { createWorld } from '../world/lifecycle';

import {
  classifyHandlerCoverage,
  collectHandlerPreflight,
  formatHandlerPreflight,
  type HandlerPreflight,
  type QueuedEventType,
} from './handler-preflight';
import { handledEventTypes } from './handlers';

/**
 * Refuse a Worker that cannot handle the work already queued (SCALE-06).
 *
 * SCALE-05 made the bad outcome survivable: an event of a type nobody handles is
 * parked as `unsupported` rather than destroyed. This is the other end of the
 * same problem, and the distinction the tests below rest on is that **survivable
 * is not intended**. A Worker rolled back to a build without a handler will stop
 * processing a type the world is still generating, and the operator's first sign
 * is a growing pile of deferred work rather than a refused deploy.
 *
 * The load-bearing test is `refuses exactly the deploy that would park real
 * work`: it proves the gate and the runtime agree, by running the drain the gate
 * was protecting against and watching it do the thing the gate predicted.
 */

const DUE = new Date('2024-10-01T00:00:00.000Z');
const REAL_NOW = new Date('2026-08-21T12:00:00.000Z');

function queued(
  type: WorldEventType,
  count: number,
  worlds = 1,
  oldestFireAt = DUE,
): QueuedEventType {
  return { type, count, worlds, oldestFireAt };
}

describe('comparing a build against a queue', () => {
  it('finds no gap when every queued type has a handler', () => {
    const gaps = classifyHandlerCoverage(
      ['FLIGHT_ARRIVE', 'FLIGHT_DEPART'],
      [queued('FLIGHT_ARRIVE', 3)],
    );
    expect(gaps).toEqual([]);
  });

  it('names the type with no handler, and its count', () => {
    const gaps = classifyHandlerCoverage(['FLIGHT_ARRIVE'], [queued('FLIGHT_DEPART', 412, 2)]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.type).toBe('FLIGHT_DEPART');
    expect(gaps[0]?.count).toBe(412);
  });

  it('reports only the uncovered types when a queue holds both', () => {
    const gaps = classifyHandlerCoverage(
      ['FLIGHT_ARRIVE'],
      [queued('FLIGHT_ARRIVE', 9), queued('FLIGHT_DEPART', 1), queued('TURNAROUND_COMPLETE', 4)],
    );
    expect(gaps.map((gap) => gap.type)).toEqual(['FLIGHT_DEPART', 'TURNAROUND_COMPLETE']);
  });

  it('passes an empty queue, whatever the build handles', () => {
    // The ordinary case on a fresh box, and the one a gate must not make
    // exciting. A worker that handles nothing at all against a queue holding
    // nothing at all is compatible, because there is no work to fail to do.
    expect(classifyHandlerCoverage([], [])).toEqual([]);
  });
});

describe('the refusal an operator reads', () => {
  function report(over: Partial<HandlerPreflight> = {}): string {
    const gaps = over.gaps ?? [];
    const base: HandlerPreflight = {
      handled: ['FLIGHT_ARRIVE'],
      actionable: [],
      gaps,
      excluded: { done: 0, failed: 0, unsupported: 0, archived: 0 },
      compatible: gaps.length === 0,
      ...over,
    };
    return formatHandlerPreflight(base).join('\n');
  }

  it('names the offending types and their counts', () => {
    const gap = queued('FLIGHT_DEPART', 412, 2);
    const text = report({ actionable: [gap], gaps: [gap] });
    expect(text).toContain('FLIGHT_DEPART');
    expect(text).toContain('412');
    expect(text).toContain('REFUSED');
    expect(text).toContain('NO HANDLER');
  });

  it('tells the operator what to do instead', () => {
    const gap = queued('FLIGHT_DEPART', 1);
    expect(report({ actionable: [gap], gaps: [gap] })).toContain('ALLOW_HANDLER_GAP=1');
  });

  it('reports excluded rows as excluded rather than omitting them', () => {
    // The criterion is that history is *seen and classified*, not merely absent
    // from the decision. An operator who knows there are 4,000 FLIGHT_DEPART
    // rows must be able to tell "considered, and they are history" from "the
    // check did not notice them".
    const text = report({ excluded: { done: 40, failed: 3, unsupported: 4000, archived: 12 } });
    expect(text).toContain('40 done');
    expect(text).toContain('3 failed');
    expect(text).toContain('4000 already parked');
    expect(text).toContain('12 pending in archived worlds');
  });

  it('says so even when there is nothing to exclude', () => {
    expect(report()).toContain('excluded from the decision: 0 done');
  });

  it('marks a covered type ok rather than leaving it unannotated', () => {
    const text = report({ actionable: [queued('FLIGHT_ARRIVE', 5)] });
    expect(text).toContain('FLIGHT_ARRIVE');
    expect(text).toContain('ok');
    expect(text).toContain('HANDLER PREFLIGHT: OK');
  });
});

describe('what this build says it handles', () => {
  it('answers with the registry the engine is given, not a second list', () => {
    // The one failure mode that would make the gate worse than useless: a build
    // whose probe and whose engine disagree. Asserted against the registry
    // itself so that adding a handler cannot leave the probe behind.
    expect(handledEventTypes()).toEqual(['FLIGHT_ARRIVE']);
  });

  it('is sorted, so a deploy log is comparable across runs', () => {
    expect(handledEventTypes()).toEqual(
      [...handledEventTypes()].sort((a, b) => a.localeCompare(b)),
    );
  });
});

/**
 * The database half. Requires `DATABASE_URL` against a migrated disposable
 * database; CI provides both, and `test-setup.ts` refuses anything not named
 * `_test` or `_ci`.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [handler-preflight.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('asking a real queue what is actionable', () => {
  let handle: DatabaseHandle;
  const madeWorlds: string[] = [];

  /**
   * Every assertion here is a **delta**, and that is not fussiness.
   *
   * `collectHandlerPreflight` asks about the whole database on purpose — a gate
   * that only looked at the world a test made would not be the gate the deploy
   * runs. So an absolute `compatible === true` is really an assertion about
   * every row any other suite happens to have left behind, which is a test that
   * passes or fails for reasons that have nothing to do with it. Measuring
   * before and after says the thing actually meant: *these rows* did, or did
   * not, move the decision.
   */
  async function reading(handled: WorldEventType[] = ['FLIGHT_ARRIVE']) {
    const result = await collectHandlerPreflight(handle.db, handled);
    return {
      result,
      actionableOf: (type: WorldEventType) =>
        result.actionable.find((row) => row.type === type)?.count ?? 0,
      gapTypes: result.gaps.map((gap) => gap.type),
    };
  }

  async function makeWorld(name: string): Promise<string> {
    const created = await createWorld(handle.db, {
      ...FLAGSHIP_CONFIG,
      name: `scale06-${name}-${randomUUID().slice(0, 8)}`,
    });
    madeWorlds.push(created.world.id);
    return created.world.id;
  }

  /** One event, in one state. Keyed per row so setting a status hits only it. */
  async function put(
    worldId: string,
    type: WorldEventType,
    status: 'pending' | 'done' | 'failed' | 'unsupported' = 'pending',
  ): Promise<void> {
    const key = `${type}:${randomUUID()}`;
    await scheduleEvent(handle.db, {
      worldId,
      type,
      fireAt: DUE,
      payload: {},
      idempotencyKey: key,
    });
    if (status !== 'pending') {
      await handle.db.update(worldEvent).set({ status }).where(eq(worldEvent.idempotencyKey, key));
    }
  }

  beforeAll(() => {
    handle = createDatabase();
  });

  afterEach(async () => {
    // `world_event` goes with the world's own cascade.
    for (const id of madeWorlds.splice(0)) {
      await handle.db.delete(world).where(eq(world.id, id));
    }
  });

  afterAll(async () => {
    await handle.close();
  });

  it('counts pending work, grouped by type', async () => {
    const before = await reading();
    const worldId = await makeWorld('actionable');
    await put(worldId, 'FLIGHT_DEPART');
    await put(worldId, 'FLIGHT_DEPART');
    await put(worldId, 'FLIGHT_ARRIVE');

    const after = await reading();

    expect(after.actionableOf('FLIGHT_DEPART')).toBe(before.actionableOf('FLIGHT_DEPART') + 2);
    expect(after.actionableOf('FLIGHT_ARRIVE')).toBe(before.actionableOf('FLIGHT_ARRIVE') + 1);

    const depart = after.result.actionable.find((row) => row.type === 'FLIGHT_DEPART');
    expect(depart?.worlds).toBeGreaterThanOrEqual(1);
    // `min()` is a raw aggregate and comes back a string from the driver — the
    // trap CLAUDE.md records. If this is a string pretending to be a Date, every
    // comparison downstream lies.
    expect(depart?.oldestFireAt).toBeInstanceOf(Date);
  });

  it('refuses a build whose handler is missing for queued work', async () => {
    const worldId = await makeWorld('gap');
    await put(worldId, 'FLIGHT_DEPART');

    const after = await reading();

    expect(after.result.compatible).toBe(false);
    expect(after.gapTypes).toContain('FLIGHT_DEPART');
  });

  it('does not block on history, which would block every deploy forever', async () => {
    // `done` and `failed` rows are never drained again. A FLIGHT_DEPART that
    // failed last month is not a reason to refuse a Worker today, and a gate
    // that thought otherwise would refuse every deploy this repository will ever
    // run, since world_event deletes nothing.
    const before = await reading();
    const worldId = await makeWorld('history');
    await put(worldId, 'FLIGHT_DEPART', 'done');
    await put(worldId, 'FLIGHT_DEPART', 'failed');

    const after = await reading();

    expect(after.actionableOf('FLIGHT_DEPART')).toBe(before.actionableOf('FLIGHT_DEPART'));
    expect(after.gapTypes).toEqual(before.gapTypes);
    expect(after.result.excluded.done).toBe(before.result.excluded.done + 1);
    expect(after.result.excluded.failed).toBe(before.result.excluded.failed + 1);
  });

  it('does not block on work already parked for want of a handler', async () => {
    // Otherwise the pause is self-perpetuating in the worst possible direction:
    // the first Worker that could clear the backlog is precisely the one the
    // gate would refuse, and SCALE-05's requeue could never run.
    const before = await reading();
    const worldId = await makeWorld('parked');
    await put(worldId, 'FLIGHT_DEPART', 'unsupported');

    const after = await reading();

    expect(after.actionableOf('FLIGHT_DEPART')).toBe(before.actionableOf('FLIGHT_DEPART'));
    expect(after.gapTypes).toEqual(before.gapTypes);
    expect(after.result.excluded.unsupported).toBe(before.result.excluded.unsupported + 1);
  });

  it('does not block on pending work in an archived world', async () => {
    // `listTickableWorlds` filters archived worlds out, so the engine will never
    // look at these rows however long they sit there. They are as inert as
    // history, and blocking on them would make archiving a world a way to break
    // every future deploy.
    const before = await reading();
    const worldId = await makeWorld('archived');
    await put(worldId, 'FLIGHT_DEPART');
    await handle.db.update(world).set({ status: 'archived' }).where(eq(world.id, worldId));

    const after = await reading();

    expect(after.actionableOf('FLIGHT_DEPART')).toBe(before.actionableOf('FLIGHT_DEPART'));
    expect(after.gapTypes).toEqual(before.gapTypes);
    expect(after.result.excluded.archived).toBe(before.result.excluded.archived + 1);
  });

  it('refuses exactly the deploy that would park real work', async () => {
    // The acceptance criterion, proven end to end rather than asserted: a deploy
    // must not unknowingly convert valid queued work into parked work.
    //
    // Two halves, and the second is what makes the first mean anything. First
    // the gate refuses. Then the drain the gate was protecting against is run
    // against the very same registry — and it does precisely what the gate said
    // it would. Without this the gate could be right by coincidence; with it,
    // the gate and the runtime are shown to agree about the same rows.
    const worldId = await makeWorld('agreement');
    await put(worldId, 'FLIGHT_DEPART');

    const registry: HandlerRegistry = { FLIGHT_ARRIVE: () => Promise.resolve() };
    const handled = Object.keys(registry) as WorldEventType[];

    const gate = await collectHandlerPreflight(handle.db, handled);
    expect(gate.compatible).toBe(false);
    expect(gate.gaps.map((gap) => gap.type)).toEqual(['FLIGHT_DEPART']);

    const rows = await handle.db
      .select({ id: world.id, epoch: world.epoch, launchDate: world.launchDate })
      .from(world)
      .where(eq(world.id, worldId));
    const row = rows[0];
    if (row === undefined) throw new Error('world vanished');

    const drained = await drainDueEvents(
      handle.db,
      worldId,
      { epoch: row.epoch, launchDate: row.launchDate, speedMultiplier: 1 },
      REAL_NOW,
      registry,
    );

    // The work the gate named is exactly the work the drain parked. Nothing was
    // attempted and nothing failed — but it did not get done either, which is
    // the outcome the refusal exists to prevent.
    expect(drained.unsupported).toBe(1);
    expect(drained.processed).toBe(0);
    expect(drained.failed).toBe(0);

    const after = await handle.db
      .select({ status: worldEvent.status })
      .from(worldEvent)
      .where(eq(worldEvent.worldId, worldId));
    expect(after.map((event) => event.status)).toEqual(['unsupported']);
  });

  it('adds no gap for work the build can do', async () => {
    const before = await reading();
    const worldId = await makeWorld('covered');
    await put(worldId, 'FLIGHT_ARRIVE');
    await put(worldId, 'FLIGHT_ARRIVE');

    const after = await reading();

    // The rows are counted as real work — so this is not passing merely because
    // the query missed them — and they introduce no gap.
    expect(after.actionableOf('FLIGHT_ARRIVE')).toBe(before.actionableOf('FLIGHT_ARRIVE') + 2);
    expect(after.gapTypes).toEqual(before.gapTypes);
  });
});
