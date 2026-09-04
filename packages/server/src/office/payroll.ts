import { eq, inArray } from 'drizzle-orm';

import { moveAirlineCash } from '../airline/cash';
import { monthAfter, previousMonth } from '../crew/payroll';
import { cashMovement, executiveHire, officeHire } from '../db/schema';

import type { Database } from '../db/client';

/**
 * What the office costs every month (M5-04, §9.1).
 *
 * §9.1: office staff are salaried. This bills the salaries snapshotted on each
 * `office_hire` row for the game month that has just closed — the same shape,
 * and the same reasoning, as crew payroll (M5-02):
 *
 *   - **Idempotent by reference**, `office_salary:<airlineId>:<YYYY-MM>` in the
 *     world's own calendar. AIR-06 refuses a second movement with the same cause
 *     and reference, so this is attempted every tick and bills once, with no
 *     "last billed" column for ADR-0005 to have to reset on a world reset.
 *   - **Self-healing**: the closed month is retried for as long as the next one
 *     lasts, so a worker down over a month boundary bills when it returns.
 *   - **`occurredAt` is the instant the month closed**, fixed for the period, so
 *     a retry replays identical facts and does not trip AIR-06's contradiction
 *     guard. The salary is the one snapshotted on the row, so a hire or a
 *     catalogue retune mid-month cannot change the amount a replay presents.
 *   - **Insolvency is not modelled and payroll can cause it.** The office worked;
 *     payroll cannot refuse, so an airline that cannot pay goes negative, exactly
 *     as crew payroll does. §11's bankruptcy is not built, and inventing it here
 *     would be a far larger decision than this function.
 *
 * One movement per airline — the office is a single line on the ledger, unlike
 * crew's people-and-buildings split, because there is nothing here a player
 * would want to interrogate into parts. The C-Suite (Phase 2) is billed here too:
 * an `executive_hire` is a salaried head like any other, folded into the same
 * per-airline `office_salary` movement rather than given a line of its own.
 */

export interface OfficePayrollResult {
  /** Airlines billed on this run. Zero on every tick but the first of a month. */
  airlinesBilled: number;
  totalMinor: number;
}

/** Bill every airline in this world for the office month that has just ended. */
export async function runOfficePayroll(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<OfficePayrollResult> {
  const period = previousMonth(gameNow);
  const nextMonthStart = monthAfter(period);
  const occurredAt = new Date(`${nextMonthStart}-01T00:00:00.000Z`);

  const [officeRows, execRows] = await Promise.all([
    db
      .select({
        airlineId: officeHire.airlineId,
        monthlySalaryMinor: officeHire.monthlySalaryMinor,
      })
      .from(officeHire)
      .where(eq(officeHire.worldId, worldId)),
    db
      .select({
        airlineId: executiveHire.airlineId,
        monthlySalaryMinor: executiveHire.monthlySalaryMinor,
      })
      .from(executiveHire)
      .where(eq(executiveHire.worldId, worldId)),
  ]);

  const owed = new Map<string, number>();
  for (const row of [...officeRows, ...execRows]) {
    owed.set(row.airlineId, (owed.get(row.airlineId) ?? 0) + row.monthlySalaryMinor);
  }
  if (owed.size === 0) return { airlinesBilled: 0, totalMinor: 0 };

  // What has already been billed for this period, in one indexed lookup, so the
  // ordinary post-first-of-month tick never reaches AIR-06's replay guard.
  const already = new Set(
    (
      await db
        .select({ reference: cashMovement.reference })
        .from(cashMovement)
        .where(
          inArray(
            cashMovement.reference,
            [...owed.keys()].map((airlineId) => `office_salary:${airlineId}:${period}`),
          ),
        )
    ).map((row) => row.reference),
  );

  let airlinesBilled = 0;
  let totalMinor = 0;

  for (const [airlineId, amount] of owed) {
    if (amount <= 0) continue;
    const reference = `office_salary:${airlineId}:${period}`;
    if (already.has(reference)) continue;

    const result = await db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor: -amount,
        cause: 'office_salary',
        reference,
        occurredAt,
      }),
    );
    if (result.status !== 'already-applied') {
      airlinesBilled += 1;
      totalMinor += amount;
    }
  }

  return { airlinesBilled, totalMinor };
}
