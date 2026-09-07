import { and, eq, gte } from 'drizzle-orm';

import {
  addFlight,
  clampBand,
  emptyTraffic,
  forecastBand,
  NM_TO_KM,
  trendOf,
  type TrafficTotals,
} from '@tailfin/sim';

import { flight, flightResult, route } from '../db/schema';
import { worldGameNow } from '../world/game-now';

import { METRICS, metricDefinition, rowDrillDown, type MetricDefinition } from './registry';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';
import type {
  Metric,
  MetricBreakdownResponse,
  MetricDimension,
  MetricForecast,
  MetricId,
  StatisticsResponse,
} from '@tailfin/shared';

/**
 * §14's metrics, folded from settled flights (M8-09).
 *
 * One read of `flight_result` covers all three horizons and every metric: the
 * rows are bucketed by **game day** once, and each window is a fold over a slice
 * of those buckets. The alternative — a query per metric per window — would be
 * thirteen metrics × six windows against the same table, and would also let two
 * metrics disagree about which flights were in the window.
 *
 * ## Only settled scheduled flights count
 *
 * A cancelled flight never settles, so it contributes no ASK and no cost, and a
 * ferry is excluded because it sells nothing — counting its seats would report
 * an airline as having flown empty rather than as having positioned an
 * aeroplane. `performance.ts` draws the same line for the same reason, one route
 * at a time.
 *
 * ## Production has no worker, and it shows here loudest of all
 *
 * Every figure in this module comes from `flight_result`, and only the worker
 * writes one. On a node with no worker, an entire dashboard reads zero — not one
 * panel, the whole of §14. That reads as an airline that has done nothing rather
 * than as a missing process, which is the same trap the fleet page and the world
 * map already carry.
 */

/** The window a headline `value` covers. One game month. */
const PRIMARY_WINDOW_DAYS = 30;

/** §14.2's trend windows, in game days. */
const TREND_WINDOWS = [7, 30, 90] as const;

/** §14.2's forecast horizons, in game days. */
const FORECAST_HORIZONS = [7, 30, 90] as const;

/**
 * How far back the daily buckets reach.
 *
 * Twice the longest trend window, because a 90-day trend needs the 90 days
 * before it to have something to be a trend *against*. §14.6: *"a falling profit
 * that's falling more slowly is a different story from one that isn't."*
 */
const HISTORY_DAYS = 180;

/** §14.3's on-time definition, shared with `network/performance.ts`. */
const ON_TIME_THRESHOLD_MINUTES = 15;

const DAY_MS = 86_400_000;

/** One settled flight, as the fold reads it. */
interface SettledRow {
  flightId: string;
  routeId: string | null;
  routeLabel: string;
  seats: number;
  passengers: number;
  spilledPassengers: number;
  cargoKg: number;
  distanceKm: number;
  revenueMinor: number;
  costMinor: number;
  netMinor: number;
  blockSeconds: number;
  arrivalDelayMinutes: number;
  settledAt: Date;
  departedAt: Date;
}

/**
 * Every settled scheduled flight in the history window, with its route.
 *
 * The join is on the airport pair rather than on a stored route id, because
 * `flight` carries none — `route`'s unique `(airline_id, origin_icao,
 * destination_icao)` is what turns a flight back into a route, the same way the
 * service catalogue finds a flight's package. A `left` join, so a flight whose
 * route has since been deleted still counts toward the airline's totals and
 * simply cannot be drilled into.
 */
