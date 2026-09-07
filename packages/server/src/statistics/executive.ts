import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';

import type {
  ExecutiveDashboardResponse,
  Headline,
  MetricTrend,
  MonthToDate,
  RouteMover,
} from '@tailfin/shared';
import { trendOf } from '@tailfin/sim';

import { aircraftOrder, airframe, airline, flight, flightResult, loan, route } from '../db/schema';
import { readCreditStanding } from '../finance/credit';
import { readCashRunway } from '../finance/runway';
import { worldGameNow } from '../world/game-now';

import { readStatistics } from './metrics';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * §14.3's Executive dashboard, assembled once (M8-10).
 *
 * Six of the nine figures already exist somewhere — cash and reputation on the
 * airline, the runway in `finance/runway.ts`, load factor and OTP in M8-09's
 * metrics, the rating in `finance/credit.ts`. Three do not, and those three are
 * the reason this module exists rather than the page fetching six endpoints:
 *
 * - **net worth** = cash + tangible assets − debt,
 * - **MTD profit vs forecast**, which compares a partial month to a band,
 * - **the week's top movers**, a week-over-week difference by route.
 *
 * A page that derived those itself would own three figures the server could not
 * explain — and §14.1's rule is that every figure drills down to its cause. So
 * each headline here carries its own drill-down, and the two derived ones point
 * at the endpoints whose numbers they are made of.
 *
 * ## Every headline carries a rate of change
 *
 * §14.6: *"Absolute value **and** rate of change on every headline metric — a
 * falling profit that's falling more slowly is a different story from one that
 * isn't."* So `trend` is not optional. Where a previous period cannot be
 * measured it is `direction: 'unknown'` rather than absent, because a tile that
 * sometimes has a change indicator and sometimes does not is a tile that jumps
 * around as data arrives.
 */

/** The comparison window for the headline trends, in game days. */
const TREND_WINDOW_DAYS = 30;

/** §14.3's "this week", in game days. */
const WEEK_DAYS = 7;

/** How many routes each mover list carries. Enough to act on, few enough to read. */
const MOVER_LIMIT = 5;

const DAY_MS = 86_400_000;

/** The trend a figure gets when there is no earlier period to compare against. */
function noTrend(days: number, value: number | null): MetricTrend {
  return trendOf(days, value, null);
}

/**
 * Net worth: what the airline would be worth if it stopped today.
 *
 * Cash plus what it owns outright, less what it owes. Deliberately **not** a
 * valuation — there is no goodwill, no route value and no brand, because none of
 * those has a number anywhere in the game and inventing one would make the
 * headline unfalsifiable.
 *
 * Tangible assets are owned, non-repossessed airframes at acquisition cost, the
 * same basis `finance/credit.ts` advances against. Two bases for one figure
 * would let the dashboard and the lender disagree about what the fleet is worth.
 */
