import { describe, expect, it, vi } from 'vitest';

import { type WorldClock } from '@tailfin/sim';

import { type Database } from '../db/client';

import { createSimulationEngine, type EngineWorld } from './simulation';

import type { drainDueEvents, DrainResult, HandlerRegistry } from '../sim/event-queue';

/**
 * The engine, without a database and without waiting.
 *
 * Every dependency that reaches Postgres is injected, so what is proved here is
 * the part that is actually this file's: which worlds get driven, that a drain
 * that throws does not stop the clock, that the counters describe what happened,
 * and that stopping waits for work in flight. The queue's own guarantees —
 * ordering, exactly-once, `SKIP LOCKED` — are proved against a real Postgres in
 * `sim/event-queue.test.ts` and are not re-asserted here.
 *
 * `listTickableWorlds` is the one thing in the module that needs a database; its
 * behaviour is asserted through the `where` clause it builds, in
 * `simulation-worlds.test.ts`.
 */

const clock: WorldClock = {
  epoch: new Date('2024-10-20T00:00:00.000Z'),
  launchDate: new Date('2026-08-18T00:00:00.000Z'),
  speedMultiplier: 2,
};

/** The engine only ever hands this to injected functions, so it need not be real. */
const db = {} as Database;

function worldsFixture(...names: string[]): EngineWorld[] {
  return names.map((name, index) => ({ id: `world-${String(index)}`, name, clock }));
}

function drainResult(processed: number, failed = 0, unsupported = 0): DrainResult {
  return { processed, failed, unsupported, upTo: new Date('2024-10-20T00:00:00.000Z') };
}

/**
 * A controllable clock and timer, so the loop runs on demand.
 *
 * The tick loop schedules the next run from the end of the last one via
 * `setTimer`; capturing that callback lets a test advance the loop exactly as
 * many times as it means to, with no real waiting and no flake.
 */
function harness() {
  let nowMs = Date.parse('2026-08-21T12:00:00.000Z');
  const pending: (() => void)[] = [];

  return {
    now: () => new Date(nowMs),
    advance: (ms: number) => {
      nowMs += ms;
    },
    setTimer: (fn: () => void) => {
      pending.push(fn);
      return pending.length;
    },
    clearTimer: () => {
      pending.length = 0;
    },
    /** How many ticks the loop has queued but not yet run. */
    pendingCount: () => pending.length,
    /**
     * Runs the callback the loop scheduled.
     *
     * Call it only once `pendingCount()` is 1. `TickLoop` increments its tick
     * counter at the *start* of a tick and schedules the next one at the end, so
     * waiting for `ticks` to reach N says nothing about whether tick N finished
     * — which is how the first version of these tests fired into an empty queue
     * and then waited for a tick that had never been scheduled.
     */
    fireNextTick(): void {
      pending.shift()?.();
    },
  };
}

describe('which worlds the engine drives', () => {
  it('drains every world it is given, each against its own clock', async () => {
    const drain = vi.fn<typeof drainDueEvents>(() => Promise.resolve(drainResult(1)));
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve(worldsFixture('Flagship', 'Second')),
      drain,
    });

    const report = await engine.runOnce();

    expect(report.worlds).toBe(2);
    expect(report.processed).toBe(2);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(drain.mock.calls.map((call) => call[1])).toEqual(['world-0', 'world-1']);
    // Each world's own clock, not a shared one: two worlds at different speeds
    // disagree about which events are due at the same real instant.
    expect(drain.mock.calls.map((call) => call[2])).toEqual([clock, clock]);
  });

  it('re-reads the world list every tick, so a new world needs no restart', async () => {
    const listWorlds = vi
      .fn<() => Promise<EngineWorld[]>>()
      .mockResolvedValueOnce(worldsFixture('Flagship'))
      .mockResolvedValueOnce(worldsFixture('Flagship', 'Second'));

    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds,
      drain: () => Promise.resolve(drainResult(0)),
    });

    expect((await engine.runOnce()).worlds).toBe(1);
    expect((await engine.runOnce()).worlds).toBe(2);
  });

  it('does nothing at all when there are no worlds', async () => {
    const drain = vi.fn<typeof drainDueEvents>(() => Promise.resolve(drainResult(0)));
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve([]),
      drain,
    });

    const report = await engine.runOnce();

    expect(report.worlds).toBe(0);
    expect(drain).not.toHaveBeenCalled();
  });
});

