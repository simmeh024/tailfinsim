import { and, eq, inArray } from 'drizzle-orm';

import { AdminRequeueEventsRequest } from '@tailfin/shared';

import { type Database } from '../db/client';
import { worldEvent } from '../db/schema';
import { type WorldEventType } from '../sim/event-queue';

import { writeAudit } from './audit';
import { type Actor } from './grants';

/**
 * Returning paused work to the queue (SCALE-05).
 *
 * `unsupported` exists so that a Worker without a handler pauses work instead of
 * destroying it. That is only half a guarantee unless the work can be recovered
 * **without hand-written SQL** — a state nobody can clear is a graveyard with a
 * better name.
 *
 * Two ways back, and both are here in spirit:
 *
 *   - automatically, when a Worker boots with a handler it did not have before
 *     (`requeueSupportedEvents`, called from `worker.ts`);
 *   - deliberately, through this action, for the case where an operator knows
 *     something the Worker cannot: a handler shipped on a node that has not
 *     restarted yet, or rows paused by a build that has since been rolled back.
 *
 * Audited in the same transaction as the change, like every other admin action.
 * A requeue moves live simulation work back into a running world's queue, which
 * is exactly the sort of thing somebody will later want to know the author of.
 */

export type RequeueRefusalCode = 'invalid_request' | 'nothing_to_requeue';

export interface RequeueRefusal {
  ok: false;
  code: RequeueRefusalCode;
  message: string;
  fields: Record<string, string[]>;
}

export interface RequeueResult {
  ok: true;
  requeued: number;
  types: string[];
}

export type RequeueOutcome = RequeueResult | RequeueRefusal;

export function validateRequeueRequest(
  input: unknown,
): { ok: true; request: AdminRequeueEventsRequest } | RequeueRefusal {
  const parsed = AdminRequeueEventsRequest.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path.length > 0 ? String(issue.path[0]) : 'form';
      (fields[field] ??= []).push(issue.message);
    }
    return {
      ok: false,
      code: 'invalid_request',
      message: 'That is not a set of event types this can requeue.',
      fields,
    };
  }
  return { ok: true, request: parsed.data };
}

/**
 * Move every `unsupported` event of the named types back to `pending`.
 *
 * **Not a re-execution.** Nothing ran on these rows: `attempts` was never
 * incremented, `processed_at` is null, and the idempotency key is untouched. The
 * exactly-once guarantee is unaffected (V-11), and this is the payoff of having
 * refused to stamp a processed time on a row nothing processed.
 *
 * One thing the caller is told rather than protected from: an event whose
 * game-time `fire_at` passed long ago fires on the next tick. Whether a
 * departure three world-days late should be flown or cancelled is the handler
 * author's decision, and this action cannot make it for them.
 */
export async function requeueUnsupportedEvents(
  db: Database,
  request: AdminRequeueEventsRequest,
  actor: Actor,
): Promise<RequeueOutcome> {
  return db.transaction(async (tx): Promise<RequeueOutcome> => {
    const types = request.types as WorldEventType[];

    const requeued = await tx
      .update(worldEvent)
      .set({ status: 'pending', lastError: null })
      .where(and(eq(worldEvent.status, 'unsupported'), inArray(worldEvent.type, types)))
      .returning({ id: worldEvent.id, worldId: worldEvent.worldId, type: worldEvent.type });

    if (requeued.length === 0) {
      // Not an error, and not audited either: a log full of "requeued nothing"
      // is a log nobody reads, and the same request a minute earlier might have
      // done something.
      return {
        ok: false,
        code: 'nothing_to_requeue',
        message: `No unsupported events of ${request.types.join(', ')} are waiting.`,
        fields: { types: ['Nothing is paused for these types.'] },
      };
    }

    const perWorld = new Map<string, number>();
    for (const row of requeued) {
      perWorld.set(row.worldId, (perWorld.get(row.worldId) ?? 0) + 1);
    }

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'events.requeued',
      subjectType: 'world_event',
      // No single subject — this is a bulk action over types, and naming one of
      // the rows would be arbitrary. The counts are the record.
      subjectId: null,
      before: { status: 'unsupported', types: request.types },
      after: {
        status: 'pending',
        requeued: requeued.length,
        perWorld: Object.fromEntries(perWorld),
      },
      requestId: actor.requestId,
    });

    return { ok: true, requeued: requeued.length, types: request.types };
  });
}
