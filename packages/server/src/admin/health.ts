import { asc, count, desc, eq, max, min, sql } from 'drizzle-orm';

import {
  type AdminDatasetVersion,
  type AdminTickState,
  type AdminWorldHealth,
} from '@tailfin/shared';
import { gameTime, gameToRealMs, type WorldClock } from '@tailfin/sim';

import { type Database } from '../db/client';
import { airline, datasetVersion, world, worldEvent, type WorldRow } from '../db/schema';

/**
 * Whether a world is actually running (M1A-06, design doc §21).
 *
 * The first question after opening a world is whether anything is happening in
 * it, and that should be answerable at a glance rather than from psql.
 *
 * ## Liveness is inferred from the queue, not read from the loop
 *
 * The issue asks for the tick loop's own counters — `ticks`, `errors`,
 * `lateTicks` — which `createTickLoop` does keep. They are not used here, for
 * two reasons that both point the same way:
 *
 *   1. **Nothing starts the loop.** `createTickLoop` is built and tested, and no
 *      process calls it in any environment. Counters from a loop that does not
 *      run would report zero ticks and zero errors, which reads as "healthy and
 *      quiet" — the most misleading thing this page could say.
 *   2. **The loop is going to live somewhere else.** OPS-08 (#187) puts the
 *      simulation in a separate worker process; in-memory counters on that node
 *      are not readable from the web node serving this page.
 *
 * What the queue shows works in all three worlds: today with no loop, tomorrow
 * with a loop in one process, and later with a loop on another machine. It needs
 * no new table and no heartbeat.
 *
 * ## What is not here
 *
 * The issue also asks for aircraft and airborne flights. There are no such
 * tables — flights arrive with M2 and aircraft with M4 — and reporting them as
 * zero would describe a working simulation with nothing flying rather than a
 * simulation that does not exist yet. The console says which, rather than
 * showing a confident nought.
 */

/**
 * How late the oldest due event may be before a world is called `behind`.
 *
 * One minute, matching the acceptance criterion that a stalled loop is visible
 * within a minute. Real time, not game time: the question is whether the loop is
 * keeping up with the wall clock.
 */
export const BEHIND_AFTER_MS = 60_000;

function clockOf(row: WorldRow): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/** Normalises what a raw aggregate actually returns — see `queueDepth`'s note. */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * The judgement, made on the server.
 *
 * §21 puts decisions about whether something is wrong on the server rather than
 * in the browser: a viewer with a skewed clock must not reach a different
 * conclusion about whether a world is stalled.
 */
export function assessTick(input: {
  pending: number;
  overdueRealMs: number | null;
  lastProcessedAt: Date | null;
  now: Date;
}): { state: AdminTickState; detail: string } {
  const { pending, overdueRealMs, lastProcessedAt, now } = input;

  if (pending === 0 && lastProcessedAt === null) {
    return {
      state: 'no_events',
      detail: 'Nothing has ever been scheduled in this world. There is nothing for a tick to do.',
    };
  }

  if (overdueRealMs === null) {
    return {
      state: 'idle',
      detail:
        pending === 0
          ? 'The queue is empty. Everything scheduled so far has been handled.'
          : `${String(pending)} scheduled, none due yet.`,
    };
  }

  // Something is due. Whether that is fine depends on how long it has been due
  // and whether anything is being processed at all.
  const sinceProcessed =
    lastProcessedAt === null ? null : Math.max(0, now.getTime() - lastProcessedAt.getTime());

  if (lastProcessedAt === null || (sinceProcessed !== null && sinceProcessed > BEHIND_AFTER_MS)) {
    return {
      state: 'stalled',
      detail:
        lastProcessedAt === null
          ? 'Work is due and nothing has ever been processed. No tick loop is running.'
          : `Work is due and nothing has been processed for ${formatDuration(sinceProcessed ?? 0)}.`,
    };
  }

  if (overdueRealMs > BEHIND_AFTER_MS) {
    return {
      state: 'behind',
      detail: `The oldest due event has been waiting ${formatDuration(overdueRealMs)}. The loop is running but not keeping up.`,
    };
  }

  return {
    state: 'keeping_up',
    detail: `Due work is being handled within ${formatDuration(BEHIND_AFTER_MS)}.`,
  };
}

/** Rough, and rounded down — this is a status line, not a stopwatch. */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

export interface WorldHealthReport {
  worlds: AdminWorldHealth[];
  datasets: AdminDatasetVersion[];
  serverTime: Date;
}

