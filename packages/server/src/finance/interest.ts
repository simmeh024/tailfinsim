import { and, eq, inArray, sql } from 'drizzle-orm';

import { dailyInterestMinor, wholeGameDays } from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { airline, loan } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * §13.4's live drain: interest, charged per in-game day (M8-07).
 *
 * > Interest accrues **per in-game day** and appears in the daily P&L as its own
 * > line. It is never hidden in a summary. Players should watch it eat the
 * > margin in real time.
 *
 * ## One movement per loan per game day
 *
 * The obvious cheaper design — one movement covering however many days the sweep
 * has fallen behind — is the one thing §13.4 forbids. A P&L asked for *Tuesday*
 * would answer with Sunday, Monday and Tuesday's interest on Tuesday's line, so
 * the day the player is watching shows a drain three times its real size and the
 * two before it show none. So the sweep walks whole game days, and each day's
 * charge is dated on the day it belongs to.
 *
 * That makes catching up proportional to the days missed, which is the correct
 * cost: a worker that was down for a game week owes a game week of lines.
 *
 * ## The watermark, not a remembered run
 *
 * `loan.interest_accrued_through_at` is how far interest has been charged, and a
 * **null means never** — read as `drawn_at`, the instant the money arrived. The
 * sweep is therefore idempotent by the same argument the used market's unique
 * constraint makes: running it twice in one game day charges nothing the second
 * time, because no whole day is left between the mark and now.
 *
 * ## A shortfall is arrears, not an overdraft
 *
 * Cash may go negative in this game, so *"the airline cannot pay"* has to be
 * decided rather than discovered. It pays what it has and the rest becomes
 * `loan.arrears_minor` — §13.5's *"missed payment"*, and the only thing the
 * default ladder watches. Arrears are deliberately **not** rolled into the
 * principal: compounding a missed payment into the debt would make the ladder
 * accelerate away from an airline trying to climb out of it, and §13.5's whole
 * point is that it must be climbable.
 *
 * Arrears are paid **before** the day's interest when cash allows, so an airline
 * that returns to profit clears its own way off the ladder without a page to
 * visit or a button to find.
 */

/** What one sweep of one world did. */
export interface InterestAccrualResult {
  /** Game days charged across every loan — the unit the P&L lines are in. */
  daysCharged: number;
  /** Loans that had at least one day charged. */
  loansCharged: number;
  /** Interest actually paid in cash, minor units. */
  paidMinor: number;
  /** Interest that could not be paid and became arrears, minor units. */
  arrearsAddedMinor: number;
  /** Arrears settled from cash this sweep, minor units. */
  arrearsClearedMinor: number;
}

const EMPTY: InterestAccrualResult = {
  daysCharged: 0,
  loansCharged: 0,
  paidMinor: 0,
  arrearsAddedMinor: 0,
  arrearsClearedMinor: 0,
};

/**
 * The most game days one sweep will charge for a single loan.
 *
 * A bound rather than a limit: the remaining days are charged by the next tick,
 * and the ticks are a second apart. It exists so that a loan in a world whose
 * clock has jumped — a speed change, a long outage, a restored backup — cannot
 * make one tick write thousands of movements and block every sweep behind it.
 * Sixty days is comfortably more than any tick gap and small enough to stay one
 * fast transaction.
 */
const MAX_DAYS_PER_SWEEP = 60;

const DAY_MS = 86_400_000;

/** The instant `days` whole game days after `from`. */
function plusDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Charge every active loan in this world the game days it owes.
 *
 * Per loan, in its own transaction — `moveAirlineCash` requires one, and one
 * loan that cannot be charged must not stop the others. Errors propagate to the
 * caller's counter rather than being swallowed here.
 */
