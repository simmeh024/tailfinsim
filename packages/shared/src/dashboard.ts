import { z } from 'zod';

import { CreditTier } from './credit';
import { Timestamp, Uuid } from './primitives';
import { MetricDrillDown, MetricPolarity, MetricTrend, MetricUnit } from './statistics';

/**
 * §14.3's Executive dashboard, assembled server-side (M8-10).
 *
 * > **Executive** — cash, **cash runway in days**, net worth, MTD profit vs.
 * > forecast, load factor, OTP, reputation, credit rating, top gainers and
 * > losers this week
 *
 * Nine figures from six subsystems. The page could fetch six endpoints and do
 * the arithmetic itself, and three of these nine would then be **invented in the
 * client**: net worth is cash plus tangible assets less debt, MTD-vs-forecast
 * compares a partial month against a projection, and "top movers" is a
 * week-over-week difference nothing else computes. A number a page derives is a
 * number the server cannot explain, which is the opposite of §14.1's rule.
 *
 * So the headline set is one response, each figure carrying the same four things
 * M8-09's metrics carry — value, unit, polarity, drill-down — plus the **rate of
 * change** §14.6 requires of every headline:
 *
 * > Absolute value **and** rate of change on every headline metric — a falling
 * > profit that's falling more slowly is a different story from one that isn't.
 */

/** The nine figures §14.3's Executive dashboard opens with. */
export const HeadlineId = z.enum([
  'cash',
  'cash_runway',
  'net_worth',
  'mtd_profit',
  'load_factor',
  'on_time',
  'reputation',
  'credit_rating',
]);
export type HeadlineId = z.infer<typeof HeadlineId>;

/**
 * One headline figure.
 *
 * `value` is null for a figure that has nothing to measure — an airline that has
 * never flown has no load factor, and zero would claim it flew empty. `text` is
 * for the one figure that is not a number at all: a credit rating is `B`, and
 * forcing it into a numeric tier index would make the tile lie about what it
 * knows.
 */
export const Headline = z
  .object({
    id: HeadlineId,
    label: z.string().min(1),
    unit: MetricUnit.or(z.literal('days')).or(z.literal('text')),
    polarity: MetricPolarity,
    value: z.number().nullable(),
    /** The rating, or any other figure whose value is a word. */
    text: z.string().nullable(),
    /** §14.6's rate of change. Always present; `direction: 'unknown'` when absent. */
    trend: MetricTrend,
    drillDown: MetricDrillDown,
  })
  .strict();
export type Headline = z.infer<typeof Headline>;

/**
 * Month-to-date profit against what was forecast for the same span.
 *
 * A band, not a number, for the reason §14.2 gives — so `variance` is measured
 * against the band's middle and `withinBand` says whether the airline is
 * actually off plan or merely inside the noise. A dashboard that showed a
 * variance without that flag would raise an alarm every month.
 */
export const MonthToDate = z
  .object({
    /** Game-time start of the month being measured. */
    monthStart: Timestamp,
    daysElapsed: z.number().int().nonnegative(),
    actualMinor: z.number().int(),
    forecastMinor: z.number().int().nullable(),
    forecastLowMinor: z.number().int().nullable(),
    forecastHighMinor: z.number().int().nullable(),
    varianceMinor: z.number().int().nullable(),
    withinBand: z.boolean(),
  })
  .strict();
export type MonthToDate = z.infer<typeof MonthToDate>;

/** One route that moved this week, and by how much. */
export const RouteMover = z
  .object({
    routeId: Uuid.nullable(),
    label: z.string().min(1),
    /** Contribution this week, minor units. */
    valueMinor: z.number().int(),
    /** The week before, for the comparison the ranking is made on. */
    previousMinor: z.number().int(),
    changeMinor: z.number().int(),
    drillDown: MetricDrillDown.nullable(),
  })
  .strict();
export type RouteMover = z.infer<typeof RouteMover>;

/** `GET /api/statistics/executive` — §14.3's Executive dashboard. */
export const ExecutiveDashboardResponse = z
  .object({
    gameNow: Timestamp,
    headlines: z.array(Headline),
    monthToDate: MonthToDate,
    /**
     * The week's biggest improvements and biggest deteriorations, by route.
     *
     * Ranked on the **change**, not on the level: §14.3 asks for movers, and the
     * best route in the network is not news if it was also the best last week.
     * Both lists are capped and either may be empty — a network where nothing
     * moved is a real answer.
     */
    gainers: z.array(RouteMover),
    losers: z.array(RouteMover),
    /** Tier as well as the headline, because the tile shows one and links to both. */
    creditTier: CreditTier,
  })
  .strict();
export type ExecutiveDashboardResponse = z.infer<typeof ExecutiveDashboardResponse>;
