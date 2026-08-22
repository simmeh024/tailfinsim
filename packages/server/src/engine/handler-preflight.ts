import { and, eq, ne, sql } from 'drizzle-orm';

import { type Database } from '../db/client';
import { world, worldEvent } from '../db/schema';
import { type WorldEventType } from '../sim/event-queue';

/**
 * Can this build handle the work the database is already holding? (SCALE-06)
 *
 * The deploy checks a great deal before it restarts anything — that the ref is
 * on `main`, that the node is pointed at the database it thinks it is, how many
 * migrations are pending, that a verified backup exists before a schema change.
 * For a Worker it never asked the one question that decides whether the new
 * process can do the job: **are there event types queued that this build has no
 * handler for?**
 *
 * The runtime already answers it, and answers it too late. `/healthz` reports
 * `engine.unhandledEventTypes`, but the engine starts before the deploy polls
 * and drains on its first tick, so by the time the deploy could read the answer
 * the queue has already been processed against the build. A check that arrives
 * one tick after the thing it was checking is not a gate.
 *
 * This module is the gate, and it runs from a process that never starts the
 * engine, never binds a port and never writes a row.
 *
 * ## Actionable, and nothing else
 *
 * The question is deliberately narrow. `world_event` never deletes a row, so
 * "types present in the database" and "types that are still work" are very
 * different queries, and only the second one may block a deploy. Counting
 * history would block every deploy on this repository forever — a
 * `FLIGHT_DEPART` that failed last month is not a reason to refuse a Worker
 * today. That is the mistake Dependency Review avoided when it chose to fail
 * only on what the diff added.
 *
 * Excluded, and reported as excluded rather than quietly dropped:
 *
 *   - `done` and `failed` — history. Nothing will drain these again.
 *   - `unsupported` — already parked by SCALE-05, by definition for want of a
 *     handler. Blocking on these would make the pause self-perpetuating: the
 *     first Worker that could clear them is the one the gate would refuse.
 *   - `pending` rows in an **archived** world. `listTickableWorlds` filters
 *     archived worlds out, so the engine will never look at these however long
 *     they sit there. They are as inert as history and must not be treated as
 *     work.
 */

/**
 * Exit codes, in the family `migrate.js` established.
 *
 * Distinct numbers rather than a bare 1, and deliberately clear of the migration
 * codes (20–23), so `deploy.sh` can tell "this build cannot do the work" from
 * "the check could not run" from "you typed the flag wrong" — and so a future
 * caller reading the code knows which of those it met without parsing prose.
 */
export const HANDLER_EXIT_GAP = 30;

/**
 * The check itself failed — no answer, rather than a bad answer.
 *
 * Kept apart from `HANDLER_EXIT_GAP` because `ALLOW_HANDLER_GAP` must not
 * override it. An operator overriding the gate is saying "I know there is a gap
 * and I accept the pause"; they cannot say that about a question nobody managed
 * to ask. Not knowing fails closed with no way round it.
 */
export const HANDLER_EXIT_UNKNOWN = 31;

/** One event type with actionable work waiting, and enough detail to act on it. */
export interface QueuedEventType {
  type: WorldEventType;
  count: number;
  /** How many distinct worlds hold it — one broken world reads very differently to all of them. */
  worlds: number;
  /** Game time of the oldest, so "how far behind" is answerable. */
  oldestFireAt: Date;
}

/**
 * Rows the check deliberately did not count.
 *
 * Reported rather than silently ignored: an operator reading a refusal needs to
 * see that the 4,000 `FLIGHT_DEPART` rows they know about were considered and
 * classified, not that the check failed to notice them.
 */
export interface ExcludedRows {
  done: number;
  failed: number;
  /** Already parked for want of a handler (SCALE-05). */
  unsupported: number;
  /** Pending, but in a world the engine will never tick. */
  archived: number;
}

export interface HandlerPreflight {
  /** What the candidate build can do. */
  handled: WorldEventType[];
  /** What the database is holding as real work. */
  actionable: QueuedEventType[];
  /** The actionable types with no handler — the reason to refuse. */
  gaps: QueuedEventType[];
  excluded: ExcludedRows;
  compatible: boolean;
}

/**
 * The comparison itself, with no database in it.
 *
 * Separated so the decision can be tested exhaustively without a Postgres, and
 * so that the rule is one readable line rather than something inferred from a
 * query plan.
 */
export function classifyHandlerCoverage(
  handled: readonly WorldEventType[],
  actionable: readonly QueuedEventType[],
): QueuedEventType[] {
  const canHandle = new Set(handled);
  return actionable.filter((queued) => !canHandle.has(queued.type));
}