/**
 * Every world's health, in four queries regardless of how many worlds there are.
 *
 * The acceptance criterion asks for one *request* per refresh; this keeps the
 * query count flat too, because the console refreshes on a timer and a page that
 * costs a query per world per ten seconds is a page that gets switched off.
 *
 * Due-ness is worked out in JavaScript rather than SQL. Each world has its own
 * clock — `epoch + speed × (now − launch_date)` — so "is this event due" is a
 * different comparison per world, and expressing that in one grouped query means
 * interval arithmetic against a `numeric` speed for no gain. The oldest pending
 * event per world is enough: if it is not due, nothing is.
 */
export async function buildWorldHealth(
  db: Database,
  now: Date = new Date(),
): Promise<WorldHealthReport> {
  const worlds = await db.select().from(world).orderBy(asc(world.createdAt));

  const pending = await db
    .select({
      worldId: worldEvent.worldId,
      n: count(),
      oldest: min(worldEvent.fireAt),
    })
    .from(worldEvent)
    .where(eq(worldEvent.status, 'pending'))
    .groupBy(worldEvent.worldId);

  const processed = await db
    .select({ worldId: worldEvent.worldId, at: max(worldEvent.processedAt) })
    .from(worldEvent)
    .where(sql`${worldEvent.processedAt} is not null`)
    .groupBy(worldEvent.worldId);

  const airlines = await db
    .select({ worldId: airline.worldId, n: count() })
    .from(airline)
    .groupBy(airline.worldId);

  const pendingByWorld = new Map(pending.map((row) => [row.worldId, row]));
  const processedByWorld = new Map(processed.map((row) => [row.worldId, toDate(row.at)]));
  const airlinesByWorld = new Map(airlines.map((row) => [row.worldId, row.n]));

  const report = worlds.map((row): AdminWorldHealth => {
    const clock = clockOf(row);
    const gameNow = gameTime(clock, now);

    const queueRow = pendingByWorld.get(row.id);
    const oldestPending = toDate(queueRow?.oldest ?? null);
    const lastProcessedAt = processedByWorld.get(row.id) ?? null;

    // The oldest pending event is in **game** time. How late it is in real terms
    // is that gap divided by the speed — a world at 4× is four times less
    // forgiving of the same delay, which is the whole point of measuring in real
    // time rather than game time.
    const overdueGameMs =
      oldestPending === null ? null : gameNow.getTime() - oldestPending.getTime();
    const overdueRealMs =
      overdueGameMs === null || overdueGameMs < 0
        ? null
        : Math.round(gameToRealMs(clock, overdueGameMs));

    const assessment = assessTick({
      pending: queueRow?.n ?? 0,
      overdueRealMs,
      lastProcessedAt,
      now,
    });

    return {
      worldId: row.id,
      name: row.name,
      status: row.status,
      speedMultiplier: clock.speedMultiplier,
      launchDate: row.launchDate.toISOString(),
      inGameDate: gameNow.toISOString(),
      // Clamped at zero: a world whose launch date is in the future has not run
      // for a negative length of time, it has not run.
      realAgeMs: Math.max(0, now.getTime() - row.launchDate.getTime()),
      airlines: airlinesByWorld.get(row.id) ?? 0,
      queue: {
        pending: queueRow?.n ?? 0,
        oldestPendingAt: oldestPending === null ? null : oldestPending.toISOString(),
        overdueRealMs,
        lastProcessedAt: lastProcessedAt === null ? null : lastProcessedAt.toISOString(),
      },
      tick: assessment.state,
      tickDetail: assessment.detail,
    };
  });

  return { worlds: report, datasets: await readDatasets(db), serverTime: now };
}

/**
 * The newest import of each dataset.
 *
 * `dataset_version` keeps every import, so the latest row per dataset is what is
 * in use. Ordered and de-duplicated here rather than with a window function: at
 * a handful of datasets the difference is unmeasurable, and the query stays one
 * anybody can read.
 */
async function readDatasets(db: Database): Promise<AdminDatasetVersion[]> {
  const rows = await db
    .select({
      dataset: datasetVersion.dataset,
      version: datasetVersion.version,
      importedAt: datasetVersion.importedAt,
    })
    .from(datasetVersion)
    .orderBy(desc(datasetVersion.importedAt));

  const newest = new Map<string, AdminDatasetVersion>();
  for (const row of rows) {
    if (!newest.has(row.dataset)) {
      newest.set(row.dataset, {
        dataset: row.dataset,
        version: row.version,
        importedAt: row.importedAt.toISOString(),
      });
    }
  }
  return [...newest.values()];
}
