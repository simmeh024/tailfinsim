import { eq } from 'drizzle-orm';

import {
  type AdminAction,
  AdminResetWorldRequest,
  AdminWorldStatusRequest,
  WORLD_TRANSITIONS,
  type WorldStatus,
} from '@tailfin/shared';
import { gameTime } from '@tailfin/sim';

import { type Database } from '../db/client';
import { world, type WorldRow } from '../db/schema';
import { resetWorldWithin } from '../world/lifecycle';

import { writeAudit } from './audit';
import { type Actor } from './grants';

/**
 * A world's life: open, lock, archive, reset (M1A-04, §22.2, ADR-0005).
 *
 * ## A reset is a decision, not a schedule
 *
 * Nothing here runs itself. Every function takes an actor, writes an audit row
 * in the same transaction as its change, and refuses rather than guesses.
 *
 * ## The clock half of a reset is trivial; the rest is the decision
 *
 * `launch_date = now()` with `epoch` untouched returns the calendar to the epoch
 * by definition (ADR-0005) — one column. What a rewound clock *invalidates* is
 * the hard part, and the answer is written down in ADR-0005 rather than only
 * here: airlines and the event queue go, players and global reference data stay.
 *
 * ## Why the transitions are a table
 *
 * Because "which of these can I do from here" is a question with a written
 * answer, and encoding it as a shared table means the console offers exactly the
 * buttons that will work. The server checks it again on the way in: what the
 * interface renders is not what it is permitted to do.
 */

export type LifecycleRefusalCode =
  | 'invalid_request'
  | 'world_not_found'
  | 'status_stale'
  | 'illegal_transition'
  | 'status_unchanged'
  | 'name_mismatch'
  | 'world_archived';

export interface LifecycleRefusal {
  ok: false;
  code: LifecycleRefusalCode;
  message: string;
  fields: Record<string, string[]>;
}

export interface StatusChangeResult {
  ok: true;
  world: WorldRow;
  before: WorldStatus;
  after: WorldStatus;
}

export interface ResetResultForAdmin {
  ok: true;
  world: WorldRow;
  destroyed: { airlines: number; events: number };
  inGameDate: Date;
  reason: string;
}

function refuse(
  code: LifecycleRefusalCode,
  field: string,
  reason: string,
  message = reason,
): LifecycleRefusal {
  return { ok: false, code, message, fields: { [field]: [reason] } };
}

function notFound(): LifecycleRefusal {
  return {
    ok: false,
    code: 'world_not_found',
    message: 'No world with that id.',
    fields: { form: ['That world no longer exists. Reload the list.'] },
  };
}

/** The world moved under the console. Refuse, rather than act on a stale picture. */
function stale(name: string, actual: WorldStatus, expected: WorldStatus): LifecycleRefusal {
  return {
    ok: false,
    code: 'status_stale',
    message: 'The world is no longer in the state you were shown.',
    fields: {
      form: [
        `"${name}" is ${actual}, not ${expected} as shown. Somebody else changed it. Check the audit log, then decide again.`,
      ],
    },
  };
}

/** In words, for a refusal that has to teach as well as refuse. */
function allowedFrom(status: WorldStatus): string {
  const allowed = WORLD_TRANSITIONS[status];
  if (allowed.length === 0)
    return 'nothing — an archived world is a record, and records do not move';
  return allowed.join(' or ');
}

/** The audit action for a transition. Distinct verbs, because the log is read under pressure. */
const TRANSITION_ACTION: Record<string, AdminAction> = {
  'staging→open': 'world.opened',
  'locked→open': 'world.unlocked',
  'open→locked': 'world.locked',
  'staging→archived': 'world.archived',
  'locked→archived': 'world.archived',
};

export function validateStatusRequest(
  input: unknown,
): { ok: true; request: AdminWorldStatusRequest } | LifecycleRefusal {
  const parsed = AdminWorldStatusRequest.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'That is not a state a world can be put into.',
      fields: { form: ['The request was not understood.'] },
    };
  }
  return { ok: true, request: parsed.data };
}

/**
 * Moves a world through its lifecycle, and records who did it.
 *
 * Locked `FOR UPDATE` first: the legality check and the write have to be one
 * step, or two admins can each read `open` and both act on it.
 */
