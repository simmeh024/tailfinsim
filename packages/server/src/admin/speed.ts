import { and, count, eq } from 'drizzle-orm';

import {
  type AdminClockSnapshot,
  AdminSpeedChangeRequest,
  SPEED_MULTIPLIER_DECIMALS,
} from '@tailfin/shared';
import { gameTime, reanchorForSpeed, type WorldClock } from '@tailfin/sim';

import { type Database } from '../db/client';
import { world, worldEvent, type WorldRow } from '../db/schema';

import { writeAudit } from './audit';
import { type Actor } from './grants';

/**
 * Changing a running world's speed (M1A-03, design doc §22.2, ADR-0005).
 *
 * ## The change is not to the multiplier
 *
 * Game time is `epoch + speed × (now − launch_date)`, so writing a new
 * multiplier alone applies it to every second of real time the world has already
 * run, and the calendar lurches — a world 30 real days old at 2× would jump from
 * 60 game days past its epoch to 90. The actual change is to **`launch_date`**,
 * re-anchored so the current in-game date comes out the same under the new
 * speed. `reanchorForSpeed` in `packages/sim` does that arithmetic and this
 * module does not repeat it: §21 keeps clock rules in the sim, where they are
 * pure and replayable.
 *
 * ## Scheduled events need nothing done to them
 *
 * `world_event.fire_at` is a **game-time** instant (M1-06), not a real one, so
 * "this flight lands at 14:05 on 3 November in world time" survives the change
 * untouched. Nothing is rescheduled, and there is no window in which a rewritten
 * queue could be half-written. What changes is the real-world wait: at a higher
 * speed the same in-game moment arrives sooner.
 *
 * The queue drains everything with `fire_at <= gameTime(now)`, so preserving
 * game time at the instant of the change preserves due-ness for every event at
 * once, and the sim rounds the residue in the one direction that cannot fire an
 * event early. The count of pending events is read inside the transaction all
 * the same — not because they need touching, but because an admin about to
 * change a live world deserves to be told how much is in flight, and the audit
 * entry should record it.
 */

export type SpeedRefusalCode =
  'invalid_speed' | 'world_not_found' | 'world_archived' | 'speed_unchanged' | 'speed_stale';

export interface SpeedRefusal {
  ok: false;
  code: SpeedRefusalCode;
  message: string;
  /** Keyed by form field, as `ApiError.fields` carries it. */
  fields: Record<string, string[]>;
}

export interface SpeedChangeResult {
  ok: true;
  world: WorldRow;
  before: AdminClockSnapshot;
  after: AdminClockSnapshot;
  pendingEvents: number;
  /** `after − before` in milliseconds. Never positive; see `reanchorForSpeed`. */
  driftMs: number;
}

export type SpeedOutcome = SpeedChangeResult | SpeedRefusal;

function refuse(
  code: SpeedRefusalCode,
  field: string,
  reason: string,
  message = reason,
): SpeedRefusal {
  return { ok: false, code, message, fields: { [field]: [reason] } };
}

/** Two decimal places, matching `numeric(4,2)`. Avoids the float trap in `x * 100 !== Math.round(x * 100)`. */
function hasTooMuchPrecision(value: number): boolean {
  return Number(value.toFixed(SPEED_MULTIPLIER_DECIMALS)) !== value;
}

function clockOf(row: WorldRow): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

function snapshot(clock: WorldClock, at: Date): AdminClockSnapshot {
  return {
    speedMultiplier: clock.speedMultiplier,
    launchDate: clock.launchDate.toISOString(),
    inGameDate: gameTime(clock, at).toISOString(),
  };
}

/**
 * Checks the request shape and the rules that do not need the world.
 *
 * Separate from `changeWorldSpeed` because everything it can decide is decidable
 * without a database round trip, and everything it cannot — is this world
 * archived, is that still the speed — has to be decided *inside* the transaction
 * that changes it, or two admins can race between the check and the write.
 */
export function validateSpeedRequest(
  input: unknown,
): { ok: true; request: AdminSpeedChangeRequest } | SpeedRefusal {
  const parsed = AdminSpeedChangeRequest.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path.length > 0 ? String(issue.path[0]) : 'form';
      (fields[field] ??= []).push(issue.message);
    }
    return {
      ok: false,
      code: 'invalid_speed',
      message: 'That is not a speed this world can run at.',
      fields,
    };
  }

  const { speedMultiplier } = parsed.data;
  if (hasTooMuchPrecision(speedMultiplier)) {
    // Refused rather than rounded. `numeric(4,2)` would round 3.333 to 3.33 on
    // the way in, and an admin who typed 3.333 and was told "done" would be
    // looking at a world running at a speed they did not choose.
    return refuse(
      'invalid_speed',
      'speedMultiplier',
      `The speed is stored to ${String(SPEED_MULTIPLIER_DECIMALS)} decimal places, so ${String(speedMultiplier)} cannot be set exactly. Try ${speedMultiplier.toFixed(SPEED_MULTIPLIER_DECIMALS)}.`,
    );
  }

  return { ok: true, request: parsed.data };
}

