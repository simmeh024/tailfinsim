import { randomUUID } from 'node:crypto';

import { and, eq, isNull, lt, or } from 'drizzle-orm';

import { moveAirlineCash } from '../airline/cash';
import { groundSelfHandling } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';
import type { PinnedEconomyConfig } from '../economy/config';

/**
 * What a station you handle yourself costs (M5-06, §9.3).
 *
 * §9.3 offers self-handling as *"an alternative requiring a station and
 * headcount"*, and this is the half that makes it an alternative rather than a
 * free upgrade. The trade is **fixed cost against per-turn cost**: a vendor bills
 * a turn, your own people bill by the day, and payroll does not shrink when the
 * schedule does. That is the whole decision — self-handling wins at a hub with
 * real volume and loses badly at a station you serve once a day.
 *
 * ## An accrual, not a monthly snapshot
 *
 * The first version billed the **previous** month against whatever headcount was
 * active when the sweep happened to run. Because staffing is free and instant to
 * change, that was trivially avoidable: run 40 heads all month, drop to 1 on the
 * last day, get billed for 1, restaff to 40. Repeatable every month with no
 * operational downtime, which made self-handling free and therefore strictly
 * better than any vendor at any station — the opposite of the trade above.
 *
 * So the money accrues instead. `billed_through_at` is how far each operation has
 * been paid up to, and the accrual is settled at three moments:
 *
 *   - **the month boundary**, so the ordinary bill still arrives monthly rather
 *     than as a dribble of movements;
 *   - **whenever the headcount changes**, which is what closes the hole: the
 *     reduction itself pays for the period the larger staff actually worked;
 *   - **when the operation closes**, so a station used for half a month pays for
 *     half a month.
 *
 * Crew payroll can safely read the headcount at billing time because hiring costs
 * money per head and is capped by `weeklyHiringCapacity`. Ground handling has
 * neither guard, so it needs this one.
 *
 * ## Idempotency without a replay guard
 *
 * `billed_through_at` *is* the guard: a settlement charges the span between it
 * and the instant asked for, then advances it, both in one transaction. A repeat
 * finds a zero-length span and charges nothing, so the AIR-06 reference can be a
 * fresh uuid — each settlement is a distinct event rather than a replay of one,
 * which is the same choice `hireCrew` makes and avoids the trap `crew/payroll.ts`
 * documents at length about an amount that moves between attempts.
 *
 * No "last billed" column on `world`: this one lives on the operation's own row,
 * which is world-scoped and cascade-deleted, so ADR-0005's objection does not
 * apply — a reset takes the row and its watermark together.
 *
 * ## Insolvency is not modelled, and this can cause it
 *
 * The ramp agents worked, so payroll cannot refuse: an airline that cannot make
 * it **goes negative**, exactly as with crew. What must not happen is the bill
 * silently skipping, which is what made the decision above meaningless.
 */

/**
 * Days in the month a monthly salary is quoted against.
 *
 * A year of daily accrual comes to exactly twelve monthly salaries, which is what
 * a player reading "$1,500 a month" will expect. A flat 30 would quietly charge
 * 12.17 salaries a year, and using each calendar month's real length would make
 * February cheaper than March for no reason anybody could act on.
 */
const DAYS_PER_MONTH = 365 / 12;

const MS_PER_DAY = 86_400_000;

/** Midnight on the first of the game month `at` falls in, UTC. */
export function startOfGameMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** What one operation owes for the span it has not been billed for. */
function accruedMinor(
  headcount: number,
  from: Date,
  to: Date,
  economy: PinnedEconomyConfig,
): number {
  const days = (to.getTime() - from.getTime()) / MS_PER_DAY;
  if (!Number.isFinite(days) || days <= 0) return 0;
  const perHeadPerDay = economy.ground.selfHandling.salaryPerHeadMinor / DAYS_PER_MONTH;
  return Math.round(headcount * perHeadPerDay * days);
}