export async function changeWorldStatus(
  db: Database,
  worldId: string,
  request: AdminWorldStatusRequest,
  actor: Actor,
): Promise<StatusChangeResult | LifecycleRefusal> {
  return db.transaction(async (tx): Promise<StatusChangeResult | LifecycleRefusal> => {
    const rows = await tx.select().from(world).where(eq(world.id, worldId)).limit(1).for('update');
    const row = rows[0];
    if (!row) return notFound();

    const before = row.status;
    if (before !== request.expectedStatus) return stale(row.name, before, request.expectedStatus);

    if (before === request.status) {
      return refuse('status_unchanged', 'form', `"${row.name}" is already ${before}.`);
    }

    if (!WORLD_TRANSITIONS[before].includes(request.status)) {
      return refuse(
        'illegal_transition',
        'form',
        `A ${before} world cannot become ${request.status}. From ${before} it can become ${allowedFrom(before)}.`,
      );
    }

    await tx.update(world).set({ status: request.status }).where(eq(world.id, worldId));

    const updatedRows = await tx.select().from(world).where(eq(world.id, worldId)).limit(1);
    const updated = updatedRows[0];
    if (!updated) throw new Error(`World ${worldId} vanished mid-transaction`);

    const action = TRANSITION_ACTION[`${before}→${request.status}`];
    if (!action) {
      // Unreachable while the table above covers every legal transition, and a
      // throw rather than a silent fallback so that adding a transition without
      // deciding what to call it fails loudly rather than logging the wrong verb.
      throw new Error(`No audit action for ${before} → ${request.status}`);
    }

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action,
      subjectType: 'world',
      subjectId: worldId,
      before: { name: row.name, status: before },
      after: { name: row.name, status: updated.status },
      requestId: actor.requestId,
    });

    return { ok: true, world: updated, before, after: updated.status };
  });
}

export function validateResetRequest(
  input: unknown,
): { ok: true; request: AdminResetWorldRequest } | LifecycleRefusal {
  const parsed = AdminResetWorldRequest.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path.length > 0 ? String(issue.path[0]) : 'form';
      (fields[field] ??= []).push(
        field === 'reason'
          ? 'A reason is required. It goes into the audit log, and it is what answers "why is this world back at zero?" months from now.'
          : issue.message,
      );
    }
    return {
      ok: false,
      code: 'invalid_request',
      message: 'This reset cannot be carried out.',
      fields,
    };
  }
  return { ok: true, request: parsed.data };
}

/**
 * Resets a world, having been told the world's own name.
 *
 * The typed name is checked **inside** the transaction against the locked row,
 * not against whatever the console was showing. A world renamed between the
 * confirmation being read and the button being pressed is a different world than
 * the one that was agreed to.
 *
 * The criterion — that the calendar returns to the epoch — is verified against
 * the row that was actually written, and a failure throws so the transaction
 * rolls back. A reset that half-worked is worse than one that refused.
 */
export async function resetWorldAsAdmin(
  db: Database,
  worldId: string,
  request: AdminResetWorldRequest,
  actor: Actor,
  now: Date = new Date(),
): Promise<ResetResultForAdmin | LifecycleRefusal> {
  return db.transaction(async (tx): Promise<ResetResultForAdmin | LifecycleRefusal> => {
    const rows = await tx.select().from(world).where(eq(world.id, worldId)).limit(1).for('update');
    const row = rows[0];
    if (!row) return notFound();

    if (row.status === 'archived') {
      // §22.2 keeps archived worlds browsable for ever. Resetting one would
      // destroy the history it exists to preserve.
      return refuse(
        'world_archived',
        'form',
        `"${row.name}" is archived. Archived worlds are kept so their history stays browsable, so they cannot be reset.`,
      );
    }

    if (row.status !== request.expectedStatus) {
      return stale(row.name, row.status, request.expectedStatus);
    }

    if (request.confirmName.trim() !== row.name) {
      return refuse(
        'name_mismatch',
        'confirmName',
        `That is not the name of this world. Type “${row.name}” exactly to confirm.`,
      );
    }

    const result = await resetWorldWithin(tx, worldId, now);

    const updatedRows = await tx.select().from(world).where(eq(world.id, worldId)).limit(1);
    const updated = updatedRows[0];
    if (!updated) throw new Error(`World ${worldId} vanished mid-transaction`);

    const inGameDate = gameTime(
      {
        epoch: updated.epoch,
        launchDate: updated.launchDate,
        speedMultiplier: Number(updated.speedMultiplier),
      },
      now,
    );

    // The acceptance criterion, checked rather than assumed. `launch_date` is
    // `now` and the elapsed time is therefore zero, so this is the epoch exactly
    // — no division, no residue. If it is ever not, something is wrong enough
    // that committing would be worse than failing.
    if (inGameDate.getTime() !== updated.epoch.getTime()) {
      throw new Error(
        `Reset did not return the calendar to the epoch: got ${inGameDate.toISOString()}, expected ${updated.epoch.toISOString()}`,
      );
    }

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'world.reset',
      subjectType: 'world',
      subjectId: worldId,
      before: {
        name: row.name,
        status: row.status,
        launchDate: row.launchDate.toISOString(),
        inGameDate: gameTime(
          {
            epoch: row.epoch,
            launchDate: row.launchDate,
            speedMultiplier: Number(row.speedMultiplier),
          },
          now,
        ).toISOString(),
        airlines: result.airlinesCleared,
        events: result.eventsCleared,
      },
      after: {
        name: row.name,
        status: updated.status,
        launchDate: updated.launchDate.toISOString(),
        inGameDate: inGameDate.toISOString(),
        // The reason is the point of the entry. Everything else can be
        // reconstructed; why somebody did it cannot.
        reason: request.reason.trim(),
      },
      requestId: actor.requestId,
    });

    return {
      ok: true,
      world: updated,
      destroyed: { airlines: result.airlinesCleared, events: result.eventsCleared },
      inGameDate,
      reason: request.reason.trim(),
    };
  });
}
