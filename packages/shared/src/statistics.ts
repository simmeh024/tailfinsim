import { z } from 'zod';

import { MinorUnits, Timestamp } from './primitives';

/**
 * §14's metrics API — value, trend, forecast, and where the number came from
 * (M8-09).
 *
 * > **Every figure drills down to its cause.** Load factor → by route → by
 * > flight → by segment → the Appendix A waterfall showing which competitor took
 * > the passengers and why. A number you cannot interrogate is a number players
 * > will not trust, and the whole design (A.1) is built on trust.
 *
 * That is a **structural** requirement, not a UI convention, so the drill-down
 * is part of the wire: every metric carries the endpoint that explains it, and a
 * test walks the registry and fails the build if any of those endpoints is not a
 * route the server actually serves. A metric cannot be added without one.
 *
 * ## Three horizons, always (§14.2)
 *
 * | Horizon | Here |
 * | --- | --- |
 * | **Now** | `value` — the trailing primary window |
 * | **Trend** | `trends` — 7 / 30 / 90 game days, each against the window before it |
 * | **Forecast** | `forecasts` — 7 / 30 / 90 ahead, each a **band** |
 *
 * A forecast is never a single number. `low`/`mid`/`high` are all required, and
 * a metric with too little history returns no forecast at all rather than a flat
 * line through one observation.
 */

/* ---- Identity --------------------------------------------------------------- */

/**
 * The metrics §14.3 asks for, at airline level.
 *
 * Seven of these are §14.3's named unit economics; the rest are the headline
 * figures its dashboards open with. Adding one means adding a drill-down, which
 * is the point.
 */
export const MetricId = z.enum([
  'load_factor',
  'rask',
  'cask',
  'yield',
  'rpk',
  'ask',
  'rtk',
  'breakeven_load_factor',
  'revenue',
  'cost',
  'operating_profit',
  'on_time',
  'spill_rate',
]);
export type MetricId = z.infer<typeof MetricId>;

/** What a metric's number means, so a client can format it without a lookup table. */
export const MetricUnit = z.enum([
  /** 0–1. A load factor, an on-time rate. */
  'ratio',
  /** Integer USD minor units (M8-02). Converted at the render boundary, never here. */
  'minor',
  /** Minor units per available seat-kilometre — a fraction, deliberately unrounded. */
  'minor_per_ask',
  /** Minor units per revenue passenger-kilometre. */
  'minor_per_rpk',
  'seat_km',
  'passenger_km',
  'tonne_km',
]);
export type MetricUnit = z.infer<typeof MetricUnit>;

/**
 * Whether a rising number is good news.
 *
 * Carried rather than inferred: a rising CASK is bad and a rising load factor is
 * good, and a client that guessed from the name would eventually colour one of
 * them the wrong way. `neutral` is for the volume measures — a bigger ASK is
 * neither good nor bad on its own, it is a bigger airline.
 */
export const MetricPolarity = z.enum(['higher_is_better', 'lower_is_better', 'neutral']);
export type MetricPolarity = z.infer<typeof MetricPolarity>;

/** What the rows behind a figure are. */
export const MetricDimension = z.enum([
  'route',
  'aircraft',
  'hub',
  'cabin_class',
  'flight',
  'segment',
  'ledger_category',
  /**
   * Not rows at all — a single record that explains the figure.
   *
   * Net worth drills to the credit standing because that is where the assets and
   * the borrowing it is made of are already reported. Pretending such a link had
   * a dimension would make `by` meaningless on the ones that do.
   */
  'record',
]);
export type MetricDimension = z.infer<typeof MetricDimension>;

/**
 * Where a figure goes when a player asks *"why?"* — §14.1's whole rule.
 *
 * `endpoint` is a **registered route pattern**, verbatim, including its `:params`.
 * `statistics-drilldown.test.ts` asks the router what exists and fails if this
 * names anything else, so a drill-down cannot rot into a link to a route that was
 * renamed. That is the difference between declaring a drill-down and having one.
 */
export const MetricDrillDown = z
  .object({
    endpoint: z.string().min(1),
    by: MetricDimension,
    /** Plain words for the link — "by route", "in the P&L". */
    label: z.string().min(1),
  })
  .strict();
