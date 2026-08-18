import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { gameTime, type WorldClock } from '@tailfin/sim';

import { type Database } from '../db/client';
import { worldEvent, type WorldEventRow } from '../db/schema';

/**
 * The scheduled event queue (M1-06, §21).
 *
 * Discrete transitions — a flight departing, arriving, a turnaround finishing —
 * are scheduled here rather than discovered by polling. Polling ten thousand
 * aircraft once a second to ask whether they have landed is the design this
 * exists to avoid.
 *
 * ## Exactly once, across restarts
 *
 * Three things together, because no one of them is enough:
 *
 *   1. **A unique idempotency key per world.** Scheduling the same logical event
 *      twice is refused by the database rather than by application code that has
 *      to be right every time.
 *   2. **`FOR UPDATE SKIP LOCKED`** when claiming due events, so two workers can
 *      drain the same queue without either blocking or double-handling. A worker
 *      that dies mid-transaction rolls back and its rows return to the pool.
 *   3. **Claim and handle inside one transaction.** The row is only marked done
 *      if the handler returned; a crash between the two leaves it pending, which
 *      is the direction you want to fail in — an event handled twice is a bug, an
 *      event handled late is a Tuesday.
 *
 * ## Game time, not real time
 *
 * `fire_at` is a game-time instant. That is what lets an event survive a speed
 * change or an admin reset with its meaning intact: "this flight lands at 14:05
 * on 3 November in world time" stays true however the clock is running.
 */

export type WorldEventType = 'FLIGHT_DEPART' | 'FLIGHT_ARRIVE' | 'TURNAROUND_COMPLETE';

export interface ScheduledEvent {
  worldId: string;
  type: WorldEventType;
  /** Game-time instant this becomes due. */
  fireAt: Date;
  payload: Record<string, unknown>;
  /**
   * Stable identity for this logical event.
   *
   * Must be derived from what the event *is* — `flight:<id>:depart` — and never
   * from when it was scheduled or a random value, or rescheduling after a
   * restart would create a second copy rather than being refused.
   */
  idempotencyKey: string;
}

export type EventHandler = (
  event: WorldEventRow,
  context: { payload: Record<string, unknown>; tx: Database },
) => Promise<void>;

export type HandlerRegistry = Partial<Record<WorldEventType, EventHandler>>;

/**
 * Schedules an event, ignoring one already scheduled under the same key.
 *
 * Returns whether it was new, so a caller that cares can tell "I scheduled it"
 * from "it was already there" — which after a restart is the normal case rather
 * than an error.
 */
export async function scheduleEvent(db: Database, event: ScheduledEvent): Promise<boolean> {
  const inserted = await db
    .insert(worldEvent)
    .values({
      worldId: event.worldId,
      type: event.type,
      fireAt: event.fireAt,
      payload: JSON.stringify(event.payload),
      idempotencyKey: event.idempotencyKey,
    })
    .onConflictDoNothing({ target: [worldEvent.worldId, worldEvent.idempotencyKey] })
    .returning({ id: worldEvent.id });

  return inserted.length > 0;
}

export interface DrainResult {
  processed: number;
  failed: number;
  /** The game time the drain ran against, for logging. */
  upTo: Date;
}

export interface DrainOptions {
  /**
   * How many events one drain will handle.
   *
   * A cap rather than "everything due", so a ten-minute outage backlog is worked
   * through over several ticks instead of one transaction that holds locks for a
   * minute. The acceptance criterion asks that a backlog be processed without
   * dropping events — not that it be processed in a single gulp.
   */
  batchSize?: number;
  log?: (line: string) => void;
}

/**
 * Claims and handles every due event, in game-time order.
 *
 * One transaction per event rather than one for the batch: a single poisonous
 * event would otherwise roll back the whole batch, and the next drain would pick
 * the same batch and fail again forever.
 */
export async function drainDueEvents(
  db: Database,
  worldId: string,
  clock: WorldClock,
  realNow: Date,
  handlers: HandlerRegistry,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const { batchSize = 200, log } = options;
  const upTo = gameTime(clock, realNow);

  let processed = 0;
  let failed = 0;

  for (let handledInThisDrain = 0; handledInThisDrain < batchSize; handledInThisDrain += 1) {
    const done = await db.transaction(async (tx) => {
      // One at a time, ordered by game time then id so the order is total and
      // stable — two events due at the same instant must still have a defined
      // sequence, or a restart could interleave them differently.
      const claimed = await tx
        .select()
        .from(worldEvent)
        .where(
          and(
            eq(worldEvent.worldId, worldId),
            eq(worldEvent.status, 'pending'),
            lte(worldEvent.fireAt, upTo),
          ),
        )
        .orderBy(asc(worldEvent.fireAt), asc(worldEvent.id))
        .limit(1)
        .for('update', { skipLocked: true });

      const event = claimed[0];
      if (!event) return true;

      const handler = handlers[event.type];
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.payload);
        payload =
          typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }

      try {
        if (!handler) {
          // An unhandled type is a deployment problem, not a data problem — the
          // event is left failed rather than silently marked done, so it is still
          // there when the handler ships.
          throw new Error(`No handler registered for ${event.type}`);
        }
        await handler(event, { payload, tx: tx });

        await tx
          .update(worldEvent)
          .set({
            status: 'done',
            processedAt: sql`now()`,
            attempts: sql`${worldEvent.attempts} + 1`,
          })
          .where(eq(worldEvent.id, event.id));
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Marked failed in its own right rather than left pending: a permanently
        // broken event would otherwise be reclaimed on every tick forever and
        // starve everything behind it.
        await tx
          .update(worldEvent)
          .set({
            status: 'failed',
            processedAt: sql`now()`,
            attempts: sql`${worldEvent.attempts} + 1`,
            lastError: message.slice(0, 500),
          })
          .where(eq(worldEvent.id, event.id));
        failed += 1;
        log?.(`event ${event.id} (${event.type}) failed: ${message}`);
      }

      return false;
    });

    if (done) break;
  }

  return { processed, failed, upTo };
}

/** How many events are waiting, and how far behind the oldest is. */
export async function queueDepth(
  db: Database,
  worldId: string,
  clock: WorldClock,
  realNow: Date,
): Promise<{ due: number; oldestDueAt: Date | null }> {
  const upTo = gameTime(clock, realNow);
  const rows = await db
    .select({
      due: sql<number>`count(*)::int`,
      // Typed as it actually arrives, not as we would like it.
      //
      // `sql<Date>` is an assertion, not a conversion: drizzle applies a column's
      // type parser to a *column*, and a raw aggregate like `min()` is not one, so
      // the driver's own decoding is what you get — a string. The first version
      // of this declared `Date` and typechecked happily, then threw
      // "getTime is not a function" the moment it met a real Postgres. Caught by
      // CI, which is the only place these tests run.
      oldest: sql<string | Date | null>`min(${worldEvent.fireAt})`,
    })
    .from(worldEvent)
    .where(
      and(
        eq(worldEvent.worldId, worldId),
        eq(worldEvent.status, 'pending'),
        lte(worldEvent.fireAt, upTo),
      ),
    );

  const oldest = rows[0]?.oldest ?? null;
  return {
    due: rows[0]?.due ?? 0,
    // Normalised here rather than trusting either shape: a different driver or a
    // drizzle upgrade could return the other one, and callers should not have to
    // care which.
    oldestDueAt: oldest === null ? null : oldest instanceof Date ? oldest : new Date(oldest),
  };
}
