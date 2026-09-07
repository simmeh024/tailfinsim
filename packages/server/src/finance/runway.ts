import { and, eq, gte, inArray, sql } from 'drizzle-orm';

import { AdminCashMovementCause } from '@tailfin/shared';
import type { CashRunwayResponse } from '@tailfin/shared';
import {
  cashRunway,
  dailyInterestMinor,
  monthBoundariesAhead,
  type CashCommitment,
} from '@tailfin/sim';

import { crewPayrollLines, foldCrewBills } from '../crew/payroll';
import {
  airline,
  cashMovement,
  executiveHire,
  groundSelfHandling,
  loan,
  officeHire,
} from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { worldGameNow } from '../world/game-now';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';
import type { CashMovementCause } from '../db/schema';

/**
 * §13.6's cash runway, assembled from what the airline has actually committed to
 * (M8-08).
 *
 * > A profitable airline can still run out of cash — lease deposits, aircraft
 * > down payments, gate leases and academy construction all hit cash long before
 * > they show up in profit.
 *
 * The projection itself is `@tailfin/sim`'s and holds no opinions. This module
 * makes the three judgements that need a database:
 *
 * 1. **which past movements are a rate** and which are one-offs that must never
 *    become one,
 * 2. **which future outflows are already committed**, and on what game day,
 * 3. **how far ahead to look**.
 *
 * ## The classification is exhaustive on purpose
 *
 * `classifyCause` is a `switch` with no `default`, over `CashMovementCause`. Add
 * a cause and this file stops compiling until somebody decides whether it is a
 * rate, a one-off, or something the commitments already project exactly. That is
 * the point: the failure mode of a runway is *silence* — a new recurring cost
 * that nobody taught it about makes the number optimistic, and nothing anywhere
 * would notice.
 */

const DAY_MS = 86_400_000;

/**
 * How far back the operating rate is measured, in game days.
 *
 * Thirty is one game month: long enough that a single quiet day does not swing
 * it, short enough to notice a network that has just been cut. Not a balance
 * number — nothing prices off it and no `flight_result` is billed against it. It
 * is a decision-support window, the same kind of constant `network/performance.ts`
 * already owns for the route trend.
 */
const RATE_WINDOW_DAYS = 30;

/**
 * How far ahead the projection looks, in game days.
 *
 * A year. Past it the answer is *"further than a year"*, which is the truthful
 * thing to say and cheaper than pretending to know: the commitments this module
 * can see (payroll, interest) are monthly and daily, so extending the horizon
 * mostly extrapolates today's headcount into a future the player will change.
 */
const HORIZON_DAYS = 365;

/**
 * §13.6's threshold: *"the single most prominent number when it drops below 30"*.
 *
 * The server decides it rather than the client, so the strip and any later alert
 * agree about when an airline is in trouble — the same reason the admin overview
 * decides its own alerts rather than shipping thresholds to a page.
 *
 * Exported since M8-13, which is *"any later alert"* arriving: §14.5's *cash
 * runway < 30 days* reads this rather than restating 30, so the strip, the
 * dashboard tile and the alert cannot disagree about what running out of cash
 * means.
 */
export const CRITICAL_DAYS = 30;

/** How many upcoming bills the response carries. A strip shows a few; the rest are the total. */
const UPCOMING_LIMIT = 8;

/**
 * What a past movement tells the projection.
 *
 * - `rate` — recurring trading. Averaged over the window and applied per day.
 * - `projected` — the commitments below reproduce this exactly, and counting it
 *   twice would double the airline's known bills.
 * - `one_off` — a capital or financing event. Real, and emphatically not a rate:
 *   a $40M aircraft purchase inside a thirty-day window implies a burn of $1.3M
 *   a day, which would report a healthy airline as having two days to live.
 */
type CauseRole = 'rate' | 'projected' | 'one_off';

