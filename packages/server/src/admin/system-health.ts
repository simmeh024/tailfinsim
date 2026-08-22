import { asc } from 'drizzle-orm';

import {
  AdminNodeEngine,
  AdminNodeLoad,
  type AdminNodeHealth,
  type AdminUnsupportedEvents,
  type NodeState,
} from '@tailfin/shared';

import { type Database } from '../db/client';
import { nodeHeartbeat, type NodeHeartbeatRow, world } from '../db/schema';
import { HEARTBEAT_INTERVAL_MS } from '../ops/heartbeat';
import { unsupportedEvents } from '../sim/event-queue';

/**
 * The machines, as the console sees them (OPS-15).
 *
 * The overview answers "is anything wrong with the worlds"; this answers "is
 * anything wrong with the things running them". They are different questions,
 * and since OPS-09 they have different answers: the site can be perfectly
 * healthy while the simulation has quietly stopped, and nothing on the front page
 * would look wrong.
 *
 * Every judgement here is made on the server, like the overview's alerts and the
 * world health page's tick state. A browser with a skewed clock must not reach a
 * different conclusion about whether a node is stale (§21).
 */

/**
 * Ages at which a node stops being called online.
 *
 * Three missed heartbeats before `stale`, eight before `offline`. Missing one is
 * ordinary — a slow query, a restart mid-deploy — and calling that a fault would
 * make the page cry wolf during every deploy. Missing three is a pattern.
 */
export const NODE_STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;
export const NODE_OFFLINE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 8;

/**
 * How late the oldest due event may be before a worker is called stuck.
 *
 * Matches `BEHIND_AFTER_MS` on the world health page deliberately: two pages
 * disagreeing about what "behind" means is worse than either threshold being
 * slightly wrong.
 */
export const WORKER_BEHIND_AFTER_MS = 60_000;

function parseLoad(raw: string): AdminNodeLoad {
  const parsed: unknown = JSON.parse(raw);
  // Validated rather than asserted: the column is text, so nothing but this
  // stops a hand-edited row rendering as `undefined%` in the console.
  return AdminNodeLoad.parse(parsed);
}

