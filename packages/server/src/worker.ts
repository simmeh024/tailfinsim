import { createDatabase } from './db/client';
import { buildWorkerHealthApp } from './engine/health';
import { createSimulationEngine } from './engine/simulation';
import { loadEnv } from './env';
import { createFlightArriveHandler } from './flight/settle';
import { createHeartbeat } from './ops/heartbeat';
import { type HandlerRegistry } from './sim/event-queue';

/**
 * The worker process — the second thing systemd runs (OPS-08).
 *
 * A separate entry point rather than a `WORKER_ENABLED` flag on `main.ts`. The
 * flag would produce one binary that is sometimes both, and "sometimes both" is
 * precisely the state the boundary exists to prevent: the first person to need a
 * scheduled job would set the flag on the web node and nobody would find out
 * until it ran twice. Two entry points make "web without worker" and "worker
 * without web" the default rather than a configuration. See ADR-0019.
 *
 * Thin, exactly like `main.ts`: fail fast on bad configuration, start the engine,
 * open one loopback port, shut down cleanly. Everything worth testing is in
 * `engine/`.
 *
 * ## Where this runs
 *
 * Dev only, as `tailfin-dev-worker.service` on `tailfin-dev-worker-01` (OPS-09).
 * **Production has no worker**, and giving it one is OPS-11 (#191) — a separate
 * decision on purpose, so the first environment a worker ever ran in was chosen
 * rather than inherited.
 */

const env = loadEnv();

/**
 * The worker's own port, and it is not `PORT`.
 *
 * Sharing the variable with the web process would mean one `.env` copied to a
 * worker node silently binding the web port, or two services on one box fighting
 * over 3000. Named separately so a mistake is a missing variable rather than a
 * collision. 3100 keeps it clear of both 3000 (production web) and 3001 (dev).
 */
const port = Number.parseInt(process.env.WORKER_HEALTH_PORT ?? '3100', 10);

/**
 * Loopback, and unlike the web process this is not merely a sensible default.
 *
 * `main.ts` binds loopback because Caddy is the only thing that should reach it.
 * Here there is no Caddy vhost at all and there must never be one: the endpoint
 * is unauthenticated and describes the shape of the simulation. `HOST` is
 * deliberately not consulted — the web process's variable must not be able to
 * expose this one.
 */
const host = process.env.WORKER_HEALTH_HOST ?? '127.0.0.1';

const intervalMs = Number.parseInt(process.env.WORKER_TICK_INTERVAL_MS ?? '1000', 10);

const db = createDatabase();

/**
 * What this process can actually handle.
 *
 * One entry today. `FLIGHT_DEPART` is scheduled by `schedule/store.ts` when
 * flights are materialised and `TURNAROUND_COMPLETE` by nothing yet, and neither
 * has a handler — departure is M2/M4 behaviour and inventing one here would be
 * exactly the accidental decision this boundary exists to prevent.
 *
 * The gap is announced at boot and carried in `/healthz`, because
 * `drainDueEvents` marks an event of an unhandled type `failed`: start this
 * against a queue holding materialised departures and it will mark every one of
 * them failed on the first tick. That is recoverable — the rows are still there
 * for when the handler ships — but it is not something to discover from the
 * table afterwards.
 */
const handlers: HandlerRegistry = {
  FLIGHT_ARRIVE: createFlightArriveHandler(),
};

const engine = createSimulationEngine({
  db: db.db,
  handlers,
  intervalMs,
  log: {
    tick: (report) => {
      // Only ticks that did something. At 1 Hz against an empty queue the log
      // would otherwise be 86,400 lines a day saying nothing happened.
      if (report.processed === 0 && report.failed === 0) return;
      app.log.info(
        {
          tick: report.tickNumber,
          worlds: report.worlds,
          processed: report.processed,
          failed: report.failed,
          durationMs: report.durationMs,
        },
        'tick',
      );
    },
    warn: (message) => {
      app.log.warn(message);
    },
    error: (error) => {
      app.log.error({ err: error }, 'tick failed');
    },
  },
});

const app = buildWorkerHealthApp({
  engine,
  environmentLabel: env.environmentLabel,
  logLevel: env.logLevel,
  pingDatabase: async () => {
    await db.pool.query('select 1');
  },
});

const unhandled = engine.snapshot().unhandledEventTypes;
if (unhandled.length > 0) {
  app.log.warn(
    { unhandledEventTypes: unhandled },
    'no handler registered for these event types; events of them will be marked failed when drained',
  );
}

/**
 * The worker's own report, and the only way the console learns anything about
 * this machine (OPS-15).
 *
 * `/healthz` here is loopback-only on a host whose firewall allows nothing but
 * SSH, so nothing can poll it from outside. The engine state therefore travels
 * the same way everything else does between these processes: through the
 * database. Queue depth is asked per beat rather than per tick — once every
 * fifteen seconds, not once a second.
 */
const heartbeat = createHeartbeat({
  db: db.db,
  role: 'worker',
  environment: env.environmentLabel,
  engine: () => {
    const snapshot = engine.snapshot();
    return {
      running: snapshot.status === 'running',
      ticks: snapshot.ticks,
      errors: snapshot.errors,
      lateTicks: snapshot.lateTicks,
      processed: snapshot.processed,
      failed: snapshot.failed,
      lastTickAt: snapshot.lastTickAt,
      queueDue: queueSummary.due,
      oldestDueAt: queueSummary.oldestDueAt,
      unhandledEventTypes: snapshot.unhandledEventTypes,
    };
  },
  onError: (error) => {
    app.log.warn({ err: error }, 'heartbeat failed');
  },
});

/**
 * Queue depth, refreshed alongside the heartbeat rather than inside it.
 *
 * `engine.queues()` asks Postgres a question per world, and the heartbeat's own
 * callback has to be synchronous. Refreshing here keeps the beat cheap and means
 * a database blip costs a stale number rather than a missed heartbeat.
 */
let queueSummary: { due: number; oldestDueAt: string | null } = { due: 0, oldestDueAt: null };

async function refreshQueueSummary(): Promise<void> {
  try {
    const queues = await engine.queues();
    const oldest = queues
      .map((entry) => entry.oldestDueAt)
      .filter((value): value is Date => value !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    queueSummary = {
      due: queues.reduce((total, entry) => total + entry.due, 0),
      oldestDueAt: oldest?.toISOString() ?? null,
    };
  } catch {
    // Left as it was. The heartbeat still reports; the number is simply the
    // last one known, and `lastSeenAt` is what says whether it is current.
  }
}

try {
  await app.listen({ port, host });
  engine.start();
  await refreshQueueSummary();
  heartbeat.start();
  const queueTimer = setInterval(() => void refreshQueueSummary(), 15_000);
  queueTimer.unref();
  app.log.info(
    { environment: env.environmentLabel, intervalMs, host, port },
    'simulation engine started',
  );
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await db.close().catch(() => undefined);
  process.exit(1);
}

/**
 * Graceful shutdown.
 *
 * Order matters and differs from the web process's. Stop the engine **first**:
 * `stop()` waits for a tick already inside a transaction to finish, and closing
 * the pool underneath it would abort a half-applied event rather than let it
 * commit. Only then close the health port and the pool.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, 'shutting down');

  const hardExit = setTimeout(() => {
    app.log.error('engine did not stop within 15s, exiting anyway');
    process.exit(1);
  }, 15_000);
  hardExit.unref();

  try {
    heartbeat.stop();
    await engine.stop();
    await app.close();
    await db.close();
    app.log.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection');
});