function classifyCause(cause: CashMovementCause): CauseRole {
  switch (cause) {
    // Trading. What the airline does for a living, and the only honest rate.
    case 'flight_settlement':
    case 'disruption_cost':
    case 'crew_positioning':
    case 'ground_contract_penalty':
    case 'ground_volume_shortfall':
      return 'rate';

    /*
     * Maintenance is a rate even though a D-check is lumpy. A runway that
     * ignored maintenance would be optimistic in exactly the way §13.6 warns
     * about, and the alternative — projecting each airframe's next due check —
     * is M4-06's model, not this one's. The window smooths what it can.
     */
    case 'maintenance_check':
      return 'rate';

    // Reproduced exactly by a commitment below. Counting these in the rate as
    // well would bill the airline's payroll and interest twice over.
    case 'crew_payroll':
    case 'crew_base_overhead':
    case 'office_salary':
    case 'ground_self_handling_payroll':
    case 'loan_interest':
      return 'projected';

    // Capital and financing. Each is a real movement and none is a rate.
    case 'airline_founding':
    case 'airline_rebrand':
    case 'aircraft_lease_deposit':
    case 'aircraft_used_purchase':
    case 'aircraft_new_purchase':
    case 'crew_base_opening':
    case 'crew_hiring':
    case 'crew_conversion':
    case 'office_expansion':
    case 'executive_floor':
    case 'executive_office':
    case 'admin_adjustment':
    case 'migration_opening_balance':
    case 'loan_draw':
      return 'one_off';
  }
}

/**
 * The causes that make up the operating rate, for the `IN` clause.
 *
 * Derived from the enum rather than typed out again — a second list would be a
 * second place to forget a new cause, which is the one failure this file is
 * built to make impossible. `AdminCashMovementCause` is the shared mirror of the
 * database enum and `cash-movement-cause.test.ts` already holds the two in step.
 */
export const RATE_CAUSES: CashMovementCause[] = AdminCashMovementCause.options.filter(
  (cause) => classifyCause(cause) === 'rate',
);

/**
 * Net operating cash per game day, over the trailing window.
 *
 * Divided by the window rather than by the days the airline has existed, so a
 * three-day-old airline is not told it burns a third of its founding grant every
 * day. That understates a very new airline's burn, which is the safe direction:
 * it has just been given its opening balance and has nothing committed yet.
 */
