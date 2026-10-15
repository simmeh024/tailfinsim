import {
  CreditStandingResponse,
  type DrawLoanRequest,
  ExecutiveDashboardResponse,
  FinancePnlResponse,
  MetricBreakdownResponse,
  RouteDiagnosisResponse,
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

/**
 * The P&L over the last `days` game days (SURFACE-03).
 *
 * `days` rather than a `from`/`to` pair the client would have to compute: the
 * period ends at the **world's** now, which the server knows and a browser can
 * only estimate from a clock it should not be reading.
 */
export function fetchProfitAndLoss(days?: number): Promise<FinancePnlResponse | null> {
  return shaped(
    days === undefined ? '/api/finance/pnl' : `/api/finance/pnl?days=${String(days)}`,
    FinancePnlResponse,
  );
}

export function fetchCreditStanding(): Promise<CreditStandingResponse | null> {
  return shaped('/api/credit', CreditStandingResponse);
}

/**
 * One metric's contributing rows — §14.1's first drill-down rung — over one of
 * §14.2's windows (SURFACE-06). Omitting `days` reads the headline's own month.
 */
export function fetchBreakdown(
  metricId: string,
  days?: number,
): Promise<MetricBreakdownResponse | null> {
  const window = days === undefined ? '' : `&days=${String(days)}`;
  return shaped(
    `/api/statistics/${encodeURIComponent(metricId)}/breakdown?by=route${window}`,
    MetricBreakdownResponse,
  );
}

/** What a draw came back with: the whole standing, or the server's reason. */
export type DrawOutcome =
  | { ok: true; credit: CreditStandingResponse }
  | { ok: false; status: number; code: string; message: string };

/**
 * Draw a loan (SURFACE-02, `POST /api/credit/loans`).
 *
 * The request names an instrument and an amount and **nothing else** — the
 * rate, the term and the cap are the server's (SEC-09), and its strict schema
 * refuses a body that tries to say otherwise.
 *
 * **Never retried.** A draw has no idempotency key, so a timeout that was
 * retried could be two loans; a failure here is reported once and the player
 * decides. That is why this does not go through `shaped`, which swallows the
 * difference between a refusal and a dead server.
 */
export async function drawLoan(request: DrawLoanRequest): Promise<DrawOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/credit/loans', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(request),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'unreachable',
      message:
        'The bank could not be reached. Nothing was drawn as far as this page knows — check your loans before trying again.',
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 201) {
    const parsed = CreditStandingResponse.safeParse(body);
    if (parsed.success) return { ok: true, credit: parsed.data };
    // The loan exists; only its answer was unreadable. Saying "could not be
    // drawn" here would invite a second draw of a loan already taken.
    return {
      ok: false,
      status: 201,
      code: 'unreadable',
      message: 'The loan was drawn, but its terms could not be read. Reload to see it.',
    };
  }
  const error = (body ?? {}) as { code?: unknown; message?: unknown };
  return {
    ok: false,
    status: response.status,
    code: typeof error.code === 'string' ? error.code : 'unknown',
    message: typeof error.message === 'string' ? error.message : 'The loan could not be drawn.',
  };
}

/**
 * §14.4's drill-down for one route (M8-11).
 *
 * Per route and on a click, never for the whole chart: the competitor cause
 * needs App. A's share model, and three hundred of those on one page load would
 * make §14.4 the slowest screen in the game.
 */
export function fetchRouteDiagnosis(routeId: string): Promise<RouteDiagnosisResponse | null> {
  return shaped(`/api/routes/${encodeURIComponent(routeId)}/diagnosis`, RouteDiagnosisResponse);
}