async function settledFlights(
  db: Database,
  own: ResolvedPlayerAirline,
  since: Date,
): Promise<SettledRow[]> {
  const rows = await db
    .select({
      flightId: flightResult.flightId,
      routeId: route.id,
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      greatCircleNm: route.greatCircleNm,
      seats: flightResult.seats,
      passengers: flightResult.passengers,
      spilledPassengers: flightResult.spilledPassengers,
      cargoKg: flightResult.cargoKg,
      revenueMinor: flightResult.revenueMinor,
      costMinor: flightResult.costMinor,
      netMinor: flightResult.netMinor,
      blockSeconds: flightResult.blockSeconds,
      arrivalDelayMinutes: flightResult.arrivalDelayMinutes,
      settledAt: flightResult.settledAt,
      scheduledDeparture: flight.scheduledDeparture,
      actualDeparture: flight.actualDeparture,
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
        gte(flightResult.settledAt, since),
      ),
    );

  return rows.map((row) => ({
    flightId: row.flightId,
    routeId: row.routeId,
    routeLabel: `${row.originIcao}–${row.destinationIcao}`,
    seats: row.seats,
    passengers: row.passengers,
    spilledPassengers: row.spilledPassengers,
    cargoKg: row.cargoKg,
    // No route row means no recorded distance. Zero rather than a guess: the
    // flight still counts in the money totals and contributes no seat-kilometres,
    // which is the honest reading of "we cannot say how far this went".
    distanceKm: (row.greatCircleNm ?? 0) * NM_TO_KM,
    revenueMinor: row.revenueMinor,
    costMinor: row.costMinor,
    netMinor: row.netMinor,
    blockSeconds: row.blockSeconds,
    arrivalDelayMinutes: row.arrivalDelayMinutes,
    settledAt: row.settledAt,
    departedAt: row.actualDeparture ?? row.scheduledDeparture,
  }));
}

function fold(totals: TrafficTotals, row: SettledRow): TrafficTotals {
  return addFlight(totals, {
    seats: row.seats,
    passengers: row.passengers,
    spilledPassengers: row.spilledPassengers,
    cargoKg: row.cargoKg,
    distanceKm: row.distanceKm,
    revenueMinor: row.revenueMinor,
    costMinor: row.costMinor,
    blockSeconds: row.blockSeconds,
    onTime: row.arrivalDelayMinutes <= ON_TIME_THRESHOLD_MINUTES,
  });
}

/** Rows bucketed by whole game days back from now — index 0 is the last 24 hours. */
function bucketByDay(rows: readonly SettledRow[], gameNow: Date): TrafficTotals[] {
  const buckets: TrafficTotals[] = Array.from({ length: HISTORY_DAYS }, () => emptyTraffic());
  for (const row of rows) {
    const age = Math.floor((gameNow.getTime() - row.settledAt.getTime()) / DAY_MS);
    if (age < 0 || age >= HISTORY_DAYS) continue;
    buckets[age] = fold(buckets[age] ?? emptyTraffic(), row);
  }
  return buckets;
}

/** Fold a contiguous slice of day buckets — `[from, to)` days ago. */
function window(buckets: readonly TrafficTotals[], from: number, to: number): TrafficTotals {
  let totals = emptyTraffic();
  for (let day = from; day < Math.min(to, buckets.length); day += 1) {
    const bucket = buckets[day];
    if (!bucket) continue;
    totals = {
      askKm: totals.askKm + bucket.askKm,
      rpkKm: totals.rpkKm + bucket.rpkKm,
      rtkKm: totals.rtkKm + bucket.rtkKm,
      seats: totals.seats + bucket.seats,
      passengers: totals.passengers + bucket.passengers,
      spilledPassengers: totals.spilledPassengers + bucket.spilledPassengers,
      revenueMinor: totals.revenueMinor + bucket.revenueMinor,
      costMinor: totals.costMinor + bucket.costMinor,
      flights: totals.flights + bucket.flights,
      blockHours: totals.blockHours + bucket.blockHours,
      onTimeFlights: totals.onTimeFlights + bucket.onTimeFlights,
    };
  }
  return totals;
}

/**
 * The forecast series for one metric: the metric per game day, oldest first.
 *
 * A day the airline flew nothing is `null` rather than `0` — the sim's projection
 * skips nulls and widens its band for the gap, which is the difference between
 * *"we did not fly"* and *"we flew empty"*. Reading the second as the first would
 * drag every load-factor forecast toward the floor after a quiet weekend.
 */
function forecastsFor(
  definition: MetricDefinition,
  buckets: readonly TrafficTotals[],
): MetricForecast[] {
  const series: (number | null)[] = [];
  for (let day = HISTORY_DAYS - 1; day >= 0; day -= 1) {
    const bucket = buckets[day];
    series.push(bucket === undefined || bucket.flights === 0 ? null : definition.compute(bucket));
  }

  const bands: MetricForecast[] = [];
  for (const horizonDays of FORECAST_HORIZONS) {
    const band = forecastBand(series, horizonDays, 1);
    if (band === null) continue;
    const bounded =
      definition.clampTo === null
        ? band
        : clampBand(band, definition.clampTo.min, definition.clampTo.max);
    bands.push({
      horizonDays: bounded.horizonDays,
      mid: bounded.mid,
      low: bounded.low,
      high: bounded.high,
      observations: bounded.observations,
    });
  }
  return bands;
}

