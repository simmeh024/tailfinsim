import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';

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
 * ## The handler's own writes are a savepoint inside that transaction
 *
 * One transaction is right for the *claim* and wrong for the handler, and
 * IMPROVE-01 is the difference. A handler that wrote and then threw used to have
 * its writes committed next to `status = 'failed'`, and a handler that caused a
 * statement error used to abort the transaction that was trying to record the
 * failure — losing the claim, so the event came back `pending` and failed again
 * on every tick for ever.
 *
 * So `handler` runs in a nested transaction (`SAVEPOINT`). On failure the
 * savepoint is rolled back, which discards the handler's writes and leaves the
 * outer transaction usable, and the failure record commits with the claim still
 * held. On success nothing is committed early: a released savepoint is not a
 * commit, so the handler's work and the event's completion still land together.
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

/**
 * What actually went wrong, bounded to what the column will hold.
 *
 * Drizzle wraps driver errors, so the outer message is always
 * `Failed query: ...` followed by the whole failing statement — asserting on it
 * passes for any failure at all, and storing it fills 500 characters with SQL
 * before reaching the reason. The trap is recorded in CLAUDE.md; here it also
 * decides what a human reads on the System health page.
 *
 * So the chain is walked and the messages joined **innermost first**: PostgreSQL
 * said `duplicate key value violates unique constraint "..."`, and that is the
 * sentence worth the first 500 characters.
 */
export function errorDetail(error: unknown, limit = 500): string {
  if (!(error instanceof Error)) return String(error).slice(0, limit);

  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message !== '') messages.push(current.message);
    current = current.cause;
  }

  // Innermost first: the cause is the diagnosis, the wrapper is the context.
  return messages.reverse().join(' | ').slice(0, limit);
}

export interface DrainResult {
  processed: number;
  /**
   * Events whose handler threw.
   *
   * Kept separate from `unsupported` (SCALE-05) so that a rising number here
   * means something is genuinely broken. Absorbing both made this counter
   * useless as an alert, because the commonest cause of it moving was a build
   * that simply did not have a handler yet.
   */
  failed: number;
  /** Events left for a Worker that knows their type. Nothing was attempted. */
  unsupported: number;
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
  let unsupported = 0;

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

      if (!handler) {
        /**
         * No handler for this type — a **deployment** problem, not a data one.
         *
         * Marked `unsupported` rather than `failed` (SCALE-05). One state was
         * being asked to mean two things, and conflating them cost twice: a
         * rising `failed` count stopped meaning "something is broken", and work
         * a later build could have done looked permanently destroyed.
         *
         * Three properties this state has to have, and each is load-bearing:
         *
         *   - **Not `pending`**, so the claim above skips it. Left pending, a
         *     type nobody handles would be reclaimed on every tick for ever and
         *     starve every supported event behind it.
         *   - **Not terminal**, because nothing happened to it. `processed_at`
         *     stays null and `attempts` is not incremented — no attempt was
         *     made, and counting one would make a retry policy read this as a
         *     flaky event rather than an absent handler.
         *   - **Recorded**, so an operator can see it per type and per world
         *     rather than discovering a silent pile.
         *
         * A Worker that knows the type moves these back to `pending` at boot;
         * see `requeueSupportedEvents`.
         */
        await tx
          .update(worldEvent)
          .set({
            status: 'unsupported',
            lastError: `No handler registered for ${event.type} in this build.`,
          })
          .where(eq(worldEvent.id, event.id));
        unsupported += 1;
        log?.(`event ${event.id} (${event.type}) has no handler in this build; left unsupported`);
        return false;
      }

      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.payload);
        payload =
          typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }

      try {
        /*
         * The handler runs in a savepoint, and that is the whole of IMPROVE-01.
         *
         * `tx.transaction()` issues `SAVEPOINT`, and on a rejection issues
         * `ROLLBACK TO SAVEPOINT` **before** rethrowing. Two failures used to be
         * possible without it, and they had different shapes:
         *
         *   - **A handler that wrote and then threw a JavaScript error** had its
         *     writes committed alongside `status = 'failed'`. A half-settled
         *     flight, recorded as not having happened — the worst of the three
         *     outcomes, because rolled-back is recoverable and marked-done is at
         *     least consistent, while this is a lie no later drain can detect.
         *
         *   - **A handler that caused a statement error** aborted the whole
         *     PostgreSQL transaction, so the `UPDATE ... 'failed'` in the catch
         *     failed too and took the claim with it. The event returned to
         *     `pending`, was reclaimed on the next tick, and failed again for
         *     ever; and the rejection escaped this function, so the tick died
         *     with it — every sweep after the drain, and every world after this
         *     one, stopped running until somebody deleted the row by hand.
         *
         * Rolling back to the savepoint fixes both: the handler's writes are
         * discarded, and the outer transaction is usable again, so the failure
         * record commits with the claim still held.
         *
         * Three things it deliberately does not change. The claim's `FOR UPDATE`
         * lock was taken *before* the savepoint, so rolling back does not
         * release it. AIR-06's constraint triggers are `DEFERRABLE INITIALLY
         * DEFERRED` and fire at commit, and a subtransaction rollback discards
         * the trigger events queued inside it — so a rolled-back cash movement
         * takes its reconciliation check with it. And success is unaffected: a
         * released savepoint commits nothing on its own, so the handler's writes
         * and the event's completion still commit together or not at all.
         */
        await tx.transaction(async (handlerTx) => {
          await handler(event, { payload, tx: handlerTx });
        });

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
        const message = errorDetail(error);
        // Marked failed in its own right rather than left pending: a permanently
        // broken event would otherwise be reclaimed on every tick forever and
        // starve everything behind it.
        await tx
          .update(worldEvent)
          .set({
            status: 'failed',
            processedAt: sql`now()`,
            attempts: sql`${worldEvent.attempts} + 1`,
            lastError: message,
          })
          .where(eq(worldEvent.id, event.id));
        failed += 1;
        log?.(`event ${event.id} (${event.type}) failed: ${message}`);
      }

      return false;
    });

    if (done) break;
  }

  return { processed, failed, unsupported, upTo };
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