async function tangibleAssetsMinor(db: Database, airlineId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${aircraftOrder.chargedMinor}), 0)::text` })
    .from(airframe)
    .innerJoin(aircraftOrder, eq(aircraftOrder.id, airframe.sourceOrderId))
    .where(
      and(
        eq(airframe.airlineId, airlineId),
        eq(airframe.ownership, 'owned'),
        isNull(airframe.repossessedAt),
      ),
    );
  const total = Number(row?.total ?? 0);
  return Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0;
}

/** Contribution from settled flights over a game-day span, and per route. */
async function contributionBetween(
  db: Database,
  own: ResolvedPlayerAirline,
  from: Date,
  to: Date,
): Promise<{
  totalMinor: number;
  byRoute: Map<string, { label: string; routeId: string | null; netMinor: number }>;
}> {
  const rows = await db
    .select({
      routeId: route.id,
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      netMinor: flightResult.netMinor,
    })
    .from(flightResult)
    .innerJoin(flight, eq(flight.id, flightResult.flightId))
    .leftJoin(
      route,
      and(
        eq(route.airlineId, flightResult.airlineId),
        eq(route.originIcao, flight.originIcao),
        eq(route.destinationIcao, flight.destinationIcao),
      ),
    )
    .where(
      and(
        eq(flightResult.airlineId, own.id),
        eq(flightResult.kind, 'scheduled'),
        gte(flightResult.settledAt, from),
        lte(flightResult.settledAt, to),
      ),
    );

  const byRoute = new Map<string, { label: string; routeId: string | null; netMinor: number }>();
  let totalMinor = 0;
  for (const row of rows) {
    totalMinor += row.netMinor;
    const label = `${row.originIcao}–${row.destinationIcao}`;
    const key = row.routeId ?? label;
    const entry = byRoute.get(key) ?? { label, routeId: row.routeId, netMinor: 0 };
    entry.netMinor += row.netMinor;
    byRoute.set(key, entry);
  }
  return { totalMinor, byRoute };
}

/** Midnight on the first of the game month `at` falls in. */
function startOfGameMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export async function readExecutiveDashboard(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<ExecutiveDashboardResponse> {
  const gameNow = await worldGameNow(db, own.worldId);

  const [cashRow, assetsMinor, debtRow, runway, credit, stats] = await Promise.all([
    db
      .select({ cashMinor: airline.cashMinor, reputation: airline.reputation })
      .from(airline)
      .where(eq(airline.id, own.id)),
    tangibleAssetsMinor(db, own.id),
    db
      .select({ total: sql<string>`coalesce(sum(${loan.outstandingMinor}), 0)::text` })
      .from(loan)
      .where(and(eq(loan.airlineId, own.id), eq(loan.status, 'active'))),
    readCashRunway(db, own),
    readCreditStanding(db, own),
    readStatistics(db, own),
  ]);

  const cashMinor = Number(cashRow[0]?.cashMinor ?? 0);
  const reputation = Number(cashRow[0]?.reputation ?? 0);
  const debtMinor = Number(debtRow[0]?.total ?? 0);
  const netWorthMinor = cashMinor + assetsMinor - debtMinor;

  const metric = (id: string) => stats.metrics.find((entry) => entry.id === id);
  const loadFactor = metric('load_factor');
  const onTime = metric('on_time');
  const contribution = metric('operating_profit');

  /*
   * Month to date against the same span of the forecast.
   *
   * The forecast is a **band**, so the variance is measured against its middle
   * and `withinBand` says whether the airline is genuinely off plan. A dashboard
   * that showed a bare variance would raise an alarm every single month, because
   * a projection is never exactly right.
   */
  const monthStart = startOfGameMonth(gameNow);
  const daysElapsed = Math.max(0, Math.floor((gameNow.getTime() - monthStart.getTime()) / DAY_MS));
  const mtd = await contributionBetween(db, own, monthStart, gameNow);
  const band = contribution?.forecasts.find((forecast) => forecast.horizonDays === 30) ?? null;
  /*
   * The band is a **daily** contribution projected forward, so it is scaled to
   * the days that have actually elapsed. Comparing a whole month's projection
   * against six days of trading would report every airline in the game as
   * catastrophically behind plan for the first three weeks of every month.
   */
  const forecastMinor = band === null ? null : Math.round(band.mid * daysElapsed);
  const forecastLowMinor = band === null ? null : Math.round(band.low * daysElapsed);
  const forecastHighMinor = band === null ? null : Math.round(band.high * daysElapsed);
  const monthToDate: MonthToDate = {
    monthStart: monthStart.toISOString(),
    daysElapsed,
    actualMinor: mtd.totalMinor,
    forecastMinor,
    forecastLowMinor,
    forecastHighMinor,
    varianceMinor: forecastMinor === null ? null : mtd.totalMinor - forecastMinor,
    withinBand:
      forecastLowMinor !== null &&
      forecastHighMinor !== null &&
      mtd.totalMinor >= forecastLowMinor &&
      mtd.totalMinor <= forecastHighMinor,
  };

  /*
   * This week's movers, ranked on the **change** rather than the level. §14.3
   * asks for gainers and losers, and the best route in the network is not news
   * if it was also the best last week.
   */
  const thisWeek = await contributionBetween(
    db,
    own,
    new Date(gameNow.getTime() - WEEK_DAYS * DAY_MS),
    gameNow,
  );
  const lastWeek = await contributionBetween(
    db,
    own,
    new Date(gameNow.getTime() - 2 * WEEK_DAYS * DAY_MS),
    new Date(gameNow.getTime() - WEEK_DAYS * DAY_MS),
  );

  const keys = new Set([...thisWeek.byRoute.keys(), ...lastWeek.byRoute.keys()]);
  const movers: RouteMover[] = [...keys].map((key) => {
    const now = thisWeek.byRoute.get(key);
    const before = lastWeek.byRoute.get(key);
    const entry = now ?? before;
    const routeId = entry?.routeId ?? null;
    return {
      routeId,
      label: entry?.label ?? key,
      valueMinor: now?.netMinor ?? 0,
      previousMinor: before?.netMinor ?? 0,
      changeMinor: (now?.netMinor ?? 0) - (before?.netMinor ?? 0),
      drillDown:
        routeId === null
          ? null
          : { endpoint: '/api/routes/:routeId/flights', by: 'flight', label: 'by flight' },
    };
  });
  const improved = movers.filter((mover) => mover.changeMinor > 0);
  const worsened = movers.filter((mover) => mover.changeMinor < 0);
  improved.sort((a, b) => b.changeMinor - a.changeMinor);
  worsened.sort((a, b) => a.changeMinor - b.changeMinor);

  const headlines: Headline[] = [
    {
      id: 'cash',
      label: 'Cash',
      unit: 'minor',
      polarity: 'higher_is_better',
      value: cashMinor,
      text: null,
      // Cash has no trailing series of its own here: the ledger is the place
      // that can explain how it moved, so the tile links there rather than
      // showing a change it would have to invent.
      trend: noTrend(TREND_WINDOW_DAYS, cashMinor),
      drillDown: { endpoint: '/api/finance/pnl', by: 'ledger_category', label: 'in the P&L' },
    },
    {
      id: 'cash_runway',
      label: 'Cash runway',
      unit: 'days',
      polarity: 'higher_is_better',
      value: runway.days,
      text: runway.days === null ? `${String(runway.horizonDays)}+ days` : null,
      trend: noTrend(TREND_WINDOW_DAYS, runway.days),
      drillDown: { endpoint: '/api/finance/runway', by: 'record', label: 'what is committed' },
    },
    {
      id: 'net_worth',
      label: 'Net worth',
      unit: 'minor',
      polarity: 'higher_is_better',
      value: netWorthMinor,
      text: null,
      trend: noTrend(TREND_WINDOW_DAYS, netWorthMinor),
      // Cash, fleet and debt: the credit standing is the one place that already
      // reports the assets and the borrowing this is made of.
      drillDown: { endpoint: '/api/credit', by: 'record', label: 'assets and debt' },
    },
    {
      id: 'mtd_profit',
      label: 'Profit MTD',
      unit: 'minor',
      polarity: 'higher_is_better',
      value: mtd.totalMinor,
      text: null,
      trend: trendOf(WEEK_DAYS, thisWeek.totalMinor, lastWeek.totalMinor),
      drillDown: {
        endpoint: '/api/statistics/:metricId/breakdown',
        by: 'route',
        label: 'by route',
      },
    },
    {
      id: 'load_factor',
      label: 'Load factor',
      unit: 'ratio',
      polarity: 'higher_is_better',
      value: loadFactor?.value ?? null,
      text: null,
      trend:
        loadFactor?.trends.find((trend) => trend.days === TREND_WINDOW_DAYS) ??
        noTrend(TREND_WINDOW_DAYS, null),
      drillDown: loadFactor?.drillDown ?? {
        endpoint: '/api/statistics/:metricId/breakdown',
        by: 'route',
        label: 'by route',
      },
    },
    {
      id: 'on_time',
      label: 'On time',
      unit: 'ratio',
      polarity: 'higher_is_better',
      value: onTime?.value ?? null,
      text: null,
      trend:
        onTime?.trends.find((trend) => trend.days === TREND_WINDOW_DAYS) ??
        noTrend(TREND_WINDOW_DAYS, null),
      drillDown: onTime?.drillDown ?? {
        endpoint: '/api/statistics/:metricId/breakdown',
        by: 'route',
        label: 'by route',
      },
    },
    {
      id: 'reputation',
      label: 'Reputation',
      unit: 'ratio',
      polarity: 'higher_is_better',
      value: reputation,
      text: null,
      trend: noTrend(TREND_WINDOW_DAYS, reputation),
      // §15's attribution is not built, so this points at the airline record
      // rather than at a breakdown that does not exist.
      drillDown: { endpoint: '/api/airlines/me', by: 'record', label: 'your airline' },
    },
    {
      id: 'credit_rating',
      label: 'Credit rating',
      unit: 'text',
      polarity: 'higher_is_better',
      value: null,
      text: credit.tier,
      trend: noTrend(TREND_WINDOW_DAYS, null),
      drillDown: { endpoint: '/api/credit', by: 'record', label: 'what you may borrow' },
    },
  ];

  return {
    gameNow: gameNow.toISOString(),
    headlines,
    monthToDate,
    gainers: improved.slice(0, MOVER_LIMIT),
    losers: worsened.slice(0, MOVER_LIMIT),
    creditTier: credit.tier,
  };
}
