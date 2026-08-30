import { seedAircraftCatalogue } from './aircraft/catalogue';
import { buildApp } from './app';
import { createDatabase } from './db/client';
import { seedEconomyConfig } from './economy/seed';
import { loadEnv } from './env';
import { createHeartbeat } from './ops/heartbeat';

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
// Top-level await: the server bundles as ESM, and `buildApp` is async because the
// rate-limit guard must load before the routes it protects (see app.ts).
const app = await buildApp({ env, db });

/**
 * This node, describing itself for the console (OPS-15).
 *
 * Not a scheduled job in ADR-0019's sense — that rule is about who performs work
 * on the world's behalf, and this is a process reporting its own state. It writes
 * only its own row, and two web nodes would produce two rows rather than doing
 * anything twice.
 */
const heartbeat = createHeartbeat({
  db: db.db,
  role: 'web',
  environment: env.environmentLabel,
  onError: (error) => {
    // Logged and swallowed: a node that cannot report is still a node that
    // should serve requests, and the console will show it as stale — which is
    // the correct thing for it to show.
    app.log.warn({ err: error }, 'heartbeat failed');
  },
});

/**
 * The shipped economy, into a database that has never seen it (M3-11).
 *
 * The **web** node's job, and only the web node's: the same rule that makes the
 * web node the only one that migrates. It inserts and never updates, so a deploy
 * cannot move a balance number that an admin has retuned — which is the whole
 * point of §22.3.
 *
 * Before `listen`, because a request that arrives before v1 exists would fail to
 * found an airline. Fatal if it throws: a server whose economy is not in the
 * database is one that cannot price anything, and failing to start is a clearer
 * signal than serving 500s.
 */
async function seedCatalogue(): Promise<void> {
  // The aircraft catalogue, alongside the economy and for the same reasons
  // (M4-01, §22.5). Inserts if absent and never updates, so a deploy cannot
  // change what a running world is flying.
  const result = await seedAircraftCatalogue(db.db);
  app.log.info(
    { version: result.version, inserted: result.inserted, existing: result.existing },
    result.inserted > 0 ? 'aircraft catalogue seeded' : 'aircraft catalogue already present',
  );
}

async function seedEconomy(): Promise<void> {
  const result = await seedEconomyConfig(db.db);
  if (result.inserted) {
    app.log.info({ version: result.version }, 'economy config seeded');
    return;
  }
  if (result.matchesShipped) {
    app.log.info({ version: result.version }, 'economy config already present and matches');
    return;
  }
  // Not corrected, and not fatal. The database's economy was written by a
  // different build, and the database wins — a deploy that silently reverted a
  // live retune would be the failure this design exists to prevent.
  app.log.warn(
    {
      version: result.version,
      stored: result.storedChecksum,
      shipped: result.shippedChecksum,
    },
    'stored economy config differs from the one this build ships; the stored one is in force',
  );
}

try {
  await seedEconomy();
  await seedCatalogue();
  // Bound to loopback by default: Caddy is the only thing that should reach
  // this, and binding 0.0.0.0 would expose it directly if ufw ever lapsed.
  await app.listen({ port, host });
  heartbeat.start();
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
    heartbeat.stop();
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
