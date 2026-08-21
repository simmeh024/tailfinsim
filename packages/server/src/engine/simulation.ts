import { asc, ne } from 'drizzle-orm';

import { type WorldClock } from '@tailfin/sim';

import { type Database } from '../db/client';
import { world, type WorldRow } from '../db/schema';
import {
  drainDueEvents,
  queueDepth,
  type HandlerRegistry,
  type WorldEventType,
} from '../sim/event-queue';
import { createTickLoop, type TickLoop } from '../sim/tick';

/**
 * The simulation engine — what the worker process is *for* (OPS-08, §21).
 *
 * `createTickLoop` and `drainDueEvents` have both existed, tested, since M1-06,
 * and until now nothing anywhere called either of them. This is the thing that
 * calls them, and it lives here rather than in `app.ts` because the web process
 * must never acquire a heartbeat by convenience — ADR-0019 records the boundary
 * and `eslint.config.js` is what enforces it.
 *
 * Kept separate from `worker.ts` for the same reason `app.ts` is separate from
 * `main.ts`: everything interesting should be testable without a process, a port
 * or a signal handler.
 *
 * ## One loop, every world
 *
 * A loop per world is the obvious shape and the wrong one. Worlds are created,
 * reset and archived while the process runs, so the set is not known at start,
 * and N loops means N timers to reconcile against a table that changes underneath
 * them. One loop that re-reads the world list each tick is simpler and correct by
 * construction: a world created a second ago is drained a second later, and an
 * archived one stops being drained without anything having to be cancelled.
 *
 * The cost is one indexed `select` per tick against a table with single-digit
 * rows. That is not a cost.
 */

/** A world the engine will drive, with the clock its events are due against. */
export interface EngineWorld {
  id: string;
  name: string;
  clock: WorldClock;
}

/**
 * What one tick did.
 *
 * Reported per tick as well as accumulated, because "processed 400 events since
 * Tuesday" and "processed 400 events in the last second" are different
 * situations, and only one of them is interesting.
 */
export interface TickReport {
  tickNumber: number;
  tickedAt: Date;
  durationMs: number;
  worlds: number;
  processed: number;
  failed: number;
}

export interface EngineLog {
  tick?: (report: TickReport) => void;
  error?: (error: unknown) => void;
  warn?: (message: string) => void;
}

export interface SimulationEngineOptions {
  db: Database;

  /**
   * The handler for each kind of scheduled event.
   *
   * Passed in rather than looked up here, so the process that owns the engine
   * decides what it is able to do and a test can drive it with nothing at all.
   * `worker.ts` assembles the real registry and says out loud which types it
   * cannot handle.
   */
  handlers: HandlerRegistry;

  /** Real milliseconds between ticks. The coarse tick of §21 is 1000. */
  intervalMs?: number;

  log?: EngineLog;

  /** Injected in tests, so nothing waits in real time and no database is needed. */
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  listWorlds?: (db: Database) => Promise<EngineWorld[]>;
  drain?: typeof drainDueEvents;
  depth?: typeof queueDepth;
}

/**
 * Everything a monitor can learn without touching the database.
 *
 * Deliberately a plain snapshot of in-memory counters. The worker's `/healthz`
 * has to be able to answer while Postgres is unreachable, because "the engine is
 * up and the database is not" is exactly the state somebody needs telling about,
 * and a health endpoint that needs a query to describe itself cannot say it.
 */
export interface EngineSnapshot {
  status: 'stopped' | 'running';
  startedAt: string | null;
  /** Ticks attempted, including any that threw. */
  ticks: number;
  /** Ticks that threw. A rising count is the signal that something is wrong. */
  errors: number;
  /** Ticks that overran the interval. */
  lateTicks: number;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  /** Worlds driven on the last tick. */
  worlds: number;
  /** Events handled, and events refused, since this process started. */
  processed: number;
  failed: number;
  /**
   * Event types with no handler registered in this process.
   *
   * Not empty today, and saying so is the point. `drainDueEvents` marks an event
   * of an unhandled type `failed` rather than `done`, reasoning that an unhandled
   * type is a deployment problem and the row should still be there when the
   * handler ships. That is the right behaviour, and it is also a loaded gun:
   * start an engine against a queue full of a type it cannot handle and every one
   * of those rows is marked failed on the first tick. So the gap is carried in
   * the health output rather than discovered afterwards from the table.
   */
  unhandledEventTypes: WorldEventType[];
}

export interface QueueDepthByWorld {
  worldId: string;
  name: string;
  due: number;
  oldestDueAt: Date | null;
}

export interface SimulationEngine {
  start: () => void;
  stop: () => Promise<void>;
  /** One tick, run inline. The engine need not have been started; used by tests. */
  runOnce: () => Promise<TickReport>;
  snapshot: () => EngineSnapshot;
  /** Queue depth per world. Hits the database, so it is not part of the snapshot. */
  queues: () => Promise<QueueDepthByWorld[]>;
}