async function dailyOperatingMinor(
  db: Database,
  airlineId: string,
  gameNow: Date,
): Promise<{ dailyMinor: number; windowNetMinor: number }> {
  const since = new Date(gameNow.getTime() - RATE_WINDOW_DAYS * DAY_MS);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${cashMovement.amountMinor}), 0)::text` })
    .from(cashMovement)
    .where(
      and(
        eq(cashMovement.airlineId, airlineId),
        gte(cashMovement.occurredAt, since),
        inArray(cashMovement.cause, RATE_CAUSES),
      ),
    );
  const windowNetMinor = Number(row?.total ?? 0);
  if (!Number.isFinite(windowNetMinor)) return { dailyMinor: 0, windowNetMinor: 0 };
  return { dailyMinor: Math.round(windowNetMinor / RATE_WINDOW_DAYS), windowNetMinor };
}

/** Every dated outflow the airline has already committed to, inside the horizon. */
async function commitmentsFor(
  db: Database,
  own: ResolvedPlayerAirline,
  gameNow: Date,
): Promise<CashCommitment[]> {
  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const commitments: CashCommitment[] = [];

  const [crewLines, officeRows, execRows, selfHandled, loans] = await Promise.all([
    crewPayrollLines(db, own.worldId, own.id),
    db
      .select({ monthlySalaryMinor: officeHire.monthlySalaryMinor })
      .from(officeHire)
      .where(eq(officeHire.airlineId, own.id)),
    db
      .select({ monthlySalaryMinor: executiveHire.monthlySalaryMinor })
      .from(executiveHire)
      .where(eq(executiveHire.airlineId, own.id)),
    db
      .select({ headcount: groundSelfHandling.headcount })
      .from(groundSelfHandling)
      .where(
        and(eq(groundSelfHandling.airlineId, own.id), eq(groundSelfHandling.status, 'active')),
      ),
    db
      .select({
        outstandingMinor: loan.outstandingMinor,
        arrearsMinor: loan.arrearsMinor,
        annualRateBps: loan.annualRateBps,
      })
      .from(loan)
      .where(and(eq(loan.airlineId, own.id), eq(loan.status, 'active'))),
  ]);

  /*
   * The three monthly payrolls, on the first of each game month ahead — the same
   * instant every sweep dates its movement at. `monthBoundariesAhead` is shared
   * so they cannot disagree about which day that is.
   *
   * Each is projected from **today's** state rather than from last month's bill,
   * which is the whole of AC1: crew hired an hour ago are a committed outflow
   * that no burn rate has seen yet.
   */
  const crewBill = foldCrewBills(crewLines, economy).get(own.id);
  const crewMonthlyMinor = (crewBill?.salaryMinor ?? 0) + (crewBill?.overheadMinor ?? 0);
  const officeMonthlyMinor = [...officeRows, ...execRows].reduce(
    (total, row) => total + row.monthlySalaryMinor,
    0,
  );
  const groundHeads = selfHandled.reduce((total, row) => total + row.headcount, 0);
  const groundMonthlyMinor = groundHeads * economy.ground.selfHandling.salaryPerHeadMinor;

  for (const dueAt of monthBoundariesAhead(gameNow, HORIZON_DAYS)) {
    if (crewMonthlyMinor > 0) {
      commitments.push({
        dueAt,
        amountMinor: crewMonthlyMinor,
        kind: 'crew',
        label: 'Crew salaries and base overhead',
      });
    }
    if (officeMonthlyMinor > 0) {
      commitments.push({
        dueAt,
        amountMinor: officeMonthlyMinor,
        kind: 'office',
        label: 'Head office and executive salaries',
      });
    }
    if (groundMonthlyMinor > 0) {
      commitments.push({
        dueAt,
        amountMinor: groundMonthlyMinor,
        kind: 'ground',
        label: `Self-handling payroll (${String(groundHeads)} staff)`,
      });
    }
  }

  /*
   * §13.4's interest, per game day, at today's outstanding balance. One
   * commitment a day rather than a monthly total, because that is literally how
   * M8-07 charges it — and because a runway that folded a month of interest onto
   * the first would move the day the airline runs out.
   *
   * Arrears are dated at `gameNow`: already owed, and taken from the next dollar
   * that arrives rather than waiting for a due date.
   */
  let dailyInterest = 0;
  let arrears = 0;
  for (const row of loans) {
    dailyInterest += dailyInterestMinor(
      row.outstandingMinor,
      row.annualRateBps,
      economy.credit.defaultLadder.daysPerYear,
    );
    arrears += row.arrearsMinor;
  }
  if (arrears > 0) {
    commitments.push({
      dueAt: gameNow,
      amountMinor: arrears,
      kind: 'arrears',
      label: 'Interest already missed',
    });
  }
  if (dailyInterest > 0) {
    for (let day = 1; day <= HORIZON_DAYS; day += 1) {
      commitments.push({
        dueAt: new Date(gameNow.getTime() + day * DAY_MS),
        amountMinor: dailyInterest,
        kind: 'interest',
        label: 'Loan interest',
      });
    }
  }

  return commitments;
}

/** `GET /api/finance/runway` — §13.6's number, and what it is made of. */
export async function readCashRunway(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<CashRunwayResponse> {
  const gameNow = await worldGameNow(db, own.worldId);

  const [cashRow, rate, commitments] = await Promise.all([
    db.select({ cashMinor: airline.cashMinor }).from(airline).where(eq(airline.id, own.id)),
    dailyOperatingMinor(db, own.id, gameNow),
    commitmentsFor(db, own, gameNow),
  ]);
  const cashMinor = Number(cashRow[0]?.cashMinor ?? 0);

  const projection = cashRunway({
    cashMinor,
    gameNow,
    dailyOperatingMinor: rate.dailyMinor,
    commitments,
    horizonDays: HORIZON_DAYS,
  });

  /*
   * The next few bills, for the drill-down §14.1 requires. Sorted by date and
   * capped, because a year of daily interest is 365 rows and a status strip
   * wants the next handful — the total is carried separately as
   * `committedMinor`, so nothing is hidden by the cap.
   */
  const upcoming = [...commitments]
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    .slice(0, UPCOMING_LIMIT)
    .map((commitment) => ({
      dueAt: commitment.dueAt.toISOString(),
      amountMinor: commitment.amountMinor,
      kind: commitment.kind,
      label: commitment.label,
    }));

  return {
    gameNow: gameNow.toISOString(),
    cashMinor,
    days: projection.days,
    horizonDays: projection.horizonDays,
    critical: projection.days !== null && projection.days < CRITICAL_DAYS,
    criticalBelowDays: CRITICAL_DAYS,
    dailyOperatingMinor: rate.dailyMinor,
    rateWindowDays: RATE_WINDOW_DAYS,
    committedMinor: projection.committedMinor,
    owedNowMinor: projection.owedNowMinor,
    tippedBy:
      projection.tippedBy === null
        ? null
        : {
            dueAt: projection.tippedBy.dueAt.toISOString(),
            amountMinor: projection.tippedBy.amountMinor,
            kind: projection.tippedBy.kind,
            label: projection.tippedBy.label,
          },
    upcoming,
  };
}
