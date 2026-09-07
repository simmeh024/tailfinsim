import {
  CreditStandingResponse,
  ExecutiveDashboardResponse,
  FinancePnlResponse,
  MetricBreakdownResponse,
  StatisticsResponse,
} from '@tailfin/shared';

/**
 * What the two dashboards read (§14.3, M8-10).
 *
 * Every response is **parsed**, never cast. A dashboard is a page of numbers, so
 * a body whose shape has moved does not degrade gracefully — it renders `NaN`
 * next to a currency symbol, or throws on a `.map` and takes the page with it.
 * A body that does not parse becomes `null`, which every panel renders as
 * `broken` rather than as an empty airline.
 *
 * The same boundary the `/service` configurator learned in M8-05 and the status
 * strip in M8-08, for the same reason.
 *
 * `zod` is not a dependency of `@tailfin/web` — only of `@tailfin/shared`, which
 * re-exports the schemas as values. So the guard is written per endpoint against
 * the schema it needs rather than through one generic helper taking a `ZodType`,
 * which would need the type to import.
 */

/** Anything with a `safeParse`. The shared schemas satisfy it without a `zod` import. */
interface Shaped<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}

/** Read and parse, or null. Never throws — not even on a dead server. */
async function shaped<T>(url: string, schema: Shaped<T>): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function fetchExecutiveDashboard(): Promise<ExecutiveDashboardResponse | null> {
  return shaped('/api/statistics/executive', ExecutiveDashboardResponse);
}

export function fetchStatistics(): Promise<StatisticsResponse | null> {
  return shaped('/api/statistics', StatisticsResponse);
}

export function fetchProfitAndLoss(): Promise<FinancePnlResponse | null> {
  return shaped('/api/finance/pnl', FinancePnlResponse);
}

export function fetchCreditStanding(): Promise<CreditStandingResponse | null> {
  return shaped('/api/credit', CreditStandingResponse);
}

/** One metric's contributing rows — §14.1's first drill-down rung. */
export function fetchBreakdown(metricId: string): Promise<MetricBreakdownResponse | null> {
  return shaped(
    `/api/statistics/${encodeURIComponent(metricId)}/breakdown?by=route`,
    MetricBreakdownResponse,
  );
}
