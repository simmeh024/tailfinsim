import { and, eq } from 'drizzle-orm';

import type { CrewBalance } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { crewBase, crewPool } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * What crew cost every month (M5-02, §9.2).
 *
 * ## Why this is M5-02's and not M5-01's
 *
 * §9.2 says reserve crew *"cost money and do nothing most days — until they save
 * your on-time performance. Deliberately a hard call."* M5-02's third acceptance
 * criterion asks for both halves, and the second half is not optional dressing:
 * a standby crew that is free is not a hard call, it is an obvious one, and the
 * mechanic collapses into "always keep reserves".
 *
 * M5-01 tuned the salaries and charged nothing, noting at the time that
 * *"whichever milestone starts billing them does not inherit numbers chosen when
 * nothing read them"*. This is that milestone.
 *
 * ## Idempotent by reference, with no bookkeeping table
 *
 * The reference is `<cause>:<airlineId>:<YYYY-MM>` in the world's own
 * calendar, and `moveAirlineCash` already refuses a second movement with the
 * same cause and reference — that is AIR-06's identity rule, not a new one. So
 * payroll can be attempted on **every tick** and bills once, and a "last billed"
 * column is not needed. Which matters more than it saves: ADR-0005 would require
 * such a column to be reset on a world reset, and forgetting would leave a fresh
 * world believing it had already paid.
 *
 * It also self-heals. The month just ended is retried for as long as the
 * following month lasts, so a worker that was down over a month boundary bills
 * the moment it comes back rather than skipping a payday.
 *
 * ## Insolvency is not modelled, and payroll can cause it
 *
 * Every other spend in the game is player-initiated and refuses when the money
 * is not there. Payroll cannot refuse — the crew worked — so **an airline that
 * cannot make payroll goes negative**, and nothing yet acts on a negative
 * balance. That is a real gap rather than an oversight: §11's bankruptcy is not
 * built, and inventing one here would be a much larger decision than this
 * function. What must not happen is payroll silently skipping, which would make
 * the cheapest strategy in the game "run out of money".
 */

export interface PayrollResult {
  /** Airlines billed on this run. Zero on every tick but the first of a month. */
  airlinesBilled: number;
  totalMinor: number;
}

/**
 * Bill every airline in this world for the game month that has just ended.
 *
 * `gameNow` is the world's clock. The period billed is the *previous* calendar
 * month in that clock, so nothing is charged for a month still being worked.
 */
export async function runCrewPayroll(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<PayrollResult> {
  const period = previousMonth(gameNow);
  const economy = await loadWorldEconomyConfig(db, worldId);

  const rows = await db
    .select({
      airlineId: crewBase.airlineId,
      crewBaseId: crewBase.id,
      rank: crewPool.rank,
      headcount: crewPool.headcount,
    })
    .from(crewBase)
    .leftJoin(crewPool, eq(crewPool.crewBaseId, crewBase.id))
    .where(and(eq(crewBase.worldId, worldId), eq(crewBase.status, 'open')));

  const bills = new Map<
    string,
    { salaryMinor: number; overheadMinor: number; bases: Set<string> }
  >();
  for (const row of rows) {
    let bill = bills.get(row.airlineId);
    if (!bill) {
      bill = { salaryMinor: 0, overheadMinor: 0, bases: new Set() };
      bills.set(row.airlineId, bill);
    }
    bill.bases.add(row.crewBaseId);
    if (row.rank !== null && row.headcount !== null) {
      bill.salaryMinor += salaryFor(row.rank, economy.crew) * row.headcount;
    }
  }
  for (const bill of bills.values()) {
    bill.overheadMinor = economy.crew.base.monthlyOverheadMinor * bill.bases.size;
  }

  let airlinesBilled = 0;
  let totalMinor = 0;

  for (const [airlineId, bill] of bills) {
    /*
     * Two movements, not one. §14.1 forbids a figure a player cannot
     * interrogate, and *"why did I pay 4.2 million"* has two answers — the
     * people and the buildings — that a single line would fuse into a number
     * nobody can argue with. They are separate causes for the same reason
     * `crew_hiring` and `crew_base_opening` are.
     */
    const billed = await db.transaction(async (tx) => {
      let moved = 0;
      for (const [amount, cause] of [
        [bill.salaryMinor, 'crew_payroll'],
        [bill.overheadMinor, 'crew_base_overhead'],
      ] as const) {
        if (amount <= 0) continue;
        const result = await moveAirlineCash(tx, {
          airlineId,
          amountMinor: -amount,
          cause,
          reference: `${cause}:${airlineId}:${period}`,
          occurredAt: gameNow,
        });
        if (result.status !== 'already-applied') moved += amount;
      }
      return moved;
    });

    if (billed > 0) {
      airlinesBilled += 1;
      totalMinor += billed;
    }
  }

  return { airlinesBilled, totalMinor };
}

/**
 * Charge the hotels and deadhead seats a duty period owed (§9.2).
 *
 * Called when a crew set goes off duty away from a base. Idempotent by the duty
 * period id, so a retry or two workers racing bill one night rather than two.
 *
 * §9.2 names this cost specifically — *"an aircraft night-stopping away from
 * base needs crew hotelling"* — and it is the one a player creates by accident,
 * because a rotation that ends where it started looks symmetric on the map and a
 * rotation that does not looks almost the same.
 */
export async function chargePositioning(
  db: Database,
  input: {
    airlineId: string;
    dutyPeriodId: string;
    heads: number;
    nights: number;
    occurredAt: Date;
    duty: CrewBalance['duty'];
  },
): Promise<number> {
  const amount = Math.round(
    input.duty.hotelCostPerHeadPerNightMinor * Math.max(1, input.nights) * input.heads,
  );
  if (amount <= 0) return 0;

  await moveAirlineCash(db, {
    airlineId: input.airlineId,
    amountMinor: -amount,
    cause: 'crew_positioning',
    reference: input.dutyPeriodId,
    occurredAt: input.occurredAt,
  });
  return amount;
}

function salaryFor(rank: string, crew: CrewBalance): number {
  const deck = crew.flightDeckSalaryMinor as Record<string, number | undefined>;
  const cabin = crew.cabinSalaryMinor as Record<string, number | undefined>;
  return deck[rank] ?? cabin[rank] ?? 0;
}

/**
 * `2024-10` for a clock reading any time in November 2024.
 *
 * UTC, like every other instant in the game. A world's calendar has no timezone
 * of its own, and picking one would make payday depend on where the airline's
 * hub happens to be.
 */
export function previousMonth(at: Date): string {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const previous = month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
  return `${String(previous.year)}-${String(previous.month + 1).padStart(2, '0')}`;
}