describe('what the engine reports', () => {
  it('starts stopped, and says so rather than looking healthy', () => {
    const engine = createSimulationEngine({ db, handlers: {} });
    const snapshot = engine.snapshot();

    // The trap this repo already documented: "ticks: 0, errors: 0" reads as
    // healthy and quiet when it means nothing has run. The status is what
    // distinguishes them.
    expect(snapshot.status).toBe('stopped');
    expect(snapshot.ticks).toBe(0);
    expect(snapshot.startedAt).toBeNull();
    expect(snapshot.lastTickAt).toBeNull();
  });

  it('accumulates what was processed and what was refused', async () => {
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve(worldsFixture('Flagship')),
      drain: () => Promise.resolve(drainResult(3, 1)),
    });

    await engine.runOnce();
    await engine.runOnce();

    const snapshot = engine.snapshot();
    expect(snapshot.processed).toBe(6);
    expect(snapshot.failed).toBe(2);
    expect(snapshot.worlds).toBe(1);
  });

  it('sweeps real-time aircraft deliveries for every tickable world', async () => {
    const deliverAircraft = vi.fn((_db: Database, worldId: string) =>
      Promise.resolve({ delivered: worldId === 'world-0' ? 2 : 1 }),
    );
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve(worldsFixture('Flagship', 'Second')),
      drain: () => Promise.resolve(drainResult(0)),
      deliverAircraft,
    });

    const report = await engine.runOnce();

    expect(report.aircraftDelivered).toBe(3);
    expect(engine.snapshot().aircraftDeliveries).toBe(3);
    expect(engine.snapshot().aircraftDeliveryErrors).toBe(0);
    expect(deliverAircraft.mock.calls.map((call) => call[1])).toEqual(['world-0', 'world-1']);
  });

  it('names the event types it has no handler for', () => {
    const engine = createSimulationEngine({ db, handlers: {} });

    // Every type, because this registry is empty. The point is that the gap is
    // reported rather than discovered later from a table full of failed rows.
    expect(engine.snapshot().unhandledEventTypes).toEqual([
      'FLIGHT_DEPART',
      'FLIGHT_ARRIVE',
      'TURNAROUND_COMPLETE',
    ]);
  });

  it('reports an empty gap once every type is handled', () => {
    const noop = () => Promise.resolve();
    const handlers: HandlerRegistry = {
      FLIGHT_DEPART: noop,
      FLIGHT_ARRIVE: noop,
      TURNAROUND_COMPLETE: noop,
    };

    expect(createSimulationEngine({ db, handlers }).snapshot().unhandledEventTypes).toEqual([]);
  });
});

describe('the loop', () => {
  it('runs, counts and stops', async () => {
    const timers = harness();
    const engine = createSimulationEngine({
      db,
      handlers: {},
      intervalMs: 1_000,
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      listWorlds: () => Promise.resolve(worldsFixture('Flagship')),
      drain: () => Promise.resolve(drainResult(1)),
    });

    engine.start();
    await vi.waitFor(() => {
      expect(engine.snapshot().ticks).toBe(1);
    });
    expect(engine.snapshot().status).toBe('running');

    await vi.waitFor(() => {
      expect(timers.pendingCount()).toBe(1);
    });
    timers.fireNextTick();
    await vi.waitFor(() => {
      expect(engine.snapshot().ticks).toBe(2);
    });

    await engine.stop();
    expect(engine.snapshot().status).toBe('stopped');
    expect(engine.snapshot().processed).toBe(2);
  });

  it('keeps the clock running when a drain throws, and counts it', async () => {
    const timers = harness();
    const errors: unknown[] = [];
    let call = 0;
    const engine = createSimulationEngine({
      db,
      handlers: {},
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      listWorlds: () => Promise.resolve(worldsFixture('Flagship')),
      drain: () => {
        call += 1;
        // A world whose database call fails must not take the other worlds — or
        // the next tick — down with it.
        if (call === 1) return Promise.reject(new Error('connection terminated'));
        return Promise.resolve(drainResult(1));
      },
      log: {
        error: (error) => errors.push(error),
      },
    });

    engine.start();
    await vi.waitFor(() => {
      expect(engine.snapshot().errors).toBe(1);
    });
    expect(errors).toHaveLength(1);

    await vi.waitFor(() => {
      expect(timers.pendingCount()).toBe(1);
    });
    timers.fireNextTick();
    await vi.waitFor(() => {
      expect(engine.snapshot().processed).toBe(1);
    });

    await engine.stop();
  });

  it('waits for a tick already in flight before it reports stopped', async () => {
    const timers = harness();
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;

    const engine = createSimulationEngine({
      db,
      handlers: {},
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      listWorlds: () => Promise.resolve(worldsFixture('Flagship')),
      drain: async () => {
        await inFlight;
        finished = true;
        return drainResult(1);
      },
    });

    engine.start();
    const stopping = engine.stop();
    release?.();
    await stopping;

    // The difference between a clean SIGTERM and an event applied halfway: the
    // pool must not close underneath a transaction that is still open.
    expect(finished).toBe(true);
  });

  it('ignores a second start', async () => {
    const timers = harness();
    const engine = createSimulationEngine({
      db,
      handlers: {},
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      listWorlds: () => Promise.resolve([]),
      drain: () => Promise.resolve(drainResult(0)),
    });

    engine.start();
    engine.start();
    await vi.waitFor(() => {
      expect(engine.snapshot().ticks).toBe(1);
    });

    await engine.stop();
  });
});