function parseEngine(raw: string | null): AdminNodeEngine | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return AdminNodeEngine.parse(parsed);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.round(minutes / 60))}h`;
}

/**
 * What state a node is in, and one sentence saying why.
 *
 * Exported and pure so the thresholds can be tested without a database — the
 * judgement is the part worth getting right, and it is the part that has no
 * business needing Postgres to exercise.
 */
export function assessNode(input: {
  role: 'web' | 'worker';
  ageMs: number;
  engine: AdminNodeEngine | null;
  now: Date;
}): { state: NodeState; detail: string } {
  const { role, ageMs, engine } = input;

  if (ageMs > NODE_OFFLINE_AFTER_MS) {
    return {
      state: 'offline',
      detail: `No heartbeat for ${formatDuration(ageMs)}. This node has stopped reporting.`,
    };
  }

  if (ageMs > NODE_STALE_AFTER_MS) {
    return {
      state: 'stale',
      detail: `Last heartbeat ${formatDuration(ageMs)} ago. It may be restarting, or it may be in trouble.`,
    };
  }

  if (role === 'web') {
    return { state: 'online', detail: 'Reporting normally and serving requests.' };
  }

  // A worker is the interesting case: reporting is not the same as working, and
  // this is the distinction no liveness probe can make.
  if (engine === null) {
    return { state: 'stale', detail: 'Reporting, but it has sent no engine state.' };
  }

  if (!engine.running) {
    return {
      state: 'stale',
      detail: 'The process is alive and the engine is stopped. Nothing is being drained.',
    };
  }

  const oldestDue = engine.oldestDueAt === null ? null : Date.parse(engine.oldestDueAt);
  const overdueMs = oldestDue === null ? null : input.now.getTime() - oldestDue;

  if (overdueMs !== null && overdueMs > WORKER_BEHIND_AFTER_MS) {
    return {
      state: 'stale',
      detail: `${String(engine.queueDue)} event(s) due, the oldest for ${formatDuration(overdueMs)}. The engine is running but not keeping up.`,
    };
  }

  if (engine.queueDue > 0) {
    return {
      state: 'online',
      detail: `Draining: ${String(engine.queueDue)} event(s) due, ${String(engine.processed)} processed since start.`,
    };
  }

  // The state the estate is actually in today, and the one most easily
  // misread — so it says which it is rather than leaving a zero to interpret.
  return {
    state: 'online',
    detail:
      engine.processed === 0
        ? `Ticking, with nothing to do: ${String(engine.ticks)} ticks, queue empty.`
        : `Ticking, queue empty. ${String(engine.processed)} event(s) processed since start.`,
  };
}

/** Problems worth stating outright, in the overview's style. */
export function nodeAlerts(
  nodes: AdminNodeHealth[],
  unsupported: AdminUnsupportedEvents[] = [],
): string[] {
  const alerts: string[] = [];

  for (const node of nodes) {
    if (node.state === 'offline') {
      alerts.push(`${node.node} (${node.role}) has stopped reporting.`);
    }
  }

  if (!nodes.some((node) => node.role === 'worker')) {
    // Not a warning about a machine — a statement about the simulation. On a
    // database no worker has ever written to, nothing is advancing any world.
    alerts.push('No worker has ever reported to this database. The simulation is not running.');
  }

  // Independent deployment means web and worker can drift apart. Two build
  // numbers on a page invite the reader to compare them; an alert does it for
  // them, which is the difference between visible and noticed.
  const builds = new Set(
    nodes.filter((node) => node.state !== 'offline').map((node) => node.build),
  );
  if (builds.size > 1) {
    const listed = nodes
      .filter((node) => node.state !== 'offline')
      .map((node) => `${node.node} on ${String(node.build)}`)
      .join(', ');
    alerts.push(`Nodes are running different builds: ${listed}.`);
  }

  const gaps = nodes
    .filter((node) => node.engine !== null && node.engine.unhandledEventTypes.length > 0)
    .map((node) => `${node.node}: ${node.engine?.unhandledEventTypes.join(', ') ?? ''}`);
  if (gaps.length > 0) {
    // Since SCALE-05 this defers work rather than destroying it — an event of an
    // unhandled type is marked `unsupported`, and the first Worker with the
    // handler puts it back. Still worth surfacing: it is a deployment gap, and
    // the pile does not clear itself until somebody ships the handler.
    alerts.push(
      `Event types with no handler — these are paused as unsupported if drained: ${gaps.join('; ')}.`,
    );
  }

  for (const group of unsupported) {
    // Per world and per type, with the age. A total would not be actionable.
    const behind = Math.round((Date.now() - Date.parse(group.oldestFireAt)) / 86_400_000);
    alerts.push(
      `${String(group.count)} ${group.type} events in ${group.worldName} are waiting for a handler; ` +
        `the oldest was due ${String(behind)} days ago in world time.`,
    );
  }

  return alerts;
}

function toNodeHealth(row: NodeHeartbeatRow, now: Date): AdminNodeHealth {
  const engine = parseEngine(row.engine);
  const ageMs = Math.max(0, now.getTime() - row.lastSeenAt.getTime());
  const { state, detail } = assessNode({ role: row.role, ageMs, engine, now });

  return {
    node: row.node,
    role: row.role,
    environment: row.environment,
    state,
    detail,
    build: row.build,
    commit: row.commit,
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    ageMs,
    uptimeSeconds: row.uptimeSeconds,
    load: parseLoad(row.load),
    engine,
  };
}

export interface SystemHealthReport {
  nodes: AdminNodeHealth[];
  serverTime: Date;
  alerts: string[];
  /** Work paused for want of a handler, per world and type (SCALE-05). */
  unsupportedEvents: AdminUnsupportedEvents[];
}

/** Every node this database has heard from, judged against the server's clock. */
export async function buildSystemHealth(
  db: Database,
  now: Date = new Date(),
): Promise<SystemHealthReport> {
  // Ordered by role then name so the page is stable between refreshes: web
  // first, because that is the one a reader looks at when the site is the
  // thing that seems wrong.
  const rows = await db
    .select()
    .from(nodeHeartbeat)
    .orderBy(asc(nodeHeartbeat.role), asc(nodeHeartbeat.node));

  const nodes = rows.map((row) => toNodeHealth(row, now));

  /**
   * Read from the queue, not from a node's counters (SCALE-05).
   *
   * A Worker's `unsupported` count is what *that process* has seen since it
   * started, so a node that has just booted reports zero however much work is
   * waiting. The pile is a property of the database and survives every restart,
   * so the database is what is asked.
   */
  const groups = await unsupportedEvents(db);
  const worldNames = new Map(
    (await db.select({ id: world.id, name: world.name }).from(world)).map((row) => [
      row.id,
      row.name,
    ]),
  );

  const unsupported: AdminUnsupportedEvents[] = groups.map((group) => ({
    worldId: group.worldId,
    worldName: worldNames.get(group.worldId) ?? 'unknown world',
    type: group.type,
    count: group.count,
    oldestFireAt: group.oldestFireAt.toISOString(),
  }));

  return {
    nodes,
    serverTime: now,
    alerts: nodeAlerts(nodes, unsupported),
    unsupportedEvents: unsupported,
  };
}
