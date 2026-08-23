import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { moveAirlineCash } from '../airline/cash';
import { airline } from '../db/schema';

import { writeAudit } from './audit';

import type { Actor } from './grants';
import type { Database } from '../db/client';

/**
 * Operator cash adjustments (AIR-06, §22).
 *
 * ## Why this exists at all, when the console deliberately has none
 *
 * The airline support record has no cash field you can edit, and that stays
 * true: CLAUDE.md's rule is that **money moves only through AIR-06**, and a
 * console that let someone type a new balance would be a second way for money to
 * exist. This is not that. It writes an ordinary immutable movement with its own
 * cause, a reference, a reconciled `balance_after_minor` and an audit row — the
 * same path a lease deposit or a flight settlement takes.
 *
 * ## Why a command line rather than a route
 *
 * There is no HTTP endpoint for this, on purpose. A route that creates money is
 * worth attacking however well it is guarded, and the operator actions that
 * genuinely need to exist outside the console already live in `admin-cli.ts`
 * behind the one credential that cannot be phished — a shell on the server.
 *
 * ## Why its own cause
 *
 * `admin_adjustment` rather than reusing `migration_opening_balance` or
 * `flight_settlement`. The ledger is the account of what happened, and a
 * compensating grant recorded as a flight settlement is a lie that nobody can
 * later untangle from the real ones. A new cause costs one migration and keeps
 * every existing figure honest.
 */

export type AdjustCashResult =
  | { ok: true; balanceAfterMinor: number; movementId: string }
  | { ok: false; code: 'airline_not_found' | 'zero_amount' | 'would_overdraw' };

export interface AdjustCashInput {
  airlineId: string;
  /** Signed minor units. Negative claws money back, which is the same movement. */
  amountMinor: number;
  /** Free text, recorded on the audit row. Say why, not what. */
  reason: string;
}

export async function adjustAirlineCash(
  db: Database,
  actor: Actor,
  input: AdjustCashInput,
): Promise<AdjustCashResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor === 0) {
    return { ok: false, code: 'zero_amount' };
  }

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: airline.id, name: airline.name, cashMinor: airline.cashMinor })
        .from(airline)
        .where(eq(airline.id, input.airlineId))
        .limit(1);
      const found = rows[0];
      if (!found) return { ok: false, code: 'airline_not_found' as const };

      const reference = randomUUID();
      const movement = await moveAirlineCash(tx, {
        airlineId: found.id,
        amountMinor: input.amountMinor,
        cause: 'admin_adjustment',
        reference,
        occurredAt: new Date(),
      });

      /*
       * A negative balance is refused rather than recorded. AIR-11 removed the
       * zero-cash state and nothing else in the game can take an airline below
       * zero; an operator's typo should not be the one thing that can.
       */
      if (movement.movement.balanceAfterMinor < 0) throw new Overdraw();

      await writeAudit(tx, {
        actorPlayerId: actor.playerId,
        actorLabel: actor.label,
        action: 'airline.cash_adjusted',
        subjectType: 'airline',
        subjectId: found.id,
        before: { cashMinor: found.cashMinor },
        after: {
          cashMinor: movement.movement.balanceAfterMinor,
          amountMinor: input.amountMinor,
          reason: input.reason,
          movementReference: reference,
        },
        requestId: actor.requestId,
      });

      return {
        ok: true as const,
        balanceAfterMinor: movement.movement.balanceAfterMinor,
        movementId: movement.movement.id,
      };
    });
  } catch (error) {
    if (error instanceof Overdraw) return { ok: false, code: 'would_overdraw' };
    throw error;
  }
}

/** Thrown inside the transaction so the movement rolls back with it. */
class Overdraw extends Error {
  constructor() {
    super('The adjustment would take the airline below zero');
  }
}