/**
 * Return unsupported events to the queue for the types this build can handle.
 *
 * The other half of SCALE-05, and the moment that makes `unsupported` a pause
 * rather than a graveyard: a Worker starting with a handler for a type that has
 * rows waiting is exactly when they should go back.
 *
 * Scoped to the types passed in, so a build still missing a handler leaves those
 * rows alone. `processed_at` is already null on every unsupported row, so
 * returning them to `pending` needs no repair — which is the payoff of not
 * having stamped a time on them in the first place.
 *
 * **This is not a re-execution.** Nothing ran, so nothing is being run twice;
 * `attempts` was never incremented and the idempotency key is untouched. The
 * exactly-once guarantee is unaffected (V-11).
 *
 * One thing the caller must know: an event whose game-time `fire_at` has long
 * passed fires on the next tick. Whether that is right is the handler author's
 * decision, not this function's — a departure three world-days late may want to
 * be cancelled rather than flown.
 */
export async function requeueSupportedEvents(
  db: Database,
  types: readonly WorldEventType[],
): Promise<number> {
  if (types.length === 0) return 0;

  const requeued = await db
    .update(worldEvent)
    .set({ status: 'pending', lastError: null })
    .where(and(eq(worldEvent.status, 'unsupported'), inArray(worldEvent.type, [...types])))
    .returning({ id: worldEvent.id });

  return requeued.length;
}

/** Unsupported events, grouped by world and type — what an operator needs to act. */
export interface UnsupportedEventGroup {
  worldId: string;
  type: WorldEventType;
  count: number;
  /** Game time of the oldest one, so "how far behind" is answerable. */
  oldestFireAt: Date;
}

/**
 * What is waiting for a handler, per world and per type.
 *
 * Grouped rather than counted, because *"412 unsupported events"* is not
 * actionable and *"412 FLIGHT_DEPART in Northern Sky, oldest due three days
 * ago"* is.
 */
export async function unsupportedEvents(db: Database): Promise<UnsupportedEventGroup[]> {
  const rows = await db
    .select({
      worldId: worldEvent.worldId,
      type: worldEvent.type,
      count: sql<number>`count(*)::int`,
      oldestFireAt: sql<string>`min(${worldEvent.fireAt})`,
    })
    .from(worldEvent)
    .where(eq(worldEvent.status, 'unsupported'))
    .groupBy(worldEvent.worldId, worldEvent.type);

  // `min()` is a raw aggregate, so no column type parser applies and the driver
  // hands back a string however the column is declared — the trap CLAUDE.md
  // records. Normalised here rather than trusted.
  return rows.map((row) => ({
    worldId: row.worldId,
    type: row.type,
    count: row.count,
    oldestFireAt: new Date(row.oldestFireAt),
  }));
}
