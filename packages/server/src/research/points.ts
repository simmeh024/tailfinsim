import { eq, sql } from 'drizzle-orm';

import type { ResearchPointsFormula } from '@tailfin/shared';
import { researchPointsForFlight } from '@tailfin/sim';

import { academy, flightResult, researchAccount } from '../db/schema';

import type { Database } from '../db/client';

/**
 * Where research points come from, and the only place they are written
 * (M9-05, §10.3).
 *
 * ## The one way in
 *
 * §10.3: *"You cannot buy RP. You cannot rush it."* That is held by the shape
 * of the code rather than by a check somebody could later relax:
 *
 *  - **`accrueResearchPoints` is the only function that raises
 *    `earned_milli`**, and its only caller is `settleArrivedFlight` — points
 *    are earned by flying, with academies, and by nothing else.
 *  - **This is the only file that writes `research_account` at all.** The
 *    start request spends through `debitResearchPoints` below, which can only
 *    *raise* `spent_milli`, and refuses a non-positive amount so that a debit
 *    can never be turned round into a credit.
 *  - No admin route, cash movement or balance field reaches either.
 *
 * `research/no-purchase.test.ts` scans the source for all three, so a later
 * change that adds a second way in fails the build rather than a review.
 *
 * ## Milli-points
 *
 * Integer thousandths, so a short sector's fraction of a point is kept and the
 * sum does not depend on the order flights settled in. A flight's share is
 * rounded once, here, to the nearest thousandth — an error of at most half a
 * thousandth of a point per flight, which a year of a large airline's flying
 * does not add up to one point of.
 */

/** Thousandths of a point per point: the unit `research_account` counts in. */
export const RESEARCH_MILLI_PER_POINT = 1_000;

export function researchPointsFromMilli(milli: number): number {
  return milli / RESEARCH_MILLI_PER_POINT;
}

/**
 * Σ of the airline's commissioned academy levels — §10.3's first term.
 *
 * `academy.level` is the **commissioned** level, and 0 is a building site, so a
 * site counts nothing and a level under construction counts the level below it
 * until the worker commissions it. Grouped in Postgres and normalised here:
 * `sum()` over a bigint-promoted integer comes back from the driver as a string.
 */
export async function academyLevelSum(db: Database, airlineId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string | number | null>`coalesce(sum(${academy.level}), 0)` })
    .from(academy)
    .where(eq(academy.airlineId, airlineId));
  return Number(row?.total ?? 0);
}

export interface ResearchFlightAccrual {
  /** Points credited, as stored: milli-points ÷ 1000. */
  points: number;
  academyLevelSum: number;
  academyStaffQuality: number;
  scalingFactorHours: number;
  blockHours: number;
}

export interface ResearchFlightFacts {
  /** The settled flight, whose `flight_result.breakdown` records the accrual. */
  flightId: string;
  airlineId: string;
  worldId: string;
  /** The block minutes the settlement billed. */
  blockMinutes: number;
}

/**
 * Credit a settled flight's research points to its airline, and say why on the
 * flight's own result.
 *
 * Called from `settleArrivedFlight` **after** the `flight_result` insert has
 * proved the arrival is not a replay — the same position and reason as
 * `accrueFlightHours` and `awardFlightXp` — so a flight's points accrue exactly
 * once, in the same transaction as the money it earned.
 *
 * The breakdown is written **even when the answer is zero**. A large airline
 * with no academy flies a thousand sectors and earns nothing, by design, and
 * *"why did I earn nothing?"* deserves an answer on every one of them:
 * `academyLevelSum: 0`.
 */