/**
 * Re-anchors the world's clock to a new speed, and records it — one transaction.
 *
 * The row is locked `FOR UPDATE` before anything is read from it, so the
 * "expected speed" check, the arithmetic and the write cannot be interleaved
 * with another admin doing the same thing. The audit row goes in the same
 * transaction as every other M1A action: a record written afterwards is one that
 * can go missing exactly when the change was the one somebody wanted hidden.
 */
export async function changeWorldSpeed(
  db: Database,
  worldId: string,
  request: AdminSpeedChangeRequest,
  actor: Actor,
  now: Date = new Date(),
): Promise<SpeedOutcome> {
  return db.transaction(async (tx): Promise<SpeedOutcome> => {
    const rows = await tx.select().from(world).where(eq(world.id, worldId)).limit(1).for('update');
    const row = rows[0];
    if (!row) {
      return {
        ok: false,
        code: 'world_not_found',
        message: 'No world with that id.',
        fields: { form: ['That world no longer exists. Reload the list.'] },
      };
    }

    if (row.status === 'archived') {
      // An archived world is a record of something that happened. §22.2 keeps
      // them browsable forever, and re-anchoring one would rewrite the calendar
      // of a world nobody can play — changing history to no purpose.
      return refuse(
        'world_archived',
        'form',
        `"${row.name}" is archived. An archived world is a record of what happened, so its clock stays as it was.`,
      );
    }

    const before = clockOf(row);

    if (before.speedMultiplier !== request.expectedSpeedMultiplier) {
      // The confirmation named a speed. If it is not that any more, somebody
      // else changed it while this was on screen, and the sentence the admin
      // agreed to is no longer the one that would be carried out.
      return {
        ok: false,
        code: 'speed_stale',
        message: 'The world is no longer running at the speed you were shown.',
        fields: {
          form: [
            `"${row.name}" is running at ${before.speedMultiplier.toFixed(2)}×, not ${request.expectedSpeedMultiplier.toFixed(2)}× as shown. Somebody else changed it. Check the audit log, then decide again.`,
          ],
        },
      };
    }

    if (before.speedMultiplier === request.speedMultiplier) {
      // Not an error, but not a change either, and it must not write an audit
      // entry — a log full of "changed 2.00× to 2.00×" is a log nobody reads.
      return refuse(
        'speed_unchanged',
        'speedMultiplier',
        `"${row.name}" is already running at ${request.speedMultiplier.toFixed(2)}×.`,
      );
    }

    const pending = await tx
      .select({ n: count() })
      .from(worldEvent)
      .where(and(eq(worldEvent.worldId, worldId), eq(worldEvent.status, 'pending')));
    const pendingEvents = pending[0]?.n ?? 0;

    const reanchored = reanchorForSpeed(before, request.speedMultiplier, now);

    await tx
      .update(world)
      .set({
        launchDate: reanchored.launchDate,
        speedMultiplier: request.speedMultiplier.toFixed(SPEED_MULTIPLIER_DECIMALS),
      })
      .where(eq(world.id, worldId));

    // Read back rather than trusting the arithmetic, exactly as `resetWorld`
    // does. The claim being made is about what the world's clock now *is*, so it
    // is measured from the stored row — including whatever `numeric(4,2)` did to
    // the multiplier on the way in.
    const updatedRows = await tx.select().from(world).where(eq(world.id, worldId)).limit(1);
    const updated = updatedRows[0];
    if (!updated) throw new Error(`World ${worldId} vanished mid-transaction`);

    const beforeSnapshot = snapshot(before, now);
    const afterSnapshot = snapshot(clockOf(updated), now);
    const driftMs = Date.parse(afterSnapshot.inGameDate) - Date.parse(beforeSnapshot.inGameDate);

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'world.speed_changed',
      subjectType: 'world',
      subjectId: worldId,
      // The in-game date is in both halves on purpose: it is what the change
      // promised not to move, so the log carries its own evidence rather than
      // requiring someone to recompute it from `launch_date` months later.
      before: { ...beforeSnapshot, name: row.name },
      after: { ...afterSnapshot, name: row.name, pendingEvents, driftMs },
      requestId: actor.requestId,
    });

    return {
      ok: true,
      world: updated,
      before: beforeSnapshot,
      after: afterSnapshot,
      pendingEvents,
      driftMs,
    };
  });
}
