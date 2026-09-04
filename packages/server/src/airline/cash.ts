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

import { airline, cashMovement, ledgerEntry } from '../db/schema';

import type { Database } from '../db/client';
import type { CashMovementCause, CashMovementRow, LedgerCategory } from '../db/schema';

/** A dimensional line that explains part of a cash movement. */
export interface LedgerLineInput {
  amountMinor: number;
  category: LedgerCategory;
  counterparty?: string;
  flightId?: string | null;
  routeId?: string | null;
  aircraftId?: string | null;
  hubId?: string | null;
  cabinClass?: 'economy' | 'premium_economy' | 'business' | 'first' | null;
}

export interface MoveAirlineCashInput {
  airlineId: string;
  amountMinor: number;
  cause: CashMovementCause;
  /** Stable identity of the cause: a flight id or the newly founded airline id. */
  reference: string;
  /** Game time for simulation causes; founding time for the opening grant. */
  occurredAt: Date;
  /**
   * Optional itemisation. When omitted, one honest line is generated from the
   * cause. When present, the signed line amounts must sum to amountMinor.
   */
  ledgerLines?: readonly LedgerLineInput[];
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
  if (input.ledgerLines) {
    if (input.ledgerLines.length === 0)
      throw new Error('A ledger movement needs at least one line');
    let total = 0;
    for (const line of input.ledgerLines) {
      if (!Number.isSafeInteger(line.amountMinor)) {
        throw new RangeError('Ledger line amount must be a safe integer number of minor units');
      }
      if (
        line.counterparty !== undefined &&
        (line.counterparty === '' || line.counterparty !== line.counterparty.trim())
      ) {
        throw new Error('Ledger counterparty must be non-blank and trimmed');
      }
      total += line.amountMinor;
    }
    if (!Number.isSafeInteger(total) || total !== input.amountMinor) {
      throw new Error('Ledger line amounts must sum exactly to the cash movement amount');
    }
  }
}

/** Existing causes remain meaningful when they are projected into M8-01. */
function categoryForCause(cause: CashMovementCause): LedgerCategory {
  switch (cause) {
    case 'airline_founding':
      return 'equity';
    case 'airline_rebrand':
      return 'repaint_retrofit';
    case 'aircraft_lease_deposit':
      return 'asset_deposit';
    case 'aircraft_used_purchase':
    case 'aircraft_new_purchase':
      return 'aircraft_purchase';
    case 'maintenance_check':
      return 'maintenance';
    case 'crew_base_opening':
    case 'crew_hiring':
    case 'crew_conversion':
    case 'crew_payroll':
    case 'crew_base_overhead':
    case 'crew_positioning':
      return 'crew';
    case 'office_salary':
      return 'office_salary';
    /*
     * All three are ground handling in a P&L, and §14.1's rule is that a figure
     * must be interrogable rather than that every cause needs its own category: a
     * player asking *"what did handling cost me"* wants the penalty, the shortfall
     * and the payroll in that answer, and the `cause` on the movement is what
     * separates them when they ask which.
     */
    case 'ground_contract_penalty':
    case 'ground_volume_shortfall':
    case 'ground_self_handling_payroll':
      return 'ground_handling';
    case 'office_expansion':
    case 'executive_floor':
    case 'executive_office':
    case 'disruption_cost':
      return 'other';
    case 'admin_adjustment':
      return 'equity';
    case 'migration_opening_balance':
      return 'opening_balance';
    case 'flight_settlement':
      return 'other';
  }
}

function defaultLedgerLine(input: MoveAirlineCashInput): LedgerLineInput {
  return {
    amountMinor: input.amountMinor,
    category: categoryForCause(input.cause),
    counterparty: 'system',
  };
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
    .select({ id: airline.id, worldId: airline.worldId, cashMinor: airline.cashMinor })
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
    .values({
      airlineId: input.airlineId,
      amountMinor: input.amountMinor,
      cause: input.cause,
      reference: input.reference,
      occurredAt: input.occurredAt,
      balanceAfterMinor,
    })
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

  const lines = input.ledgerLines ?? [defaultLedgerLine(input)];
  await tx.insert(ledgerEntry).values(
    lines.map((line, index) => ({
      worldId: current.worldId,
      airlineId: input.airlineId,
      cashMovementId: created.id,
      lineNumber: index + 1,
      amountMinor: line.amountMinor,
      category: line.category,
      counterparty: line.counterparty ?? 'system',
      flightId: line.flightId ?? null,
      routeId: line.routeId ?? null,
      aircraftId: line.aircraftId ?? null,
      hubId: line.hubId ?? null,
      cabinClass: line.cabinClass ?? null,
      occurredAt: input.occurredAt,
    })),
  );

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