export interface GroundPayrollResult {
  /** Airlines billed on this run. Zero on every tick but the first of a month. */
  airlinesBilled: number;
  totalMinor: number;
  /** Heads paid for on this run, so a heartbeat can say how big the bill was. */
  headcount: number;
}

/**
 * Settle one operation's accrual up to `upTo`, inside the caller's transaction.
 *
 * Called by the mutation paths — restaffing and closing — so the period worked at
 * the old headcount is paid for before the headcount changes. Returns what was
 * charged, which is zero when nothing has accrued.
 *
 * The row is locked `for update` because two writers can reach the same operation
 * (a restaff racing the monthly sweep), and both would otherwise read the same
 * watermark and bill the same span twice.
 */
export async function settleSelfHandlingAccrual(
  tx: Database,
  operationId: string,
  upTo: Date,
  economy: PinnedEconomyConfig,
): Promise<number> {
  const [row] = await tx
    .select({
      airlineId: groundSelfHandling.airlineId,
      headcount: groundSelfHandling.headcount,
      openedAt: groundSelfHandling.openedAt,
      billedThroughAt: groundSelfHandling.billedThroughAt,
    })
    .from(groundSelfHandling)
    .where(eq(groundSelfHandling.id, operationId))
    .limit(1)
    .for('update');
  if (!row) return 0;

  // Null means never settled, so the operation is paid up to the day it opened.
  const from = row.billedThroughAt ?? row.openedAt;
  const amount = accruedMinor(row.headcount, from, upTo, economy);
  if (amount <= 0) return 0;

  await tx
    .update(groundSelfHandling)
    .set({ billedThroughAt: upTo })
    .where(eq(groundSelfHandling.id, operationId));

  await moveAirlineCash(tx, {
    airlineId: row.airlineId,
    amountMinor: -amount,
    cause: 'ground_self_handling_payroll',
    // A fresh reference per settlement: this is a distinct event, not a replay of
    // one. `billed_through_at` is what stops it happening twice.
    reference: randomUUID(),
    occurredAt: upTo,
  });
  return amount;
}

/**
 * Bill every self-handled station in this world for the game months that have
 * closed.
 *
 * `gameNow` is the world's clock. Settlement stops at the **start of the current
 * game month**, so nothing is charged for a month still being worked — the same
 * property crew and office payroll have. An operation already paid up to that
 * instant is skipped, which is what keeps this a no-op on all but the first tick
 * of a month.
 *
 * A worker that was down across a boundary self-heals: the watermark is still
 * behind, so the next tick settles the whole span at once.
 */
export async function runGroundPayroll(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<GroundPayrollResult> {
  const upTo = startOfGameMonth(gameNow);
  const economy = await loadWorldEconomyConfig(db, worldId);

  const rows = await db
    .select({
      id: groundSelfHandling.id,
      airlineId: groundSelfHandling.airlineId,
      headcount: groundSelfHandling.headcount,
    })
    .from(groundSelfHandling)
    .where(
      and(
        eq(groundSelfHandling.worldId, worldId),
        eq(groundSelfHandling.status, 'active'),
        /*
         * Owing something for a closed month. A `null` watermark never satisfies
         * `<` in SQL, so an operation that has never been settled is matched on
         * `opened_at` instead — which is the instant its accrual starts from.
         */
        or(
          lt(groundSelfHandling.billedThroughAt, upTo),
          and(isNull(groundSelfHandling.billedThroughAt), lt(groundSelfHandling.openedAt, upTo)),
        ),
      ),
    );
  if (rows.length === 0) return { airlinesBilled: 0, totalMinor: 0, headcount: 0 };

  const billedAirlines = new Set<string>();
  let totalMinor = 0;
  let headcount = 0;

  for (const row of rows) {
    const amount = await db.transaction((tx) =>
      settleSelfHandlingAccrual(tx, row.id, upTo, economy),
    );
    if (amount > 0) {
      billedAirlines.add(row.airlineId);
      totalMinor += amount;
      headcount += row.headcount;
    }
  }

  return { airlinesBilled: billedAirlines.size, totalMinor, headcount };
}