function project(definition: MetricDefinition, buckets: readonly TrafficTotals[]): Metric {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    unit: definition.unit,
    polarity: definition.polarity,
    value: definition.compute(window(buckets, 0, PRIMARY_WINDOW_DAYS)),
    trends: TREND_WINDOWS.map((days) =>
      trendOf(
        days,
        definition.compute(window(buckets, 0, days)),
        definition.compute(window(buckets, days, days * 2)),
      ),
    ),
    forecasts: forecastsFor(definition, buckets),
    drillDown: definition.drillDown,
  };
}

/** `GET /api/statistics` — §14.3's metrics, all three horizons, all drillable. */
export async function readStatistics(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<StatisticsResponse> {
  const gameNow = await worldGameNow(db, own.worldId);
  const rows = await settledFlights(db, own, new Date(gameNow.getTime() - HISTORY_DAYS * DAY_MS));
  const buckets = bucketByDay(rows, gameNow);

  return {
    gameNow: gameNow.toISOString(),
    windowDays: PRIMARY_WINDOW_DAYS,
    metrics: METRICS.map((definition) => project(definition, buckets)),
  };
}

/**
 * `GET /api/statistics/:metricId/breakdown` — the rows behind one figure.
 *
 * The first rung of §14.1's ladder, and the one that makes the rest reachable:
 * each row carries its own `drillDown`, so a client walks route → flight →
 * segment without knowing the chain in advance.
 *
 * Null for a metric this build does not expose — concealed the way any unknown
 * selector is, rather than answering with an empty breakdown that would read as
 * *"this metric has no causes"*.
 */
export async function readMetricBreakdown(
  db: Database,
  own: ResolvedPlayerAirline,
  metricId: MetricId,
  dimension: MetricDimension,
): Promise<MetricBreakdownResponse | null> {
  const definition = metricDefinition(metricId);
  if (definition === undefined || dimension !== 'route') return null;

  const gameNow = await worldGameNow(db, own.worldId);
  const since = new Date(gameNow.getTime() - PRIMARY_WINDOW_DAYS * DAY_MS);
  const rows = await settledFlights(db, own, since);

  const byRoute = new Map<
    string,
    { label: string; routeId: string | null; totals: TrafficTotals }
  >();
  let all = emptyTraffic();
  for (const row of rows) {
    all = fold(all, row);
    const key = row.routeId ?? row.routeLabel;
    const entry = byRoute.get(key) ?? {
      label: row.routeLabel,
      routeId: row.routeId,
      totals: emptyTraffic(),
    };
    entry.totals = fold(entry.totals, row);
    byRoute.set(key, entry);
  }

  const total = definition.compute(all);
  const drill = rowDrillDown(dimension);

  const projected = [...byRoute.entries()].map(([key, entry]) => {
    const value = definition.compute(entry.totals);
    /*
     * A share only means something for an additive metric. The load factors of
     * five routes do not add up to the airline's, and a share column that
     * pretended they did would be the confident-looking wrong number §14.1 is
     * about — so it is null, and a client shows the value alone.
     */
    const share =
      definition.additive && total !== null && total !== 0 && value !== null
        ? Math.min(1, Math.max(0, Math.abs(value) / Math.abs(total)))
        : null;
    return {
      key,
      label: entry.label,
      value,
      share,
      // A flight whose route has been deleted has nowhere to go next, and saying
      // so is better than a link that 404s.
      drillDown: entry.routeId === null ? null : drill,
    };
  });

  // Biggest contributor first — §14.4's ranked chart reads top-down, and a
  // breakdown ordered by insertion would be ordered by whichever flight settled
  // first, which is no order at all.
  projected.sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));

  return {
    metric: metricId,
    by: dimension,
    gameNow: gameNow.toISOString(),
    windowDays: PRIMARY_WINDOW_DAYS,
    total,
    rows: projected,
  };
}
