import { and, eq, inArray } from 'drizzle-orm';

import { moveAirlineCash } from '../airline/cash';
import { monthAfter, previousMonth } from '../crew/payroll';
import { cashMovement, groundSelfHandling } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * What a station you handle yourself costs every month (M5-06, §9.3).
 *
 * §9.3 offers self-handling as *"an alternative requiring a station and
 * headcount"*, and this is the half that makes it an alternative rather than a
 * free upgrade. The trade is **fixed cost against per-turn cost**: a vendor bills
 * a turn, your own people bill a month, and payroll does not shrink when the
 * schedule does. That is the whole decision — self-handling wins at a hub with
 * real volume and loses badly at a station you serve once a day — and none of it
 * exists until the heads are actually paid.
 *
 * ## The same shape as crew payroll, deliberately
 *
 * Idempotent by `ground_self_handling_payroll:<airlineId>:<YYYY-MM>` in the
 * world's own calendar, with the month's references read up front. Both halves
 * of that matter and `crew/payroll.ts` explains why at length: AIR-06's replay
 * guard asserts a movement is replayed with the **same facts**, so an amount that
 * moves when the airline restaffs mid-month, or an `occurredAt` of `gameNow`,
 * would make every tick after the first of a month throw rather than no-op. So
 * `occurredAt` is the instant the billed month closed, and the airlines already
 * holding the reference are skipped before AIR-06 ever sees them.
 *
 * No "last billed" column, for ADR-0005's reason: it would have to be reset on a
 * world reset, and forgetting would leave a fresh world believing it had paid.
 *
 * ## Insolvency is not modelled, and this can cause it
 *
 * The ramp agents worked, so payroll cannot refuse: an airline that cannot make
 * it **goes negative**, exactly as with crew. What must not happen is the bill
 * silently skipping, which would make self-handling free and the decision above
 * meaningless.
 */

export interface GroundPayrollResult {
  /** Airlines billed on this run. Zero on every tick but the first of a month. */
  airlinesBilled: number;
  totalMinor: number;
  /** Heads paid for across the world, so a heartbeat can say how big this is. */
  headcount: number;
}

/**
 * Bill every airline in this world for the game month that has just ended.
 *
 * `gameNow` is the world's clock. The period billed is the *previous* calendar
 * month in that clock, so nothing is charged for a month still being worked.
 */
export async function runGroundPayroll(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<GroundPayrollResult> {
  const period = previousMonth(gameNow);
  const occurredAt = new Date(`${monthAfter(period)}-01T00:00:00.000Z`);
  const economy = await loadWorldEconomyConfig(db, worldId);
  const perHead = economy.ground.selfHandling.salaryPerHeadMinor;

  const rows = await db
    .select({
      airlineId: groundSelfHandling.airlineId,
      headcount: groundSelfHandling.headcount,
    })
    .from(groundSelfHandling)
    .where(and(eq(groundSelfHandling.worldId, worldId), eq(groundSelfHandling.status, 'active')));

  const heads = new Map<string, number>();
  for (const row of rows) {
    heads.set(row.airlineId, (heads.get(row.airlineId) ?? 0) + row.headcount);
  }
  if (heads.size === 0 || perHead <= 0) {
    return { airlinesBilled: 0, totalMinor: 0, headcount: 0 };
  }

  const already = new Set(
    (
      await db
        .select({ reference: cashMovement.reference })
        .from(cashMovement)
        .where(
          inArray(
            cashMovement.reference,
            [...heads.keys()].map(
              (airlineId) => `ground_self_handling_payroll:${airlineId}:${period}`,
            ),
          ),
        )
    ).map((row) => row.reference),
  );

  let airlinesBilled = 0;
  let totalMinor = 0;
  let headcount = 0;

  for (const [airlineId, count] of heads) {
    headcount += count;
    const reference = `ground_self_handling_payroll:${airlineId}:${period}`;
    if (already.has(reference)) continue;

    const amount = perHead * count;
    if (amount <= 0) continue;

    /*
     * In a transaction, like every other payroll. `moveAirlineCash` inserts the
     * movement and *then* updates the balance, and the constraint trigger that
     * reconciles the two is deferred to commit — so calling it outside a
     * transaction commits the insert on its own and the trigger refuses a balance
     * that has not moved yet.
     */
    const result = await db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor: -amount,
        cause: 'ground_self_handling_payroll',
        reference,
        occurredAt,
      }),
    );
    if (result.status !== 'already-applied') {
      airlinesBilled += 1;
      totalMinor += amount;
    }
  }

  return { airlinesBilled, totalMinor, headcount };
}
