import { hostname, loadavg, cpus, totalmem, freemem } from 'node:os';

import { type AdminNodeEngine, type AdminNodeLoad, type NodeRole } from '@tailfin/shared';

import { readBuildInfo } from '../build-info';
import { type Database } from '../db/client';
import { nodeHeartbeat } from '../db/schema';
import { type EnvironmentLabel } from '../env';

/**
 * Each node, describing itself into the database (OPS-15).
 *
 * ## Why the node writes rather than the console reading
 *
 * The admin console runs in the web process and cannot reach the worker's health
 * endpoint — that endpoint binds loopback on another machine whose firewall
 * allows only SSH and whose unit carries `IPAddressDeny=any`. That is deliberate,
 * so the console must learn about the worker some other way, and ADR-0019 already
 * named it: the database is the channel between the processes.
 *
 * The direction of trust is the point. The web application opens no connection to
 * another host and holds no credential for one. A node that stops writing is
 * **detected as stale** rather than merely unreachable, which is the stronger
 * statement — it does not depend on the console's own network path being healthy.
 *
 * ## Why this is not a scheduled job
 *
 * The web process runs this on a timer, and ADR-0019 says a scheduled job has
 * exactly one owner and it is the worker. No contradiction: a heartbeat is a
 * process describing itself, not work being performed on the world's behalf. It
 * touches only this node's own row, it is idempotent, and running it twice from
 * two web nodes produces two rows rather than double work. The rule exists so
 * that *game* work has one owner; self-description has as many owners as there
 * are selves.
 *
 * It deliberately does not use `createTickLoop` — that is the engine's loop and
 * lint forbids the web process importing it. A plain unref'd interval is the
 * right size for this.
 */

/** How often a node reports. Fast enough that a stall is visible within a minute. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * What this machine is currently carrying.
 *
 * `loadavg` is the machine's, `memoryUsage().rss` is this process's. Both are
 * wanted: a worker pinning the box matters, and so does a worker leaking while
 * the box looks fine. On Windows `loadavg` returns zeroes — irrelevant on the
 * server, but it means a local run reports 0% rather than something wrong.
 */
export function captureLoad(): AdminNodeLoad {
  const cores = Math.max(1, cpus().length);
  const [load1 = 0] = loadavg();
  const total = totalmem();
  const free = freemem();

  return {
    // Normalised by core count so two differently-sized nodes are comparable.
    cpuPercent: Math.round((load1 / cores) * 1000) / 10,
    loadAverage1m: Math.round(load1 * 100) / 100,
    cores,
    processMemoryBytes: process.memoryUsage().rss,
    memoryUsedPercent: total === 0 ? 0 : Math.round(((total - free) / total) * 1000) / 10,
    memoryTotalBytes: total,
  };
}

/**
 * What identifies a node: its hostname **and its role**.
 *
 * The hostname alone is not enough, and the first deployment proved it. One host
 * can run more than one Tailfin process — the web box already runs production
 * and dev side by side, and OPS-09's original plan was a worker as a second
 * service on the dev box. Two such processes writing to one database would share
 * a primary key and overwrite each other's row, and the console would show a
 * single node flapping between two roles rather than two nodes.
 *
 * Environment is deliberately not part of it: a database only ever holds one
 * environment's nodes, so adding it would pad the name without disambiguating
 * anything.
 */
export function nodeIdentity(role: NodeRole, host: string = hostname()): string {
  return `${host}/${role}`;
}

export interface HeartbeatOptions {
  db: Database;
  role: NodeRole;
  environment: EnvironmentLabel;
  /** Overridden in tests. Defaults to `nodeIdentity(role)`. */
  node?: string;
  startedAt?: Date;
  /** A worker supplies this; a web node has no engine and must not report one. */
  engine?: () => AdminNodeEngine;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface Heartbeat {
  /** Writes one row. Exposed so a test can beat without waiting. */
  beat: () => Promise<void>;
  start: () => void;
  stop: () => void;
}

export function createHeartbeat(options: HeartbeatOptions): Heartbeat {
  const {
    db,
    role,
    environment,
    node = nodeIdentity(role),
    startedAt = new Date(),
    engine,
    now = () => new Date(),
    onError,
  } = options;

  const build = readBuildInfo();
  let timer: NodeJS.Timeout | null = null;

  async function beat(): Promise<void> {
    const at = now();
    const engineState = engine?.() ?? null;

    const row = {
      node,
      role,
      environment,
      build: build.build,
      commit: build.commit,
      startedAt,
      lastSeenAt: at,
      uptimeSeconds: Math.max(0, Math.floor((at.getTime() - startedAt.getTime()) / 1000)),
      load: JSON.stringify(captureLoad()),
      engine: engineState === null ? null : JSON.stringify(engineState),
    };

    // Upsert on the node name: a heartbeat is current state, not history, so the
    // table stays the size of the estate rather than growing forever.
    await db
      .insert(nodeHeartbeat)
      .values(row)
      .onConflictDoUpdate({ target: nodeHeartbeat.node, set: row });
  }

  return {
    beat,

    start(): void {
      if (timer !== null) return;
      // Written immediately so a freshly started node appears in the console at
      // once rather than after the first interval.
      void beat().catch((error: unknown) => onError?.(error));

      timer = setInterval(() => {
        // A failed heartbeat must not take the process down, and must not stop
        // future ones: the database being briefly unreachable is exactly when a
        // node most wants to resume reporting afterwards.
        void beat().catch((error: unknown) => onError?.(error));
      }, HEARTBEAT_INTERVAL_MS);

      // Unref'd: this timer must never be the reason the process stays alive.
      timer.unref();
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