export type MetricDrillDown = z.infer<typeof MetricDrillDown>;

/* ---- Horizons --------------------------------------------------------------- */

/** §14.2's middle horizon: a window, the window before it, and the movement. */
export const MetricTrend = z
  .object({
    days: z.number().int().positive(),
    value: z.number().nullable(),
    previousValue: z.number().nullable(),
    /** Fraction of the previous value. Null when there is nothing to divide by. */
    changePct: z.number().nullable(),
    /** Absolute change, which survives a previous value of zero (§14.6). */
    changeAbsolute: z.number().nullable(),
    direction: z.enum(['up', 'down', 'flat', 'unknown']),
  })
  .strict();
export type MetricTrend = z.infer<typeof MetricTrend>;

/**
 * §14.2's far horizon. **Never a single number.**
 *
 * `low` and `mid` and `high` are all required, and the band widens with
 * distance. A metric without enough history simply has no entry for that
 * horizon — an absent forecast is honest, a fabricated one is not.
 */
export const MetricForecast = z
  .object({
    horizonDays: z.number().int().positive(),
    mid: z.number(),
    low: z.number(),
    high: z.number(),
    /** How many observed buckets the projection was fitted through. */
    observations: z.number().int().nonnegative(),
  })
  .strict()
  .refine((band) => band.low <= band.mid && band.mid <= band.high, {
    message: 'A forecast band must bracket its own projection',
  });
export type MetricForecast = z.infer<typeof MetricForecast>;

/* ---- The wire --------------------------------------------------------------- */

/** One metric: what it is, what it reads, where it has been, and where it goes. */
export const Metric = z
  .object({
    id: MetricId,
    label: z.string().min(1),
    /** One sentence a tooltip can use. RASK and yield are not obviously different. */
    description: z.string().min(1),
    unit: MetricUnit,
    polarity: MetricPolarity,
    /** The trailing primary window. Null when nothing in it was measurable. */
    value: z.number().nullable(),
    /** 7 / 30 / 90 game days (§14.2). */
    trends: z.array(MetricTrend),
    /** 7 / 30 / 90 game days ahead, each a band. May be empty. */
    forecasts: z.array(MetricForecast),
    drillDown: MetricDrillDown,
  })
  .strict();
export type Metric = z.infer<typeof Metric>;

/** `GET /api/statistics` — every metric §14.3 exposes, with all three horizons. */
export const StatisticsResponse = z
  .object({
    gameNow: Timestamp,
    /** The window `value` covers, in game days. */
    windowDays: z.number().int().positive(),
    metrics: z.array(Metric),
  })
  .strict();
export type StatisticsResponse = z.infer<typeof StatisticsResponse>;

/** One contributing row behind a metric — the next rung of §14.1's ladder. */
export const MetricBreakdownRow = z
  .object({
    /** The row's own identifier, whatever the dimension keys on. */
    key: z.string().min(1),
    label: z.string().min(1),
    value: z.number().nullable(),
    /**
     * This row's share of the whole, 0–1, for the ones where that means anything.
     *
     * Null for a ratio: the load factors of five routes do not add up to the
     * airline's, and a share column that pretended they did would be the
     * confident-looking wrong number §14.1 is about.
     */
    share: z.number().min(0).max(1).nullable(),
    /** Where this row goes next. Null when it is the last rung. */
    drillDown: MetricDrillDown.nullable(),
  })
  .strict();
export type MetricBreakdownRow = z.infer<typeof MetricBreakdownRow>;

/** `GET /api/statistics/:metricId/breakdown` — the rows behind one figure. */
export const MetricBreakdownResponse = z
  .object({
    metric: MetricId,
    by: MetricDimension,
    gameNow: Timestamp,
    windowDays: z.number().int().positive(),
    /** The airline-level figure the rows explain, so the two can be compared. */
    total: z.number().nullable(),
    rows: z.array(MetricBreakdownRow),
  })
  .strict();
export type MetricBreakdownResponse = z.infer<typeof MetricBreakdownResponse>;

/* ---- The load-factor chain's missing rung ------------------------------------ */

