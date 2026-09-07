import { and, count, eq, gte, isNull, sql } from 'drizzle-orm';

import {
  CreditTier,
  LOAN_SECURITY,
  type CreditStandingResponse,
  type DrawLoanRequest,
  type LoanInstrument,
} from '@tailfin/shared';
import {
  annualInterestMinor,
  applyRatingReview,
  borrowingCapacity,
  checkDraw,
  dailyInterestMinor,
  debtServiceCoverage,
  earnedCreditTier,
  instrumentRateBps,
  type CreditStanding as SimStanding,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import {
  aircraftOrder,
  airframe,
  creditStanding,
  airlineHub,
  ledgerEntry,
  loan,
  route,
} from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { worldGameNow } from '../world/game-now';

import { projectStanding } from './default';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * What an airline may borrow, and drawing it (M8-06, §13).
 *
 * > **Loans support, they never carry.**
 *
 * The arithmetic is `@tailfin/sim`'s; this reads the trading it needs and writes
 * the loan. Everything owner-scoped by query, as ADR-0020 requires.
 *
 * ## The rating is reviewed on read, not on a tick
 *
 * §13.2's hysteresis needs history — *"one bad quarter costs a tier; recovering
 * it takes two good ones"* — so `credit_standing` persists the tier and the
 * streak. What moves it is a **review**, and a review happens at most once per
 * game month, driven by whoever reads the standing.
 *
 * That is deliberately not a worker sweep, and the reason is the same one fuel
 * pricing gives: production has no worker, and a credit rating that froze there
 * would make the entire lending system behave differently between nodes. Read-
 * driven, it behaves identically everywhere. The cost is that a rating only
 * moves when somebody looks — which is acceptable because nothing but a human
 * *asking to borrow* depends on it, and that act is itself a look.
 *
 * ## Trailing twelve months, from the ledger
 *
 * Operating profit and EBITDA both come from `ledger_entry` over the last twelve
 * **game** months. They differ by the categories excluded: EBITDA leaves out
 * interest, lease finance and the depreciation the game does not yet model, so
 * on today's data it is operating profit plus the finance lines back. When
 * depreciation arrives the difference will widen, and the two are computed
 * separately here so that it can.
 */

/** Categories that are revenue rather than cost — the P&L's own list. */
const REVENUE_CATEGORIES = ['ticket', 'ancillary', 'cargo', 'charter', 'acmi'];

/**
 * Financing lines, excluded from EBITDA.
 *
 * `debt_draw` is excluded from **both** measures: borrowing is not trading, and
 * a draw counted as revenue would make a loan look like a good quarter — which
 * is precisely the confusion §13.1 exists to prevent.
 */
const FINANCE_CATEGORIES = ['interest', 'lease_finance'];
const NON_TRADING_CATEGORIES = ['debt_draw', 'equity', 'opening_balance'];

interface TrailingTrade {
  operatingProfitMinor: number;
  ebitdaMinor: number;
  revenueMinor: number;
  profitableMonths: number;
}

/** Twelve game months of trading, and how many of them ran a profit. */
async function trailingTrade(
  db: Database,
  airlineId: string,
  gameNow: Date,
): Promise<TrailingTrade> {
  const from = new Date(gameNow);
  from.setUTCFullYear(from.getUTCFullYear() - 1);

  const rows = await db
    .select({
      category: ledgerEntry.category,
      month: sql<string>`to_char(${ledgerEntry.occurredAt}, 'YYYY-MM')`,
      amount: sql<string>`coalesce(sum(${ledgerEntry.amountMinor}), 0)::text`,
    })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.airlineId, airlineId), gte(ledgerEntry.occurredAt, from)))
    .groupBy(ledgerEntry.category, sql`to_char(${ledgerEntry.occurredAt}, 'YYYY-MM')`);

  let revenueMinor = 0;
  let costMinor = 0;
  let financeMinor = 0;
  const byMonth = new Map<string, number>();

  for (const row of rows) {
    // `sum()` is a raw aggregate, so the driver hands back a string — the trap
    // CLAUDE.md records for `min`/`max`. Normalised at the boundary.
    const amount = Math.abs(Number(row.amount));
    if (!Number.isFinite(amount)) continue;
    if (NON_TRADING_CATEGORIES.includes(row.category)) continue;

    const isRevenue = REVENUE_CATEGORIES.includes(row.category);
    if (isRevenue) revenueMinor += amount;
    else costMinor += amount;
    if (FINANCE_CATEGORIES.includes(row.category)) financeMinor += amount;

    byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + (isRevenue ? amount : -amount));
  }

  const operatingProfitMinor = revenueMinor - costMinor;
  return {
    operatingProfitMinor,
    // Earnings before the finance lines — see the note above on depreciation.
    ebitdaMinor: operatingProfitMinor + financeMinor,
    revenueMinor,
    profitableMonths: [...byMonth.values()].filter((value) => value > 0).length,
  };
}