/**
 * Every type the queue can carry.
 *
 * Listed rather than derived so that a missing handler is a known list rather
 * than a surprise — and so that adding a type to `WorldEventType` without
 * deciding who handles it fails to compile here.
 */
const ALL_EVENT_TYPES: readonly WorldEventType[] = [
  'FLIGHT_DEPART',
  'FLIGHT_ARRIVE',
  'TURNAROUND_COMPLETE',
];

function clockOf(row: WorldRow): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    // `numeric` arrives as a string; the clock wants a number.
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/**
 * Every world whose clock is still running.
 *
 * All four statuses except `archived`. `staging` and `locked` both look like
 * candidates for exclusion and neither is: a staging world's clock is derived
 * from its epoch and launch date exactly like an open one's, and locking
 * deliberately stops *play* without stopping the clock — an aircraft in the air
 * when a world locks is still in the air when it reopens, which is only true if
 * its arrival still fires. Archived is the status that means "a record of what
 * happened", and draining one would keep changing the record.
 */
export async function listTickableWorlds(db: Database): Promise<EngineWorld[]> {
  const rows = await db
    .select()
    .from(world)
    .where(ne(world.status, 'archived'))
    .orderBy(asc(world.createdAt));

  return rows.map((row) => ({ id: row.id, name: row.name, clock: clockOf(row) }));
}

export function createSimulationEngine(options: SimulationEngineOptions): SimulationEngine {
  const {
    db,
    handlers,
    intervalMs = 1_000,
    log,
    now = () => new Date(),
    setTimer,
    clearTimer,
    listWorlds = listTickableWorlds,
    drain = drainDueEvents,
    depth = queueDepth,
  } = options;

  const unhandledEventTypes = ALL_EVENT_TYPES.filter((type) => handlers[type] === undefined);

  let startedAt: Date | null = null;
  let lastTickAt: Date | null = null;
  let lastTickDurationMs: number | null = null;
  let lastWorldCount = 0;
  let processed = 0;
  let failed = 0;

  async function tick(context: { tickedAt: Date; tickNumber: number }): Promise<TickReport> {
    const worlds = await listWorlds(db);
    let tickProcessed = 0;
    let tickFailed = 0;

    for (const entry of worlds) {
      // Each world is drained against its own clock: `fire_at` is a game-time
      // instant, so what is due depends on where that world's clock has got to,
      // and two worlds at different speeds disagree about the same moment.
      const result = await drain(db, entry.id, entry.clock, now(), handlers, {
        log: (line) => {
          log?.warn?.(`[${entry.name}] ${line}`);
        },
      });
      tickProcessed += result.processed;
      tickFailed += result.failed;
    }

    const durationMs = now().getTime() - context.tickedAt.getTime();

    processed += tickProcessed;
    failed += tickFailed;
    lastTickAt = context.tickedAt;
    lastTickDurationMs = durationMs;
    lastWorldCount = worlds.length;

    return {
      tickNumber: context.tickNumber,
      tickedAt: context.tickedAt,
      durationMs,
      worlds: worlds.length,
      processed: tickProcessed,
      failed: tickFailed,
    };
  }

  const loop: TickLoop = createTickLoop({
    intervalMs,
    now,
    setTimer,
    clearTimer,
    onTick: async (context) => {
      const report = await tick(context);
      log?.tick?.(report);
    },
    onError: (error) => {
      log?.error?.(error);
    },
  });

  return {
    start(): void {
      if (loop.running) return;
      startedAt = now();
      loop.start();
    },

    async stop(): Promise<void> {
      // Awaited: `TickLoop.stop` returns once no tick is still mid-transaction,
      // which is the difference between a clean SIGTERM and a half-applied event.
      await loop.stop();
      startedAt = null;
    },

    runOnce(): Promise<TickReport> {
      return tick({ tickedAt: now(), tickNumber: loop.ticks + 1 });
    },

    snapshot(): EngineSnapshot {
      return {
        status: loop.running ? 'running' : 'stopped',
        startedAt: startedAt?.toISOString() ?? null,
        ticks: loop.ticks,
        errors: loop.errors,
        lateTicks: loop.lateTicks,
        lastTickAt: lastTickAt?.toISOString() ?? null,
        lastTickDurationMs,
        worlds: lastWorldCount,
        processed,
        failed,
        unhandledEventTypes,
      };
    },

    async queues(): Promise<QueueDepthByWorld[]> {
      const worlds = await listWorlds(db);
      const depths: QueueDepthByWorld[] = [];
      for (const entry of worlds) {
        const measured = await depth(db, entry.id, entry.clock, now());
        depths.push({ worldId: entry.id, name: entry.name, ...measured });
      }
      return depths;
    },
  };
}