describe('queue depth', () => {
  it('is reported per world, by name', async () => {
    const oldest = new Date('2024-10-21T09:00:00.000Z');
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve(worldsFixture('Flagship', 'Second')),
      depth: (_db, worldId) =>
        Promise.resolve(
          worldId === 'world-0' ? { due: 4, oldestDueAt: oldest } : { due: 0, oldestDueAt: null },
        ),
    });

    expect(await engine.queues()).toEqual([
      { worldId: 'world-0', name: 'Flagship', due: 4, oldestDueAt: oldest },
      { worldId: 'world-1', name: 'Second', due: 0, oldestDueAt: null },
    ]);
  });

  it('is kept out of the snapshot, so health can answer without a database', async () => {
    let asked = 0;
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve(worldsFixture('Flagship')),
      drain: () => Promise.resolve(drainResult(0)),
      depth: () => {
        asked += 1;
        return Promise.resolve({ due: 0, oldestDueAt: null });
      },
    });

    await engine.runOnce();
    engine.snapshot();

    // The reason `/healthz` can say "the engine is up and Postgres is not":
    // neither ticking nor describing itself asks the queue how deep it is.
    expect(asked).toBe(0);

    await engine.queues();
    expect(asked).toBe(1);
  });
});

describe('crew conversions on the tick', () => {
  /*
   * M5-02 put two more crew sweeps on the tick. They are stubbed here rather
   * than left to the real ones because the real ones read the world's economy
   * config, which this fake database does not have -- and the resulting failure
   * would be counted in `crewErrors`, which is exactly what these tests assert
   * on. `duty-store.test.ts` proves what the sweeps do.
   */
  const quietDuty = {
    standDownCrew: () => Promise.resolve({ stoodDown: 0 }),
    returnCrew: () => Promise.resolve({ returned: 0 }),
  };

  /**
   * M5-01. Crew put into a type conversion come back out on the worker's tick,
   * against the world's own clock — so this proves the engine calls the sweep at
   * all, which is the part production does not have. `store.test.ts` proves what
   * the sweep does to the rows.
   */
  it('completes conversions for every tickable world and counts them', async () => {
    const completeConversions = vi.fn((_db: Database, _worldId: string, _at: Date) =>
      Promise.resolve({ completed: 2 }),
    );
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve(worldsFixture('Flagship', 'Second')),
      drain: () => Promise.resolve(drainResult(0)),
      completeConversions,
      ...quietDuty,
    });

    const report = await engine.runOnce();

    expect(completeConversions).toHaveBeenCalledTimes(2);
    expect(report.crewConversionsCompleted).toBe(4);
    expect(report.crewErrors).toBe(0);
  });

  it('sweeps against game time, not wall time', async () => {
    const completeConversions = vi.fn((_db: Database, _worldId: string, _at: Date) =>
      Promise.resolve({ completed: 0 }),
    );
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve(worldsFixture('Flagship')),
      drain: () => Promise.resolve(drainResult(0)),
      completeConversions,
      ...quietDuty,
    });

    await engine.runOnce();

    // A fortnight of training is a span in the world's calendar, so the instant
    // handed to the sweep has to be the world's, not the operating system's.
    const at = completeConversions.mock.calls[0]?.[2];
    if (at === undefined) throw new Error('the sweep was never called');
    expect(at.getTime()).toBeGreaterThanOrEqual(clock.epoch.getTime());
    expect(at.getFullYear()).toBe(clock.epoch.getFullYear());
  });

  it('keeps draining when the crew sweep throws', async () => {
    // Crew who could not be released this tick are released the next one. A
    // flight that never settles is money that never moves, so the queue wins.
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve(worldsFixture('Flagship')),
      drain: () => Promise.resolve(drainResult(3)),
      completeConversions: () => Promise.reject(new Error('no')),
      ...quietDuty,
    });

    const report = await engine.runOnce();

    expect(report.crewErrors).toBe(1);
    expect(report.crewConversionsCompleted).toBe(0);
    expect(report.processed).toBe(3);
  });
});