export async function accrueLoanInterest(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<InterestAccrualResult> {
  const rows = await db
    .select({
      id: loan.id,
      airlineId: loan.airlineId,
      outstandingMinor: loan.outstandingMinor,
      arrearsMinor: loan.arrearsMinor,
      annualRateBps: loan.annualRateBps,
      drawnAt: loan.drawnAt,
      accruedThroughAt: loan.interestAccruedThroughAt,
    })
    .from(loan)
    .where(and(eq(loan.worldId, worldId), eq(loan.status, 'active')));
  if (rows.length === 0) return EMPTY;

  const economy = await loadWorldEconomyConfig(db, worldId);
  const { daysPerYear } = economy.credit.defaultLadder;

  const result: InterestAccrualResult = { ...EMPTY };

  for (const row of rows) {
    const from = row.accruedThroughAt ?? row.drawnAt;
    const owed = Math.min(wholeGameDays(from, gameNow), MAX_DAYS_PER_SWEEP);
    if (owed === 0) continue;

    const perDay = dailyInterestMinor(row.outstandingMinor, row.annualRateBps, daysPerYear);
    const through = plusDays(from, owed);

    if (perDay === 0) {
      // A free or fully repaid loan still advances its watermark, or every tick
      // would rediscover the same days and find nothing to charge for them.
      await db
        .update(loan)
        .set({ interestAccruedThroughAt: through, updatedAt: new Date() })
        .where(eq(loan.id, row.id));
      continue;
    }

    const charged = await db.transaction((tx) =>
      chargeLoan(tx, {
        loanId: row.id,
        airlineId: row.airlineId,
        arrearsMinor: row.arrearsMinor,
        perDay,
        from,
        days: owed,
        through,
      }),
    );

    result.daysCharged += owed;
    result.loansCharged += 1;
    result.paidMinor += charged.paidMinor;
    result.arrearsAddedMinor += charged.arrearsAddedMinor;
    result.arrearsClearedMinor += charged.arrearsClearedMinor;
  }

  return result;
}

interface ChargeInput {
  loanId: string;
  airlineId: string;
  arrearsMinor: number;
  perDay: number;
  from: Date;
  days: number;
  through: Date;
}

interface ChargeOutcome {
  paidMinor: number;
  arrearsAddedMinor: number;
  arrearsClearedMinor: number;
}

/** One loan's owed days, inside the transaction `moveAirlineCash` needs. */
async function chargeLoan(tx: Database, input: ChargeInput): Promise<ChargeOutcome> {
  /*
   * The airline's cash is read `FOR UPDATE`, so a sweep and a purchase cannot
   * both decide the same dollar is available. Everything below spends against
   * this number and no other.
   */
  const [funds] = await tx
    .select({ cashMinor: airline.cashMinor })
    .from(airline)
    .where(eq(airline.id, input.airlineId))
    .for('update')
    .limit(1);
  let available = Math.max(0, Number(funds?.cashMinor ?? 0));

  let arrears = input.arrearsMinor;
  let arrearsClearedMinor = 0;
  let paidMinor = 0;
  let arrearsAddedMinor = 0;

  // Arrears first: §13.5 is a ladder an airline has to be able to climb, and the
  // only way off it is a zero balance. Paying today's interest while yesterday's
  // stayed owed would leave a recovering airline in default indefinitely.
  if (arrears > 0 && available > 0) {
    const settle = Math.min(arrears, available);
    await moveAirlineCash(tx, {
      airlineId: input.airlineId,
      amountMinor: -settle,
      cause: 'loan_interest',
      reference: `arrears:${input.loanId}:${input.through.toISOString()}`,
      occurredAt: input.through,
    });
    arrears -= settle;
    available -= settle;
    arrearsClearedMinor = settle;
  }

  for (let day = 1; day <= input.days; day += 1) {
    const occurredAt = plusDays(input.from, day);
    const pay = Math.min(input.perDay, available);
    if (pay > 0) {
      await moveAirlineCash(tx, {
        airlineId: input.airlineId,
        amountMinor: -pay,
        cause: 'loan_interest',
        reference: `interest:${input.loanId}:${occurredAt.toISOString()}`,
        occurredAt,
      });
      available -= pay;
      paidMinor += pay;
    }
    arrearsAddedMinor += input.perDay - pay;
  }

  await tx
    .update(loan)
    .set({
      interestAccruedThroughAt: input.through,
      arrearsMinor: arrears + arrearsAddedMinor,
      updatedAt: new Date(),
    })
    .where(eq(loan.id, input.loanId));

  return { paidMinor, arrearsAddedMinor, arrearsClearedMinor };
}

/** What this airline owes in unpaid interest, across every loan still on the book. */
export async function airlineArrearsMinor(db: Database, airlineId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${loan.arrearsMinor}), 0)` })
    .from(loan)
    .where(and(eq(loan.airlineId, airlineId), inArray(loan.status, ['active', 'defaulted'])));
  return Number(row?.total ?? 0);
}