/** One settled flight on a route (§14.1's route → **flight** → segment step). */
export const RouteFlightRow = z
  .object({
    flightId: z.string().min(1),
    /** Game time it left, or was scheduled to. */
    departedAt: Timestamp,
    seats: z.number().int().nonnegative(),
    passengers: z.number().int().nonnegative(),
    spilledPassengers: z.number().int().nonnegative(),
    loadFactor: z.number().min(0).max(1).nullable(),
    revenueMinor: z.number().int(),
    costMinor: z.number().int(),
    netMinor: z.number().int(),
    arrivalDelayMinutes: z.number().int(),
  })
  .strict();
export type RouteFlightRow = z.infer<typeof RouteFlightRow>;

/** `GET /api/routes/:routeId/flights` — the flights behind a route's figures. */
export const RouteFlightsResponse = z
  .object({
    routeId: z.string().min(1),
    windowDays: z.number().int().positive(),
    gameNow: Timestamp,
    flights: z.array(RouteFlightRow),
    /** Where a flight goes next: App. A's waterfall, per segment (§14.1). */
    drillDown: MetricDrillDown,
  })
  .strict();
export type RouteFlightsResponse = z.infer<typeof RouteFlightsResponse>;

/* ---- §14.4's ranked chart and its drill-down (M8-11) ------------------------ */

/**
 * Why a route is below the line, and what to do about it.
 *
 * > Loss-making routes sit below the line in red and the drill-down tells you
 * > whether it's **yield, cost, load factor or a competitor** — and therefore
 * > whether to **reprice, re-gauge, re-time, or kill it**.
 *
 * Four causes, four actions, paired one-to-one. `none`/`keep` is the fifth pair
 * and it is the honest answer for a profitable route: §14.4's chart ranks those
 * too, and naming their weakest lever as a problem would be a made-up finding.
 */
export const RouteCause = z.enum(['none', 'yield', 'cost', 'load_factor', 'competitor']);
export type RouteCause = z.infer<typeof RouteCause>;

export const RouteAction = z.enum(['keep', 'reprice', 're-gauge', 're-time', 'cut']);
export type RouteAction = z.infer<typeof RouteAction>;

/** One lever, and what closing its gap to the airline's median would be worth. */
export const RouteGapView = z
  .object({
    /** Minor units of contribution this lever would recover. Never negative. */
    worthMinor: MinorUnits.nonnegative(),
    /** The route's own figure. Null when the window has nothing to measure. */
    own: z.number().nullable(),
    /** The benchmark. Null for a one-route airline, which has no median. */
    peer: z.number().nullable(),
  })
  .strict();
export type RouteGapView = z.infer<typeof RouteGapView>;

/**
 * `GET /api/routes/:routeId/diagnosis` — §14.4's drill-down for one route.
 *
 * Carries **one** cause and **one** action, because three numbers and no
 * decision is where a confused player already was. The quantified gaps come with
 * it whichever cause won: a player told "cut this" will want to know what the
 * alternatives were worth, and §14.1 forbids a figure that cannot be
 * interrogated.
 */
export const RouteDiagnosisResponse = z
  .object({
    routeId: z.string().min(1),
    label: z.string().min(1),
    windowDays: z.number().int().positive(),
    gameNow: Timestamp,
    /** Settled flights the diagnosis read. Zero means it is reading nothing. */
    flights: z.number().int().nonnegative(),

    cause: RouteCause,
    action: RouteAction,
    contributionMinor: z.number().int(),
    loadFactor: z.number().nullable(),
    /** Deliberately unclamped: above 1, no load factor saves the route. */
    breakevenLoadFactor: z.number().nullable(),
    /** The distinction the chart exists to draw — fixable by filling, or not. */
    unfillable: z.boolean(),

    /** Share of the market held by everyone else. Null when competition is unknown. */
    rivalShare: z.number().min(0).max(1).nullable(),
    rivalShareThreshold: z.number().min(0).max(1),
    /** How many of the airline's other routes the medians were taken over. */
    peerRoutes: z.number().int().nonnegative(),

    gaps: z.object({ yield: RouteGapView, cost: RouteGapView, load: RouteGapView }).strict(),
  })
  .strict();
export type RouteDiagnosisResponse = z.infer<typeof RouteDiagnosisResponse>;
