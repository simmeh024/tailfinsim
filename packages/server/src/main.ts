import { buildApp } from './app';
import { createDatabase } from './db/client';
import { loadEnv } from './env';

/**
 * Process entry point — the thing systemd runs.
 *
 * Kept deliberately thin: everything interesting is in `app.ts`, which is
 * testable without opening a port. This file's only jobs are to fail fast on
 * bad configuration, listen, and shut down cleanly.
 *
 * M0-09 replaces the holding page with the built client.
 */

const env = loadEnv();
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';

const db = createDatabase();
const app = buildApp({ env, db });

try {
  // Bound to loopback by default: Caddy is the only thing that should reach
  // this, and binding 0.0.0.0 would expose it directly if ufw ever lapsed.
  await app.listen({ port, host });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await db.close().catch(() => undefined);
  process.exit(1);
}

/**
 * Graceful shutdown.
 *
 * `deploy.sh` restarts this process on every release, so this path runs on each
 * deploy rather than only during an outage. Order matters: stop accepting and
 * drain in-flight requests first, *then* close the pool — closing the pool
 * first would fail the requests we are trying to let finish.
 *
 * The unref'd timer is the backstop for a request that never completes; systemd
 * would SIGKILL us at TimeoutStopSec anyway, but exiting on our own terms means
 * the log says what happened.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, 'shutting down');

  const hardExit = setTimeout(() => {
    app.log.error('drain timed out after 10s, exiting anyway');
    process.exit(1);
  }, 10_000);
  hardExit.unref();

  try {
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

/**
 * A rejected promise nobody handled has already broken an invariant somewhere.
 * Logging and exiting lets systemd restart us in a known state rather than
 * leaving the process half-working.
 */
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection');
});