/**
 * What a lender could take: the airline's **owned** airframes, at what it paid.
 *
 * Leased and financed airframes are excluded — a leased aeroplane is not the
 * airline's to pledge, and a financed one is already pledged. Acquisition cost
 * stands in for market value because the game has no appraisal; that overstates
 * an old airframe and understates a scarce one, and it is the number the
 * `aircraft_order` actually recorded rather than one invented here.
 */
async function tangibleAssetValue(db: Database, airlineId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aircraftOrder.chargedMinor}), 0)::text` })
    .from(airframe)
    .innerJoin(aircraftOrder, eq(aircraftOrder.id, airframe.sourceOrderId))
    .where(
      and(
        eq(airframe.airlineId, airlineId),
        eq(airframe.ownership, 'owned'),
        // A seized aeroplane is the lender's. Advancing against it would let an
        // airline borrow again on the security it has already lost (§13.5).
        isNull(airframe.repossessedAt),
      ),
    );
  const total = Number(row?.total ?? 0);
  return Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0;
}

/** Active loans, what is owed, and the annual service on them. */
async function debtPosition(
  db: Database,
  airlineId: string,
): Promise<{
  rows: (typeof loan.$inferSelect)[];
  outstandingMinor: number;
  annualServiceMinor: number;
}> {
  const rows = await db
    .select()
    .from(loan)
    .where(and(eq(loan.airlineId, airlineId), eq(loan.status, 'active')))
    .orderBy(loan.drawnAt);

  let outstandingMinor = 0;
  let annualServiceMinor = 0;
  for (const row of rows) {
    outstandingMinor += row.outstandingMinor;
    // Service is interest plus the principal a year of the term repays — the
    // "annual debt service" §13.1 divides EBITDA by, not interest alone.
    annualServiceMinor +=
      annualInterestMinor(row.outstandingMinor, row.annualRateBps) +
      Math.round((row.principalMinor * 12) / row.termMonths);
  }
  return { rows, outstandingMinor, annualServiceMinor };
}

/** How many months of game time separate two instants. */
function monthsBetween(from: Date, to: Date): number {
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  );
}

/**
 * §13.1's coverage ratio and its floor, and nothing else (M8-13).
 *
 * `readCreditStanding` returns both, and calling it for them would be wrong
 * twice over: it runs six more queries the caller does not want, and it
 * **reviews the rating** as a side effect — so an alert sweep asking *is
 * coverage thin?* would also be advancing the airline's credit rating on the
 * world's behalf, every game hour, dated on the sweep rather than on the read
 * that CLAUDE.md says drives it.
 *
 * `dscr` is null when the airline owes nothing, exactly as it is in the standing:
 * §13.1's gate does not apply to an airline with no debt, and zero would read as
 * the worst possible coverage rather than as none required.
 */
export async function readDebtServiceCoverage(
  db: Database,
  own: ResolvedPlayerAirline,
  gameNow: Date,
): Promise<{ dscr: number | null; minimumDscr: number }> {
  const [economy, trade, debt] = await Promise.all([
    loadWorldEconomyConfig(db, own.worldId),
    trailingTrade(db, own.id, gameNow),
    debtPosition(db, own.id),
  ]);

  return {
    dscr: debtServiceCoverage(trade.ebitdaMinor, debt.annualServiceMinor),
    minimumDscr: economy.credit.minimumDscr,
  };
}

/** The airline's standing, reviewing the rating first if a review is due. */
export async function readCreditStanding(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<CreditStandingResponse> {
  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const gameNow = await worldGameNow(db, own.worldId);

  const [trade, assets, debt, routes, hubs, stored] = await Promise.all([
    trailingTrade(db, own.id, gameNow),
    tangibleAssetValue(db, own.id),
    debtPosition(db, own.id),
    db
      .select({ n: count() })
      .from(route)
      .where(and(eq(route.airlineId, own.id), eq(route.active, true))),
    db.select({ n: count() }).from(airlineHub).where(eq(airlineHub.airlineId, own.id)),
    db.select().from(creditStanding).where(eq(creditStanding.airlineId, own.id)).limit(1),
  ]);

  const standing: SimStanding = {
    trailingOperatingProfitMinor: trade.operatingProfitMinor,
    trailingEbitdaMinor: trade.ebitdaMinor,
    trailingRevenueMinor: trade.revenueMinor,
    tangibleAssetValueMinor: assets,
    profitableMonths: trade.profitableMonths,
    routes: routes[0]?.n ?? 0,
    hubs: hubs[0]?.n ?? 0,
  };

  const earned = earnedCreditTier(standing, economy.credit);
  const held = stored[0];
  const current = {
    tier: CreditTier.safeParse(held?.tier).data ?? 'startup',
    goodReviews: held?.goodReviews ?? 0,
  };

  // A review is due when the airline has never had one, or a game month has
  // passed since the last. Anything more frequent would let a player rush a rise
  // by reloading the page.
  const due = held?.lastReviewedAt == null || monthsBetween(held.lastReviewedAt, gameNow) >= 1;
  const next = due ? applyRatingReview(current, earned, economy.credit) : current;

  if (due) {
    await db
      .insert(creditStanding)
      .values({
        airlineId: own.id,
        worldId: own.worldId,
        tier: next.tier,
        goodReviews: next.goodReviews,
        lastReviewedAt: gameNow,
      })
      .onConflictDoUpdate({
        target: creditStanding.airlineId,
        set: {
          tier: next.tier,
          goodReviews: next.goodReviews,
          lastReviewedAt: gameNow,
          updatedAt: new Date(),
        },
      });
  }

  /*
   * §13.4's drain and §13.5's ladder, read rather than reviewed. The *stage* is
   * the worker sweep's to move — unlike the rating, which is reviewed here —
   * because escalating on read would let a page load push an airline a rung
   * further into default, and dating that rung on whenever the player happened
   * to look. Reading it costs nothing: the arrears are already in `debt.rows`.
   */
  let arrearsMinor = 0;
  let dailyMinor = 0;
  for (const row of debt.rows) {
    arrearsMinor += row.arrearsMinor;
    dailyMinor += dailyInterestMinor(
      row.outstandingMinor,
      row.annualRateBps,
      economy.credit.defaultLadder.daysPerYear,
    );
  }

  const capacity = borrowingCapacity(next.tier, standing, economy.credit);
  const dscr = debtServiceCoverage(trade.ebitdaMinor, debt.annualServiceMinor);
  const headroomMinor = Math.max(0, capacity.maxTotalDebtMinor - debt.outstandingMinor);
  const refused = checkDraw(
    {
      principalMinor: 1,
      maxTotalDebtMinor: capacity.maxTotalDebtMinor,
      outstandingDebtMinor: debt.outstandingMinor,
      dscr,
    },
    economy.credit,
  );

  return {
    tier: next.tier,
    earnedTier: earned,
    annualRateBps: economy.credit.tiers[next.tier].annualRateBps,
    termMonths: economy.credit.tiers[next.tier].termMonths,
    limits: {
      tierCapMinor: capacity.tierCapMinor,
      profitMultipleMinor: capacity.profitMultipleMinor,
      assetAdvanceMinor: capacity.assetAdvanceMinor,
    },
    maxTotalDebtMinor: capacity.maxTotalDebtMinor,
    outstandingDebtMinor: debt.outstandingMinor,
    headroomMinor,
    bindingConstraint: capacity.bindingConstraint,
    dscr,
    minimumDscr: economy.credit.minimumDscr,
    canBorrow: refused === null,
    refusal: refused === null ? null : refusalMessage(refused, economy.credit.minimumDscr),
    trailing: {
      operatingProfitMinor: trade.operatingProfitMinor,
      ebitdaMinor: trade.ebitdaMinor,
      tangibleAssetValueMinor: assets,
      annualDebtServiceMinor: debt.annualServiceMinor,
      profitableMonths: trade.profitableMonths,
      routes: standing.routes,
      hubs: standing.hubs,
    },
    standing: projectStanding(held, arrearsMinor, dailyMinor),
    loans: debt.rows.map((row) => ({
      id: row.id,
      instrument: row.instrument as LoanInstrument,
      principalMinor: row.principalMinor,
      outstandingMinor: row.outstandingMinor,
      arrearsMinor: row.arrearsMinor,
      interestAccruedThroughAt: row.interestAccruedThroughAt?.toISOString() ?? null,
      dailyInterestMinor: dailyInterestMinor(
        row.outstandingMinor,
        row.annualRateBps,
        economy.credit.defaultLadder.daysPerYear,
      ),
      annualRateBps: row.annualRateBps,
      termMonths: row.termMonths,
      tierAtDraw: CreditTier.safeParse(row.tierAtDraw).data ?? 'startup',
      status: 'active',
      drawnAt: row.drawnAt.toISOString(),
      securedAirframeId: row.securedAirframeId,
    })),
  };
}

function refusalMessage(
  refusal: NonNullable<ReturnType<typeof checkDraw>>,
  minimum: number,
): string {
  return refusal.code === 'over_capacity'
    ? 'You are at your borrowing limit. Capacity is a multiple of demonstrated profit.'
    : `Your debt service coverage is ${refusal.dscr.toFixed(2)}; ${minimum.toFixed(2)} is the floor for new borrowing.`;
}

export type DrawFailure =
  | { code: 'refused'; message: string }
  | { code: 'security_required'; message: string }
  | { code: 'unknown_airframe'; message: string };

export type DrawResult =
  { ok: true; standing: CreditStandingResponse } | { ok: false; failure: DrawFailure };

/**
 * Draw a loan: the cash and the obligation in one transaction.
 *
 * Capacity is re-read **inside** the transaction rather than trusted from a
 * prior `GET`, because between the two the airline may have drawn elsewhere or a
 * month of trading may have closed. `moveAirlineCash` is called within it for
 * the reason CLAUDE.md gives — the reconciliation trigger is deferred to commit,
 * so a movement outside a transaction is refused.
 */
export async function drawLoan(
  db: Database,
  own: ResolvedPlayerAirline,
  request: DrawLoanRequest,
): Promise<DrawResult> {
  if (LOAN_SECURITY[request.instrument] === 'airframe' && request.securedAirframeId === undefined) {
    return {
      ok: false,
      failure: {
        code: 'security_required',
        message: 'Aircraft finance is secured on an airframe; name the one it is written against.',
      },
    };
  }

  if (request.securedAirframeId !== undefined) {
    const [owned] = await db
      .select({ id: airframe.id })
      .from(airframe)
      .where(and(eq(airframe.id, request.securedAirframeId), eq(airframe.airlineId, own.id)))
      .limit(1);
    // Somebody else's aeroplane is as unavailable as one that does not exist.
    if (owned === undefined) {
      return {
        ok: false,
        failure: { code: 'unknown_airframe', message: 'No such airframe in your fleet.' },
      };
    }
  }

  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const gameNow = await worldGameNow(db, own.worldId);

  return db.transaction(async (tx) => {
    const before = await readCreditStanding(tx, own);
    const refusal = checkDraw(
      {
        principalMinor: request.principalMinor,
        maxTotalDebtMinor: before.maxTotalDebtMinor,
        outstandingDebtMinor: before.outstandingDebtMinor,
        dscr: before.dscr,
      },
      economy.credit,
    );
    if (refusal !== null) {
      return {
        ok: false as const,
        failure: {
          code: 'refused' as const,
          message: refusalMessage(refusal, economy.credit.minimumDscr),
        },
      };
    }

    const rateBps = instrumentRateBps(before.tier, request.instrument, economy.credit);
    await tx.insert(loan).values({
      worldId: own.worldId,
      airlineId: own.id,
      instrument: request.instrument,
      principalMinor: request.principalMinor,
      outstandingMinor: request.principalMinor,
      annualRateBps: rateBps,
      termMonths: economy.credit.tiers[before.tier].termMonths,
      tierAtDraw: before.tier,
      status: 'active',
      securedAirframeId: request.securedAirframeId ?? null,
      drawnAt: gameNow,
    });

    await moveAirlineCash(tx, {
      airlineId: own.id,
      amountMinor: request.principalMinor,
      cause: 'loan_draw',
      reference: `${request.instrument} at ${String(rateBps)}bps`,
      occurredAt: gameNow,
    });

    return { ok: true as const, standing: await readCreditStanding(tx, own) };
  });
}
