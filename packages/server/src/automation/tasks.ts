import { and, desc, eq, isNull } from 'drizzle-orm';

import type { AutomationSystem, OperationsTaskView } from '@tailfin/shared';

import { operationsTask } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * The operations queue — the situations the worker left for the player (ADR-0023 §4).
 *
 * §3.1's "waits for you" needs somewhere to live; this is it. One open row per
 * situation, and `onConflictDoNothing` against the partial unique index keeps a
 * replay or two racing workers from stacking duplicates: raising the same
 * situation twice makes one open task, idempotent by constraint like the rest of
 * the queue-shaped state.
 */

export interface RaiseTaskInput {
  worldId: string;
  airlineId: string;
  system: AutomationSystem;
  kind: string;
  /** The flight the task is about, or null for a base-wide situation. */
  subjectId: string | null;
  detail: string;
}

export async function raiseOperationsTask(db: Database, input: RaiseTaskInput): Promise<void> {
  await db
    .insert(operationsTask)
    .values({
      worldId: input.worldId,
      airlineId: input.airlineId,
      system: input.system,
      kind: input.kind,
      subjectType: input.subjectId === null ? null : 'flight',
      subjectId: input.subjectId,
      detail: input.detail,
    })
    // Any unique violation — the open-task index — means the situation is already
    // queued. Nothing to add; leave the standing task as it is.
    .onConflictDoNothing();
}

/** The open tasks for this airline, newest first. */
export async function listOpenTasks(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<OperationsTaskView[]> {
  const rows = await db
    .select({
      id: operationsTask.id,
      system: operationsTask.system,
      kind: operationsTask.kind,
      subjectId: operationsTask.subjectId,
      detail: operationsTask.detail,
      raisedAt: operationsTask.raisedAt,
    })
    .from(operationsTask)
    .where(and(eq(operationsTask.airlineId, own.id), isNull(operationsTask.resolvedAt)))
    .orderBy(desc(operationsTask.raisedAt));

  return rows.map((row) => ({
    id: row.id,
    system: row.system,
    kind: row.kind,
    subjectId: row.subjectId,
    detail: row.detail,
    raisedAt: row.raisedAt.toISOString(),
  }));
}