export async function accrueResearchPoints(
  tx: Database,
  facts: ResearchFlightFacts,
  formula: ResearchPointsFormula,
): Promise<ResearchFlightAccrual> {
  const levels = await academyLevelSum(tx, facts.airlineId);
  const raw = researchPointsForFlight(
    { academyLevelSum: levels, blockMinutes: facts.blockMinutes },
    formula,
  );
  const milli = Math.round(raw * RESEARCH_MILLI_PER_POINT);

  if (milli > 0) {
    /*
     * An atomic increment rather than read-modify-write: a start request may be
     * holding this row's lock to spend from it, and the increment simply queues
     * behind it rather than overwriting what it spent. No row is written for an
     * airline that has earned nothing — an NPC carrier has no academy and would
     * otherwise grow a row of zeros per flight.
     */
    await tx
      .insert(researchAccount)
      .values({ airlineId: facts.airlineId, worldId: facts.worldId, earnedMilli: milli })
      .onConflictDoUpdate({
        target: researchAccount.airlineId,
        set: {
          earnedMilli: sql`${researchAccount.earnedMilli} + ${milli}`,
          updatedAt: sql`now()`,
        },
      });
  }

  const accrual: ResearchFlightAccrual = {
    points: researchPointsFromMilli(milli),
    academyLevelSum: levels,
    academyStaffQuality: formula.academyStaffQuality,
    scalingFactorHours: formula.scalingFactorHours,
    blockHours: facts.blockMinutes / 60,
  };

  // On the result rather than in a table of its own, for the reason `crewXp` is:
  // `breakdown` is already the settlement's audit trail, and it is what the
  // tree's "recent points per day" is summed from.
  await tx
    .update(flightResult)
    .set({
      breakdown: sql`jsonb_set(${flightResult.breakdown}::jsonb, '{research}', ${JSON.stringify(
        accrual,
      )}::jsonb, true)::text`,
    })
    .where(eq(flightResult.flightId, facts.flightId));

  return accrual;
}

/** The airline's account, locked for the rest of the transaction. Zeros when it has none. */
export async function lockResearchAccount(
  tx: Database,
  airlineId: string,
): Promise<{ earnedMilli: number; spentMilli: number; exists: boolean }> {
  const [row] = await tx
    .select({ earnedMilli: researchAccount.earnedMilli, spentMilli: researchAccount.spentMilli })
    .from(researchAccount)
    .where(eq(researchAccount.airlineId, airlineId))
    .for('update');
  return row
    ? { earnedMilli: row.earnedMilli, spentMilli: row.spentMilli, exists: true }
    : { earnedMilli: 0, spentMilli: 0, exists: false };
}

/** The airline's account as it stands, unlocked. Zeros when it has none. */
export async function readResearchAccount(
  db: Database,
  airlineId: string,
): Promise<{ earnedMilli: number; spentMilli: number }> {
  const [row] = await db
    .select({ earnedMilli: researchAccount.earnedMilli, spentMilli: researchAccount.spentMilli })
    .from(researchAccount)
    .where(eq(researchAccount.airlineId, airlineId))
    .limit(1);
  return row ?? { earnedMilli: 0, spentMilli: 0 };
}

/**
 * Spend points on a project. Can only ever raise `spent_milli`.
 *
 * The caller holds the row lock (`lockResearchAccount`) and has checked the
 * balance; the database's `spent_milli <= earned_milli` CHECK is the backstop,
 * so an overdraft is refused by Postgres whatever the caller got wrong. A
 * non-positive amount throws rather than writing: a "debit" of −100 would be a
 * credit by another name, and this is the only function that can move the row
 * outside settlement.
 */
export async function debitResearchPoints(
  tx: Database,
  airlineId: string,
  milli: number,
): Promise<void> {
  if (!Number.isInteger(milli) || milli <= 0) {
    throw new Error(
      `A research debit must be a positive whole number of milli-points, got ${String(milli)}`,
    );
  }
  const updated = await tx
    .update(researchAccount)
    .set({
      spentMilli: sql`${researchAccount.spentMilli} + ${milli}`,
      updatedAt: sql`now()`,
    })
    .where(eq(researchAccount.airlineId, airlineId))
    .returning({ airlineId: researchAccount.airlineId });
  if (updated.length === 0) {
    throw new Error(`Airline ${airlineId} has no research account to spend from`);
  }
}
