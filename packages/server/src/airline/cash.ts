/**
 * The only application path that changes `airline.cash_minor` (AIR-06).
 *
 * Callers pass the transaction that contains the cause. The airline row is
 * locked, the idempotency row is inserted, and the resulting balance is stored
 * before that transaction can commit. Calling this against a bare database
 * handle would split those statements across commits and is therefore not a
 * supported use; founding and settlement both already own the right transaction.
 */

import { and, eq, sql } from 'drizzle-orm';

import { airline, cashMovement } from '../db/schema';

import type { Database } from '../db/client';
import type { CashMovementCause, CashMovementRow } from '../db/schema';

export interface MoveAirlineCashInput {
  airlineId: string;
  amountMinor: number;
  cause: CashMovementCause;
  /** Stable identity of the cause: a flight id or the newly founded airline id. */
  reference: string;
  /** Game time for simulation causes; founding time for the opening grant. */
  occurredAt: Date;
}

export type MoveAirlineCashResult =
  | { status: 'applied'; movement: CashMovementRow }
  | { status: 'already-applied'; movement: CashMovementRow };

function validateInput(input: MoveAirlineCashInput): void {
  if (!Number.isSafeInteger(input.amountMinor)) {
    throw new RangeError('Cash movement amount must be a safe integer number of minor units');
  }
  if (input.reference === '' || input.reference !== input.reference.trim()) {
    throw new Error('Cash movement reference must be non-blank and trimmed');
  }
  if (!Number.isFinite(input.occurredAt.getTime())) {
    throw new Error('Cash movement occurredAt must be a valid date');
  }
}

function assertSameCause(existing: CashMovementRow, input: MoveAirlineCashInput): CashMovementRow {
  if (
    existing.airlineId !== input.airlineId ||
    existing.amountMinor !== input.amountMinor ||
    existing.occurredAt.getTime() !== input.occurredAt.getTime()
  ) {
    throw new Error(
      `Cash movement ${input.cause}:${input.reference} was replayed with different facts`,
    );
  }
  return existing;
}

async function movementForCause(
  tx: Database,
  cause: CashMovementCause,
  reference: string,
): Promise<CashMovementRow | undefined> {
  const rows = await tx
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.cause, cause), eq(cashMovement.reference, reference)))
    .limit(1);
  return rows[0];
}

/**
 * Record one cause and move the balance exactly once.
 *
 * The unique `(cause, reference)` constraint is the authority. The lookup gives
 * clean replay behavior; `onConflictDoNothing` closes the race if another
 * transaction inserts the same cause after that lookup.
 */
export async function moveAirlineCash(
  tx: Database,
  input: MoveAirlineCashInput,
): Promise<MoveAirlineCashResult> {
  validateInput(input);

  // Serialises every balance movement for this airline. Each caller therefore
  // computes from the balance left by the preceding committed movement.
  const airlines = await tx
    .select({ id: airline.id, cashMinor: airline.cashMinor })
    .from(airline)
    .where(eq(airline.id, input.airlineId))
    .limit(1)
    .for('update');
  const current = airlines[0];
  if (!current) throw new Error(`Cannot move cash for unknown airline ${input.airlineId}`);

  const replay = await movementForCause(tx, input.cause, input.reference);
  if (replay) {
    return { status: 'already-applied', movement: assertSameCause(replay, input) };
  }

  const balanceAfterMinor = current.cashMinor + input.amountMinor;
  if (!Number.isSafeInteger(balanceAfterMinor)) {
    throw new RangeError('Cash movement would take the airline balance outside safe integers');
  }

  const inserted = await tx
    .insert(cashMovement)
    .values({ ...input, balanceAfterMinor })
    .onConflictDoNothing({ target: [cashMovement.cause, cashMovement.reference] })
    .returning();
  const created = inserted[0];

  if (!created) {
    const winner = await movementForCause(tx, input.cause, input.reference);
    if (!winner) {
      throw new Error(`Cash movement ${input.cause}:${input.reference} lost without a winner`);
    }
    return { status: 'already-applied', movement: assertSameCause(winner, input) };
  }

  const updated = await tx
    .update(airline)
    .set({ cashMinor: balanceAfterMinor })
    .where(eq(airline.id, input.airlineId))
    .returning({ cashMinor: airline.cashMinor });
  if (updated[0]?.cashMinor !== balanceAfterMinor) {
    throw new Error(`Airline ${input.airlineId} vanished while its cash movement was recorded`);
  }

  return { status: 'applied', movement: created };
}

export interface CashReconciliation {
  airlineId: string;
  balanceMinor: number;
  movementTotalMinor: number;
  reconciles: boolean;
}

/** Fold the movement log and compare it with the materialised current balance. */
export async function reconcileAirlineCash(
  db: Database,
  airlineId: string,
): Promise<CashReconciliation | null> {
  const rows = await db
    .select({
      airlineId: airline.id,
      balanceMinor: airline.cashMinor,
      // Raw aggregates do not use the bigint column parser; normalise explicitly.
      movementTotalMinor: sql<string>`coalesce(sum(${cashMovement.amountMinor}), 0)::text`,
    })
    .from(airline)
    .leftJoin(cashMovement, eq(cashMovement.airlineId, airline.id))
    .where(eq(airline.id, airlineId))
    .groupBy(airline.id, airline.cashMinor);

  const row = rows[0];
  if (!row) return null;
  const movementTotalMinor = Number(row.movementTotalMinor);
  if (!Number.isSafeInteger(movementTotalMinor)) {
    throw new RangeError(`Movement total for airline ${airlineId} is outside safe integers`);
  }
  return {
    airlineId: row.airlineId,
    balanceMinor: row.balanceMinor,
    movementTotalMinor,
    reconciles: row.balanceMinor === movementTotalMinor,
  };
}
