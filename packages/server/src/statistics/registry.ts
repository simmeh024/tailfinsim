import type {
  MetricDimension,
  MetricDrillDown,
  MetricId,
  MetricPolarity,
  MetricUnit,
} from '@tailfin/shared';
import {
  breakevenLoadFactor,
  cask,
  loadFactor,
  onTimeRate,
  passengerYield,
  rask,
  spillRate,
  type TrafficTotals,
} from '@tailfin/sim';

/**
 * The metric registry — §14.1's rule made structural (M8-09).
 *
 * > **Every figure drills down to its cause.** … A number you cannot interrogate
 * > is a number players will not trust.
 *
 * A convention would not survive: somebody adds a metric in a hurry, the
 * drill-down is a follow-up, and the follow-up does not happen. So a metric is a
 * **record in this table** and the record has no optional fields. There is
 * nowhere to put a metric without saying where it goes, and
 * `statistics-drilldown.test.ts` asks the router whether that somewhere exists.
 *
 * ## Every definition carries four things a client cannot infer
 *
 * - **`unit`**, because `0.081` is a fraction of a dollar per seat-kilometre and
 *   `0.81` is a load factor, and nothing about the number says which.
 * - **`polarity`**, because a rising CASK is bad and a rising load factor is
 *   good. A client that guessed from the name would colour one of them wrong.
 * - **`description`**, because RASK and yield are not obviously different and
 *   the difference is the most useful thing this vocabulary can tell a player.
 * - **`drillDown`**, which is the whole point.
 *
 * ## The bounded metrics declare their bounds
 *
 * `clampTo` exists so a forecast band cannot claim a load factor of 1.4. That is
 * not uncertainty, it is arithmetic — and the sim's `clampBand` deliberately
 * refuses to decide which metrics are bounded, because only this table knows.
 */

/** Where the airline-level breakdown lives. Named once so the registry cannot typo it. */
const BREAKDOWN = '/api/statistics/:metricId/breakdown';

/** §14.3's Financial dashboard reads the P&L, which already drills four ways. */
const PNL = '/api/finance/pnl';

function byRoute(label: string): MetricDrillDown {
  return { endpoint: BREAKDOWN, by: 'route', label };
}

export interface MetricDefinition {
  id: MetricId;
  label: string;
  description: string;
  unit: MetricUnit;
  polarity: MetricPolarity;
  drillDown: MetricDrillDown;
  /** The range a forecast band may occupy, when the metric has one. */
  clampTo: { min: number; max: number } | null;
  /** The metric itself, over one folded window. Null when the window says nothing. */
  compute: (totals: TrafficTotals) => number | null;
  /**
   * Whether this metric can be broken down by dimension at all.
   *
   * A ratio can: each route has its own load factor. A **share** cannot be taken
   * of one, which is what `MetricBreakdownRow.share` is null for.
   */
  additive: boolean;
}

/**
 * Every metric §14.3 exposes, in the order a dashboard would read them.
 *
 * Traffic first, then the unit economics that explain it, then the money. The
 * order is the response's order — a client should not have to sort a list whose
 * natural reading order the server already knows.
 */
