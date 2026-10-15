import { vi } from 'vitest';

import type {
  CreditStandingResponse,
  FinancePnlResponse,
  MeResponse,
  MetricBreakdownResponse,
  MetricTrend,
  StatisticsResponse,
} from '@tailfin/shared';

/**
 * The Finance page's API, as fixtures (a test helper, SURFACE-02/03/06).
 *
 * Named `test-*` like `test-gates.ts` and imported only by tests. One set of
 * bodies for the page and its two components, so a contract change breaks
 * every test that depends on it in the same place.
 */

export const SIGNED_IN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Finance Tester',
    avatarUrl: null,
    displayCurrency: 'USD',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  signInProviders: [],
  isAdmin: false,
};

export const AIRLINE = {
  airline: {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    worldId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    playerId: SIGNED_IN.player?.id,
    name: 'Ledger Air',
    iataCode: 'LA',
    icaoCode: 'LGR',
    callsign: 'LEDGER',
    baseCountry: 'NL',
    cash: 50_000_000,
    reputation: 0.42,
    status: 'active',
    statusChangedAt: '2026-08-17T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-17T10:00:00.000Z',
  },
  rebrand: { costMinor: 2_500_000, mutableFields: ['name'], immutableFields: ['iataCode'] },
};

export function trend(days: number, overrides: Partial<MetricTrend> = {}): MetricTrend {
  return {
    days,
    value: 0.82,
    previousValue: 0.78,
    changePct: days / 1000,
    changeAbsolute: 0.04,
    direction: 'up',
    ...overrides,
  };
}

export function statistics(): StatisticsResponse {
  const mk = (
    id: StatisticsResponse['metrics'][number]['id'],
    label: string,
    unit: StatisticsResponse['metrics'][number]['unit'],
    value: number | null,
    drillDown: StatisticsResponse['metrics'][number]['drillDown'] = {
      endpoint: '/api/statistics/:metricId/breakdown',
      by: 'route',
      label: 'by route',
    },
  ): StatisticsResponse['metrics'][number] => ({
    id,
    label,
    description: `What ${label} means, in one sentence.`,
    unit,
    polarity: id === 'cask' || id === 'cost' ? 'lower_is_better' : 'higher_is_better',
    value,
    trends: [trend(7), trend(30), trend(90)],
    forecasts: [
      { horizonDays: 7, mid: 0.8, low: 0.75, high: 0.85, observations: 30 },
      { horizonDays: 30, mid: 0.8, low: 0.7, high: 0.9, observations: 30 },
    ],
    drillDown,
  });
  const inPnl = {
    endpoint: '/api/finance/pnl',
    by: 'ledger_category' as const,
    label: 'in the P&L',
  };
  return {
    gameNow: '2027-03-10T00:00:00.000Z',
    windowDays: 30,
    metrics: [
      mk('load_factor', 'Load factor', 'ratio', 0.82),
      mk('rask', 'RASK', 'minor_per_ask', 10.25),
      mk('cask', 'CASK', 'minor_per_ask', 8.5),
      mk('yield', 'Yield', 'minor_per_rpk', 12.5),
      mk('breakeven_load_factor', 'Breakeven load', 'ratio', 0.68),
      mk('revenue', 'Revenue', 'minor', 20_000_000, inPnl),
      mk('cost', 'Cost', 'minor', 16_000_000, inPnl),
      mk('operating_profit', 'Contribution', 'minor', 4_000_000),
    ],
  };
}

export function pnl(overrides: Partial<FinancePnlResponse> = {}): FinancePnlResponse {
  return {
    from: '2027-02-08T00:00:00.000Z',
    to: '2027-03-10T00:00:00.000Z',
    revenueMinor: 20_000_000,
    costMinor: 16_000_000,
    operatingProfitMinor: 4_000_000,
    lines: [
      { category: 'ticket', amountMinor: 20_000_000, entryCount: 40 },
      { category: 'fuel', amountMinor: 9_000_000, entryCount: 40 },
    ],
    byRoute: [
      {
        key: 'EHAM–EGLL',
        revenueMinor: 12_000_000,
        costMinor: 9_000_000,
        operatingProfitMinor: 3_000_000,
      },
    ],
    byAircraft: [],
    byHub: [],
    byCabinClass: [],
    ...overrides,
  };
}

export function breakdown(
  metric: MetricBreakdownResponse['metric'],
  windowDays = 30,
  rows = 2,
): MetricBreakdownResponse {
  return {
    metric,
    by: 'route',
    gameNow: '2027-03-10T00:00:00.000Z',
    windowDays,
    total: 4_000_000,
    rows: Array.from({ length: rows }, (_, index) => ({
      key: `cccccccc-dddd-4eee-8fff-00000000000${String(index)}`,
      label: index === 0 ? 'EHAM–EGLL' : 'EHAM–LFPG',
      value: index === 0 ? 3_000_000 : 1_000_000,
      share: index === 0 ? 0.75 : 0.25,
      drillDown: { endpoint: '/api/routes/:routeId/flights', by: 'flight', label: 'by flight' },
    })),
  };
}