/**
 * Event types with actionable queued work, grouped.
 *
 * A join and a `group by` rather than a correlated subquery in the select list:
 * that shape came back empty against real Postgres once — zeros for rows that
 * demonstrably had data — and CLAUDE.md records it as undiagnosed. The grouped
 * form is the one that is known to work.
 */
export async function readActionableEventTypes(db: Database): Promise<QueuedEventType[]> {
  const rows = await db
    .select({
      type: worldEvent.type,
      count: sql<number>`count(*)::int`,
      worlds: sql<number>`count(distinct ${worldEvent.worldId})::int`,
      oldestFireAt: sql<string>`min(${worldEvent.fireAt})`,
    })
    .from(worldEvent)
    .innerJoin(world, eq(world.id, worldEvent.worldId))
    .where(and(eq(worldEvent.status, 'pending'), ne(world.status, 'archived')))
    .groupBy(worldEvent.type);

  return rows
    .map((row) => ({
      type: row.type,
      count: row.count,
      worlds: row.worlds,
      // `min()` is a raw aggregate, so no column type parser applies and the
      // driver hands back a string however the column is declared — the trap
      // CLAUDE.md records. Normalised here rather than trusted.
      oldestFireAt: new Date(row.oldestFireAt),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/** The rows the check did not count, so the report can say so. */
export async function readExcludedRows(db: Database): Promise<ExcludedRows> {
  const byStatus = await db
    .select({ status: worldEvent.status, count: sql<number>`count(*)::int` })
    .from(worldEvent)
    .groupBy(worldEvent.status);

  const countOf = (status: string): number =>
    byStatus.find((row) => row.status === status)?.count ?? 0;

  const archived = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(worldEvent)
    .innerJoin(world, eq(world.id, worldEvent.worldId))
    .where(and(eq(worldEvent.status, 'pending'), eq(world.status, 'archived')));

  return {
    done: countOf('done'),
    failed: countOf('failed'),
    unsupported: countOf('unsupported'),
    archived: archived[0]?.count ?? 0,
  };
}

/** Ask the database the narrow question and decide. */
export async function collectHandlerPreflight(
  db: Database,
  handled: readonly WorldEventType[],
): Promise<HandlerPreflight> {
  const actionable = await readActionableEventTypes(db);
  const excluded = await readExcludedRows(db);
  const gaps = classifyHandlerCoverage(handled, actionable);

  return {
    handled: [...handled],
    actionable,
    gaps,
    excluded,
    compatible: gaps.length === 0,
  };
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The report, in the voice `deploy.sh` already uses.
 *
 * Built here rather than in bash so that what an operator reads at 2am is
 * covered by the same tests as the decision that produced it. The deploy adds
 * the two things only it knows — that the database was not touched, and which
 * commit is still serving.
 */
export function formatHandlerPreflight(result: HandlerPreflight): string[] {
  const lines: string[] = [];
  const gaps = new Set(result.gaps.map((gap) => gap.type));

  lines.push(`this build handles: ${result.handled.join(', ') || '(nothing)'}`);

  if (result.actionable.length === 0) {
    lines.push('actionable queued work: none');
  } else {
    lines.push('actionable queued work:');
    for (const queued of result.actionable) {
      lines.push(
        `  ${queued.type}: ${plural(queued.count, 'event')} across ` +
          `${plural(queued.worlds, 'world')}, oldest due ${queued.oldestFireAt.toISOString()}` +
          ` — ${gaps.has(queued.type) ? 'NO HANDLER' : 'ok'}`,
      );
    }
  }

  // Always printed, including when every number is zero. "Considered and found
  // nothing" and "did not look" are different statements, and the second one is
  // what gets a check quietly deleted for being useless.
  const { done, failed, unsupported, archived } = result.excluded;
  lines.push(
    `excluded from the decision: ${String(done)} done, ${String(failed)} failed, ` +
      `${String(unsupported)} already parked for want of a handler, ` +
      `${String(archived)} pending in archived worlds`,
  );

  if (result.compatible) {
    lines.push('HANDLER PREFLIGHT: OK — this build handles every type with queued work.');
  } else {
    const named = result.gaps
      .map((gap) => `${gap.type} (${plural(gap.count, 'event')})`)
      .join(', ');
    lines.push(
      `HANDLER PREFLIGHT: REFUSED — this build has no handler for ${named}. ` +
        'Starting it would park that work as unsupported rather than doing it. ' +
        'Deploy a build that registers the handler, or set ALLOW_HANDLER_GAP=1 on the ' +
        'deploy command to accept the pause deliberately.',
    );
  }

  return lines;
}
