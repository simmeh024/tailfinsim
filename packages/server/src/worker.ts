import { writeSync } from 'node:fs';

import { createDatabase, type DatabaseHandle } from './db/client';
import {
  collectHandlerPreflight,
  formatHandlerPreflight,
  HANDLER_EXIT_GAP,
  HANDLER_EXIT_UNKNOWN,
} from './engine/handler-preflight';
import { createHandlerRegistry, handledEventTypes } from './engine/handlers';
import { buildWorkerHealthApp } from './engine/health';
import { createSimulationEngine } from './engine/simulation';
import { loadEnv } from './env';
import { errorChain } from './error-chain';
import { createHeartbeat } from './ops/heartbeat';
import { requeueSupportedEvents, unsupportedEvents, type WorldEventType } from './sim/event-queue';

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
 * **Production has no worker**, and giving it one is OPS-12 (#191) — a separate
 * decision on purpose, so the first environment a worker ever ran in was chosen
 * rather than inherited.
 *
 * ## It is also two probes the deploy runs before it starts anything (SCALE-06)
 *
 * `--handled-event-types` and `--handler-preflight` answer, from the built
 * bundle, whether this candidate can do the work the database is already
 * holding. Both return before `engine.start()` and before `app.listen()`, which
 * is the entire point: `/healthz` reports the same gap, but the engine has
 * already drained a tick against the queue by the time the deploy could read it.
 * A check that arrives after the thing it was checking is not a gate.
 */

const MODES = ['--serve', '--handled-event-types', '--handler-preflight'] as const;
const mode = process.argv[2] ?? '--serve';

if (!(MODES as readonly string[]).includes(mode)) {
  process.stderr.write(`usage: node dist/worker.js [${MODES.join('|')}]\n`);
  process.exit(2);
}

/**
 * What this build can handle, and nothing else — no database, no port, no clock.
 *
 * `writeSync` rather than `process.stdout.write`: the deploy reads this through
 * command substitution, which is a pipe, and writes to a pipe are asynchronous
 * on POSIX. `process.exit()` does not flush them, so the obvious spelling can
 * truncate its own output — silently, and only under the exact conditions the
 * caller uses. A gate that reports a short list of handled types would refuse a
 * perfectly good deploy.
 */
if (mode === '--handled-event-types') {
  writeSync(1, `${handledEventTypes().join('\n')}\n`);
  process.exit(0);
}

/**
 * The gate (SCALE-06).
 *
 * Reads only. The report goes to stderr because it is for a person, following
 * `migrate.js` — stdout carries machine-readable answers and stderr carries the
 * explanation — and the exit code is what `deploy.sh` actually branches on.
 *
 * Fails closed on any error. A build that cannot find out whether it can do the
 * work must not be assumed able to do it; that is the whole disposition of this
 * check, and it is why `HANDLER_EXIT_UNKNOWN` is not overridable.
 */
if (mode === '--handler-preflight') {
  // `writeSync` for the same reason as above, and it matters more here: this is
  // the message an operator reads to find out why their deploy stopped, and
  // `process.exit()` does not flush an asynchronous write to a pipe. A deploy
  // run over SSH with its output piped anywhere is exactly that case.
  const say = (line: string): void => {
    writeSync(2, `${line}\n`);
  };

  let handle: DatabaseHandle | null = null;
  let code = 0;

  try {
    // Inside the try, not above it. `createDatabase()` calls `loadEnv()`, which
    // throws on a missing or malformed `DATABASE_URL` — a real and unremarkable
    // way for this to fail on a freshly provisioned node. Constructed outside,
    // that throw would escape as a bare stack trace and exit 1, which
    // `deploy.sh` can only report as "exited 1". It is an unknown answer like
    // any other, and should say so.
    handle = createDatabase();
    const result = await collectHandlerPreflight(handle.db, handledEventTypes());
    for (const line of formatHandlerPreflight(result)) say(line);
    if (!result.compatible) code = HANDLER_EXIT_GAP;
  } catch (error) {
    // `errorChain`, not `error.message`. Drizzle wraps driver errors, so the
    // outer message is the SQL it was running and the reason Postgres actually
    // refused is one level down in `cause` — which means the bare message
    // renders "the tunnel is down", "the password is wrong" and "the table is
    // missing" identically, as a paragraph of select. Three very different
    // 2am problems, and the deploy has just refused to proceed on the strength
    // of it.
    say(`handler preflight failed: ${errorChain(error)}`);
    say(
      'HANDLER PREFLIGHT: UNKNOWN — the queue could not be read, so whether this build can ' +
        'handle the work is unknown. Nothing was changed.',
    );
    code = HANDLER_EXIT_UNKNOWN;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  process.exit(code);
}

const env = loadEnv();

/**
 * The worker's own port, and it is not `PORT`.
 *
 * Sharing the variable with the web process would mean one `.env` copied between
 * roles could make the worker silently bind the web port. Named separately so a
 * mistake is a missing role-specific value rather than a collision. 3100 keeps
 * it clear of both 3000 (production web) and 3001 (dev web), wherever the roles
 * are deployed.
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
 * The registry moved to `engine/handlers.ts` in SCALE-06 and is built here from
 * the same factory the deploy probes call. That is not tidying: the gate is only
 * worth having if it answers for the engine that will actually run, and two
 * lists in two files would eventually disagree — at which point the gate starts
 * approving builds it should refuse.
 *
 * The gap it leaves is announced at boot and carried in `/healthz`, and since
 * SCALE-05 it is no longer dangerous: `drainDueEvents` marks an event of an
 * unhandled type `unsupported` rather than `failed`. Starting this against a
 * queue holding materialised departures pauses that work — excluded from the
 * claim so it cannot starve anything behind it, nothing attempted, nothing
 * destroyed — and the first Worker that ships the handler puts it back
 * (`requeueSupportedEvents` below).
 */
const handlers = createHandlerRegistry();

const engine = createSimulationEngine({
  db: db.db,
  handlers,
  intervalMs,
  log: {
    tick: (report) => {
      // Only ticks that did something. At 1 Hz against an empty queue the log
      // would otherwise be 86,400 lines a day saying nothing happened.
      if (
        report.processed === 0 &&
        report.failed === 0 &&
        report.unsupported === 0 &&
        report.aircraftDelivered === 0
      )
        return;
      app.log.info(
        {
          tick: report.tickNumber,
          worlds: report.worlds,
          processed: report.processed,
          failed: report.failed,
          unsupported: report.unsupported,
          aircraftDelivered: report.aircraftDelivered,
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
    'no handler registered for these event types; events of them are paused as unsupported ' +
      'when drained, and returned to the queue by the first build that can handle them',
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
      unsupported: snapshot.unsupported,
      lastTickAt: snapshot.lastTickAt,
      queueDue: queueSummary.due,
      oldestDueAt: queueSummary.oldestDueAt,
      unhandledEventTypes: snapshot.unhandledEventTypes,
      aircraftDeliveries: snapshot.aircraftDeliveries,
      aircraftDeliveryErrors: snapshot.aircraftDeliveryErrors,
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

/**
 * Put back the work this build can now do (SCALE-05).
 *
 * Before the loop starts, not after: an event returned to `pending` should be
 * claimed by the first tick rather than sit for another interval, and doing it
 * before `engine.start()` means there is no window where a requeued row could
 * be claimed by a half-started engine.
 *
 * Scoped to the types this build actually registers, so a Worker still missing
 * a handler leaves those rows exactly where they are. Failing here must not
 * stop the Worker: an engine that cannot requeue is still an engine that can
 * drain, and the rows are not going anywhere.
 */
async function requeueWhatThisBuildCanHandle(): Promise<void> {
  try {
    const types = Object.keys(handlers) as WorldEventType[];
    const requeued = await requeueSupportedEvents(db.db, types);
    if (requeued > 0) {
      app.log.warn(
        { requeued, types },
        'returned unsupported events to the queue — this build has handlers a previous one did not',
      );
    }

    // Said at boot rather than discovered from the table later. SCALE-06's gate
    // now refuses the deploy that would create this situation, so reaching here
    // with rows listed means one of three things: the operator set
    // ALLOW_HANDLER_GAP, the rows were parked before the gate existed, or they
    // arrived after the preflight ran. All three are worth naming out loud.
    const waiting = await unsupportedEvents(db.db);
    for (const group of waiting) {
      app.log.warn(
        {
          worldId: group.worldId,
          type: group.type,
          count: group.count,
          oldestFireAt: group.oldestFireAt.toISOString(),
        },
        'events waiting for a handler this build does not have',
      );
    }
  } catch (error) {
    app.log.error({ err: error }, 'could not reconcile unsupported events');
  }
}

try {
  await app.listen({ port, host });
  await requeueWhatThisBuildCanHandle();
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