/** A trading airline at C, comfortably able to borrow, with one loan. */
export function credit(overrides: Partial<CreditStandingResponse> = {}): CreditStandingResponse {
  return {
    tier: 'C',
    earnedTier: 'C',
    annualRateBps: 1_000,
    termMonths: 36,
    limits: {
      tierCapMinor: 500_000_000,
      profitMultipleMinor: 200_000_000,
      assetAdvanceMinor: 90_000_000,
    },
    maxTotalDebtMinor: 90_000_000,
    outstandingDebtMinor: 25_000_000,
    headroomMinor: 65_000_000,
    bindingConstraint: 'asset_advance',
    dscr: 1.9,
    minimumDscr: 1.25,
    canBorrow: true,
    refusal: null,
    trailing: {
      operatingProfitMinor: 60_000_000,
      ebitdaMinor: 80_000_000,
      tangibleAssetValueMinor: 150_000_000,
      annualDebtServiceMinor: 42_000_000,
      profitableMonths: 8,
      routes: 6,
      hubs: 1,
      operatingMargin: 0.12,
      interestMinor: 4_250_000,
    },
    formula: { profitMultiple: 3, assetAdvanceRate: 0.6 },
    rating: { goodReviews: 0, reviewsToRise: 2 },
    nextTier: {
      tier: 'B',
      maxDebtMinor: 2_500_000_000,
      annualRateBps: 800,
      requires: { profitableMonths: 12, routes: 6, hubs: 2, operatingMargin: 0.05 },
    },
    instruments: [
      { instrument: 'working_capital', security: 'none', annualRateBps: 1_300, termMonths: 36 },
      { instrument: 'aircraft_finance', security: 'airframe', annualRateBps: 800, termMonths: 36 },
      { instrument: 'facility', security: 'facility', annualRateBps: 1_000, termMonths: 36 },
    ],
    interest: { monthlyMinor: 354_167, shareOfOperatingProfit: 0.0659 },
    standing: {
      stage: 'none',
      stageEnteredAt: null,
      cureByAt: null,
      arrearsMinor: 0,
      restricted: false,
      message: null,
      dailyInterestMinor: 11_806,
    },
    loans: [
      {
        id: 'dddddddd-eeee-4fff-8000-000000000001',
        instrument: 'working_capital',
        principalMinor: 25_000_000,
        outstandingMinor: 25_000_000,
        arrearsMinor: 0,
        interestAccruedThroughAt: '2027-03-09T00:00:00.000Z',
        dailyInterestMinor: 11_806,
        annualRateBps: 1_700,
        termMonths: 36,
        tierAtDraw: 'C',
        status: 'active',
        drawnAt: '2027-01-01T00:00:00.000Z',
        securedAirframeId: null,
        monthlyInterestMinor: 354_167,
        shareOfOperatingProfit: 0.0659,
      },
    ],
    ...overrides,
  };
}

/** A loss-making airline past the founder facility: §13.1's door, closed by the formula. */
export function losingCredit(): CreditStandingResponse {
  return credit({
    tier: 'D',
    earnedTier: 'D',
    limits: { tierCapMinor: 100_000_000, profitMultipleMinor: 0, assetAdvanceMinor: 30_000_000 },
    maxTotalDebtMinor: 0,
    outstandingDebtMinor: 0,
    headroomMinor: 0,
    bindingConstraint: 'profit_multiple',
    dscr: null,
    canBorrow: false,
    refusal: 'You are at your borrowing limit. Capacity is a multiple of demonstrated profit.',
    trailing: {
      operatingProfitMinor: -12_000_000,
      ebitdaMinor: -12_000_000,
      tangibleAssetValueMinor: 50_000_000,
      annualDebtServiceMinor: 0,
      profitableMonths: 0,
      routes: 2,
      hubs: 1,
      operatingMargin: -0.3,
      interestMinor: 0,
    },
    interest: { monthlyMinor: 0, shareOfOperatingProfit: null },
    loans: [],
  });
}

/** One recorded request: the URL with its query, the method, and the body sent. */
export interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Decides one call's answer — for the draw, whose status matters. */
export type Responder = (call: Call) => { status: number; body: unknown } | Promise<never>;

/**
 * Stub `fetch` by path. A plain value is the 200 body; a `Responder` decides per
 * call. Unknown paths answer `{}` like the shell's routing test does. Every call
 * is recorded with its query string.
 */
export function stubApi(bodies: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  const all: Record<string, unknown> = {
    '/api/me': SIGNED_IN,
    '/api/airlines/me': AIRLINE,
    ...bodies,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const path = url.split('?')[0] ?? '';
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
      };
      calls.push(call);
      const entry = all[path];
      if (typeof entry === 'function') {
        const decided = (entry as Responder)(call);
        if (decided instanceof Promise) return decided;
        return Promise.resolve({
          ok: decided.status >= 200 && decided.status < 300,
          status: decided.status,
          json: () => Promise.resolve(decided.body),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(entry ?? {}),
      });
    }),
  );
  return calls;
}
