import type { MetricTrend, MetricUnit } from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';

/**
 * One place that turns a metric into words (§14.6, M8-10).
 *
 * > Consistent chart language across every dashboard
 *
 * Both dashboards read the same units from the same registry, so both format
 * them here. Two pages formatting a `minor_per_ask` their own way would show the
 * same CASK as `0.08` on one screen and `8.1¢` on the other, and a player would
 * reasonably conclude one of them was wrong.
 */

/** Units a headline may carry that a metric may not — a runway is in days. */
export type DisplayUnit = MetricUnit | 'days' | 'text';

/**
 * A metric's value, in its unit.
 *
 * `null` becomes an em dash rather than `0`, because the server means *"nothing
 * to measure"* and zero would be a claim about a bad month rather than an absent
 * one. That distinction is made carefully all the way from the rollup; throwing
 * it away at the last step would waste it.
 */
export function formatMetric(value: number | null, unit: DisplayUnit): string {
  if (value === null) return '—';
  switch (unit) {
    case 'ratio':
      return `${(value * 100).toFixed(1)}%`;
    case 'minor':
      return formatUsdMinor(Math.round(value));
    case 'minor_per_ask':
    case 'minor_per_rpk':
      /*
       * Per-kilometre money is a fraction of a minor unit — a CASK of 0.081 is
       * eight hundredths of a cent per seat-kilometre. Rounded to a whole minor
       * unit every unit economic in the game would read as zero, so this is the
       * one figure shown with its decimals rather than through the currency
       * formatter.
       */
      return `${value.toFixed(3)}¢/km`;
    case 'seat_km':
    case 'passenger_km':
      return `${Math.round(value).toLocaleString()} km`;
    case 'tonne_km':
      return `${value.toFixed(1)} t·km`;
    case 'days':
      return value === 1 ? '1 day' : `${String(Math.round(value))} days`;
    case 'text':
      return '—';
  }
}

/** Whether a movement is good news, given what the metric wants. */
export type TrendTone = 'good' | 'bad' | 'neutral' | 'unknown';

/**
 * Pair a direction with the metric's polarity.
 *
 * The server says which way the number moved and which way is better; only the
 * two together mean anything. A rising CASK is bad and a rising load factor is
 * good, and neither the direction nor the polarity says that alone.
 */
export function trendTone(
  trend: MetricTrend,
  polarity: 'higher_is_better' | 'lower_is_better' | 'neutral',
): TrendTone {
  if (trend.direction === 'unknown') return 'unknown';
  if (trend.direction === 'flat' || polarity === 'neutral') return 'neutral';
  const rising = trend.direction === 'up';
  return rising === (polarity === 'higher_is_better') ? 'good' : 'bad';
}

/**
 * The movement, in words, with its arrow.
 *
 * §14.6 asks for *"absolute value **and** rate of change"*, so the change is
 * never shown alone — this is the second half of a tile whose first half is the
 * level. A percentage where there is one, the absolute change where there is
 * not: a change from zero has no percentage, and `∞%` would be a formatting bug
 * dressed as a figure.
 */
export function formatTrend(trend: MetricTrend, unit: DisplayUnit): string {
  if (trend.direction === 'unknown') return 'no earlier period';
  const arrow = trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '▬';
  const span = `${String(trend.days)}d`;
  if (trend.changePct !== null) {
    return `${arrow} ${Math.abs(trend.changePct * 100).toFixed(1)}% vs prior ${span}`;
  }
  if (trend.changeAbsolute !== null) {
    return `${arrow} ${formatMetric(Math.abs(trend.changeAbsolute), unit)} vs prior ${span}`;
  }
  return `▬ flat vs prior ${span}`;
}

/** Where a drill-down link should point in the client, given the API endpoint. */
export function drillHref(endpoint: string, params: { routeId?: string } = {}): string | null {
  switch (endpoint) {
    case '/api/statistics/:metricId/breakdown':
    case '/api/statistics':
      return '/finance';
    case '/api/finance/pnl':
    case '/api/finance/runway':
    case '/api/credit':
      return '/finance';
    case '/api/routes/:routeId/flights':
    case '/api/routes/:routeId/waterfall':
      return params.routeId === undefined ? '/network' : `/network?route=${params.routeId}`;
    case '/api/airlines/me':
      return '/airline';
    default:
      /*
       * An endpoint this map does not know is a **missing link, not a broken
       * one**: the tile renders its figure without a link rather than sending a
       * player to a page that cannot answer. M8-09's guard proves the endpoint
       * exists on the server; nothing yet proves a page consumes it, and
       * pretending otherwise is how a drill-down rots.
       */
      return null;
  }
}