export const METRICS: readonly MetricDefinition[] = [
  {
    id: 'load_factor',
    label: 'Load factor',
    description: 'Passengers carried as a share of the seats you offered.',
    unit: 'ratio',
    polarity: 'higher_is_better',
    drillDown: byRoute('by route'),
    clampTo: { min: 0, max: 1 },
    compute: loadFactor,
    additive: false,
  },
  {
    id: 'ask',
    label: 'ASK',
    description: 'Available seat-kilometres — the capacity you put into the market.',
    unit: 'seat_km',
    polarity: 'neutral',
    drillDown: byRoute('by route'),
    clampTo: { min: 0, max: Number.MAX_SAFE_INTEGER },
    compute: (totals) => totals.askKm,
    additive: true,
  },
  {
    id: 'rpk',
    label: 'RPK',
    description: 'Revenue passenger-kilometres — the capacity you actually sold.',
    unit: 'passenger_km',
    polarity: 'higher_is_better',
    drillDown: byRoute('by route'),
    clampTo: { min: 0, max: Number.MAX_SAFE_INTEGER },
    compute: (totals) => totals.rpkKm,
    additive: true,
  },
  {
    id: 'rtk',
    label: 'RTK',
    description: 'Revenue tonne-kilometres — cargo carried, weighted by how far.',
    unit: 'tonne_km',
    polarity: 'higher_is_better',
    drillDown: byRoute('by route'),
    clampTo: { min: 0, max: Number.MAX_SAFE_INTEGER },
    compute: (totals) => totals.rtkKm,
    additive: true,
  },
  {
    id: 'spill_rate',
    label: 'Spill',
    description: 'The share of demand that arrived and found no seat. Money turned away.',
    unit: 'ratio',
    polarity: 'lower_is_better',
    drillDown: byRoute('by route'),
    clampTo: { min: 0, max: 1 },
    compute: spillRate,
    additive: false,
  },
  {
    id: 'on_time',
    label: 'On time',
    description: 'Arrivals within fifteen minutes of plan.',
    unit: 'ratio',
    polarity: 'higher_is_better',
    drillDown: byRoute('by route'),
    clampTo: { min: 0, max: 1 },
    compute: onTimeRate,
    additive: false,
  },
  {
    id: 'rask',
    label: 'RASK',
    description: 'Revenue per seat-kilometre you offered. Falls when a market leaves you.',
    unit: 'minor_per_ask',
    polarity: 'higher_is_better',
    drillDown: byRoute('by route'),
    clampTo: null,
    compute: rask,
    additive: false,
  },
  {
    id: 'cask',
    label: 'CASK',
    description: 'Cost per seat-kilometre you offered, whether or not it sold.',
    unit: 'minor_per_ask',
    polarity: 'lower_is_better',
    drillDown: byRoute('by route'),
    clampTo: null,
    compute: cask,
    additive: false,
  },
  {
    id: 'yield',
    label: 'Yield',
    description: 'Revenue per seat-kilometre you sold. RASK divided by load factor.',
    unit: 'minor_per_rpk',
    polarity: 'higher_is_better',
    drillDown: byRoute('by route'),
    clampTo: null,
    compute: passengerYield,
    additive: false,
  },
  {
    id: 'breakeven_load_factor',
    label: 'Breakeven load',
    description: 'The load factor at which today’s yield would cover today’s cost.',
    unit: 'ratio',
    polarity: 'lower_is_better',
    drillDown: byRoute('by route'),
    // Deliberately **not** clamped to 1: above it, no load factor saves the
    // route, and §14.4's ranked chart has to tell "reprice" from "kill".
    clampTo: null,
    compute: breakevenLoadFactor,
    additive: false,
  },
  {
    id: 'revenue',
    label: 'Revenue',
    description: 'What the flights you flew brought in.',
    unit: 'minor',
    polarity: 'higher_is_better',
    drillDown: { endpoint: PNL, by: 'ledger_category', label: 'in the P&L' },
    clampTo: { min: 0, max: Number.MAX_SAFE_INTEGER },
    compute: (totals) => totals.revenueMinor,
    additive: true,
  },
  {
    id: 'cost',
    label: 'Cost',
    description: 'What those flights cost to operate. Period costs are in the P&L.',
    unit: 'minor',
    polarity: 'lower_is_better',
    drillDown: { endpoint: PNL, by: 'ledger_category', label: 'in the P&L' },
    clampTo: { min: 0, max: Number.MAX_SAFE_INTEGER },
    compute: (totals) => totals.costMinor,
    additive: true,
  },
  {
    id: 'operating_profit',
    label: 'Contribution',
    description: 'Flight revenue less flight cost. Not profit: payroll and interest sit outside.',
    unit: 'minor',
    polarity: 'higher_is_better',
    drillDown: byRoute('by route'),
    clampTo: null,
    compute: (totals) => totals.revenueMinor - totals.costMinor,
    additive: true,
  },
];

const BY_ID = new Map<MetricId, MetricDefinition>(METRICS.map((metric) => [metric.id, metric]));

export function metricDefinition(id: MetricId): MetricDefinition | undefined {
  return BY_ID.get(id);
}

/**
 * The dimensions a metric can be broken down by.
 *
 * Only `route` today, because a `flight_result` knows its flight and its flight
 * knows its airport pair — while aircraft, hub and cabin are the P&L's
 * dimensions and it already answers them. Adding one here means the breakdown
 * can actually produce it, not merely name it: a dimension listed and unserved
 * would be a dead-end drill-down, which is the thing §14.1 forbids.
 */
export const BREAKDOWN_DIMENSIONS: readonly MetricDimension[] = ['route'];

/** Where a breakdown row goes next — §14.1's route → **flight** → segment chain. */
export function rowDrillDown(dimension: MetricDimension): MetricDrillDown | null {
  return dimension === 'route'
    ? { endpoint: '/api/routes/:routeId/flights', by: 'flight', label: 'by flight' }
    : null;
}
