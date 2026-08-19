/**
 * What the market is worth *today* (M3-02, App. A.2).
 *
 * M3-01 sized the base pool once, at world creation. This is A.2's second
 * equation, which runs continuously on top of it:
 *
 * ```
 * D_route = D_base · Season(date) · DayOfWeek · Economy_global · InducedDemand(fare)
 * ```
 *
 * ## Per segment, not per route
 *
 * A.2 gives one equation and three elasticities, which only makes sense if the
 * modulation runs **per segment** — and once it does, so must the seasonality.
 * The three segments do not move together, and the interesting thing about them
 * is that they move *against* each other:
 *
 * - **Leisure** peaks in the summer holidays and at Christmas.
 * - **Business** does the opposite. Nobody schedules a sales trip in the middle
 *   of August, and the last week of December is dead.
 * - **VFR** is the Christmas one: people fly home for it, in both hemispheres.
 *
 * So a route's segment *mix* is not fixed. A business-heavy pair in August is
 * temporarily a leisure route, which is exactly the kind of thing a player
 * should be able to see and plan around — and it falls out of modulating each
 * segment separately rather than being modelled on purpose.
 *
 * ## Summer is a hemisphere; Christmas is a calendar
 *
 * The distinction that makes the seasonality worth writing carefully. The summer
 * term flips below the equator — that is M3-02's second acceptance criterion —
 * and is computed from `seasonalPhase`, which M2-09 already made
 * hemisphere-aware. The holiday term does **not** flip: Sydney celebrates
 * Christmas in December, in the heat.
 *
 * ## A route has two ends, and they need not be in the same hemisphere
 *
 * Taking one end's season would make Amsterdam–Sydney a route with a strong
 * summer peak, which is wrong in an interesting way: it has demand all year
 * precisely *because* one end is always in summer. So the seasonal factor is the
 * mean of both ends'. Same-hemisphere pairs keep their full swing; cross-equator
 * pairs flatten out on their own, without a special case.
 */

import type { DemandSegment } from '@tailfin/shared';

import { type Month, seasonalPhase } from '../weather/climate';

import type { SegmentShares } from './gravity';
import type { Weekday } from '../schedule/rotation';

/** Every segment, in the order a readout should list them. */
export const DEMAND_SEGMENTS: readonly DemandSegment[] = ['business', 'leisure', 'vfr'];

/**
 * How one segment's demand moves through the year.
 *
 * Two terms, because there are two different kinds of season and they behave
 * differently at the equator — see the module note.
 */
export interface SeasonCurve {
  /**
   * The summer swing, as a fraction. Positive peaks in summer, negative in it.
   *
   * Leisure is positive and business negative, which is the counter-cycling that
   * makes the segment mix move.
   */
  summerAmplitude: number;
  /** Added during the December holidays, in both hemispheres. */
  holidayBoost: number;
}

/** Balance numbers (invariant 3), and M3-02's third acceptance criterion. */
export interface ModulationConfig {
  season: Record<DemandSegment, SeasonCurve>;
  /**
   * Multiplier per weekday, Monday through Sunday.
   *
   * A seven-number table rather than a formula, because the shape is not smooth:
   * business travel has two peaks a week (out on Monday, back on Thursday or
   * Friday) with a hole in the middle of the weekend, and leisure has exactly
   * the opposite. No curve expresses that as clearly as seven numbers do.
   */
  dayOfWeek: Record<DemandSegment, readonly number[]>;
  /**
   * A.2's ε, verbatim: business 0.35, leisure 0.9, VFR 0.7.
   *
   * The ordering is the whole mechanic. Leisure is nearly three times as
   * price-sensitive as business, so a fare cut grows the leisure market far more
   * than the business one — which is why an LCC entering a route partly
   * *creates* traffic rather than purely stealing it.
   */
  elasticity: Record<DemandSegment, number>;
  /**
   * The fare the base pool was sized at, in minor units.
   *
   * Induced demand is a ratio against this, so it is the price at which the
   * modulation does nothing. §13.4's worked example sells at €75, which is what
   * makes it the reference rather than an invented round number.
   */
  referenceFareMinor: number;
  /** The months counted as the December holidays. */
  holidayMonths: readonly Month[];
}

export const DEFAULT_MODULATION: ModulationConfig = {
  season: {
    // Summer holidays and Christmas both, and strongly. This is the segment that
    // makes a Mediterranean route worth three times as much in August as in
    // February.
    leisure: { summerAmplitude: 0.45, holidayBoost: 0.2 },
    // Counter-cyclical, and less violently so: business travel falls away in
    // August and over Christmas but never stops.
    business: { summerAmplitude: -0.2, holidayBoost: -0.25 },
    // The Christmas segment. People fly home for it far more than they fly
    // anywhere for the summer.
    vfr: { summerAmplitude: 0.15, holidayBoost: 0.5 },
  },
  dayOfWeek: {
    //         Mon   Tue   Wed   Thu   Fri   Sat   Sun
    business: [1.35, 1.15, 1.05, 1.25, 1.2, 0.4, 0.6],
    leisure: [0.8, 0.75, 0.8, 0.95, 1.3, 1.25, 1.15],
    vfr: [0.85, 0.8, 0.85, 1.0, 1.35, 1.15, 1.0],
  },
  elasticity: { business: 0.35, leisure: 0.9, vfr: 0.7 },
  referenceFareMinor: 7_500,
  holidayMonths: [12],
};

/** Version tag. A demand figure has to stay explicable after a retune (invariant 4). */
export const MODULATION_CONFIG_VERSION = 'v1' as const;

/** Where the route is, for the hemisphere the seasons follow. */
export interface RouteLatitudes {
  originLatitude: number;
  destinationLatitude: number;
}

/**
 * The seasonal multiplier for one segment on one date.
 *
 * The mean of both ends, so a cross-equator route flattens rather than following
 * whichever end happened to be listed first — see the module note.
 */
export function seasonFactor(
  segment: DemandSegment,
  month: Month,
  route: RouteLatitudes,
  config: ModulationConfig = DEFAULT_MODULATION,
): number {
  const curve = config.season[segment];
  const phase =
    (seasonalPhase(route.originLatitude, month) + seasonalPhase(route.destinationLatitude, month)) /
    2;

  const holiday = config.holidayMonths.includes(month) ? curve.holidayBoost : 0;
  // Floored rather than allowed to go negative: a segment can go quiet, but a
  // month cannot produce negative passengers, and a retune that pushed an
  // amplitude past 1 should degrade rather than invert.
  return Math.max(0, 1 + curve.summerAmplitude * phase + holiday);
}

/** The weekday multiplier for one segment. */
export function dayOfWeekFactor(
  segment: DemandSegment,
  weekday: Weekday,
  config: ModulationConfig = DEFAULT_MODULATION,
): number {
  const table = config.dayOfWeek[segment];
  const value = table[weekday - 1];
  if (value === undefined) {
    throw new Error(`No ${segment} weekday factor for day ${String(weekday)}`);
  }
  return value;
}

/**
 * A.2's induced demand: `(P_avg_market / P_reference)^(-ε)`.
 *
 * The market's *average* fare, not one operator's. A.2 is explicit that this is
 * a property of the whole market, which is what makes it a shared-world mechanic
 * rather than a private one: *"a whole market of high-fare operators is a
 * smaller market"*, and one airline cutting fares grows the pool everybody is
 * competing for.
 *
 * Below the reference this is greater than 1 — cheap fares grow the market — and
 * above it, less. That direction is M3-02's first acceptance criterion, and the
 * negative exponent is what produces it.
 */
export function inducedDemand(
  segment: DemandSegment,
  marketFareMinor: number,
  config: ModulationConfig = DEFAULT_MODULATION,
): number {
  if (!Number.isFinite(marketFareMinor) || marketFareMinor <= 0) {
    throw new Error(`Market fare must be positive, got ${String(marketFareMinor)}`);
  }
  return (marketFareMinor / config.referenceFareMinor) ** -config.elasticity[segment];
}

/** Every factor that moved one segment, so no figure is a dead end (§14.1). */
export interface SegmentFactors {
  base: number;
  season: number;
  dayOfWeek: number;
  economy: number;
  induced: number;
  /** The product, and the segment's passengers for the day. */
  passengers: number;
}

export interface ModulatedDemand {
  /** Passengers a day, across every segment, after everything. */
  dailyPassengers: number;
  bySegment: Record<DemandSegment, SegmentFactors>;
  /**
   * The segment mix *today*, which is not the pair's underlying mix.
   *
   * A business-heavy route in August is temporarily a leisure route. That is a
   * consequence of modulating each segment separately rather than a rule, and it
   * is worth surfacing because it is something a player can plan around.
   */
  shares: SegmentShares;
}

export interface ModulationInputs {
  /** From M3-01: the base pool, and the pair's underlying segment mix. */
  dailyPassengers: number;
  shares: SegmentShares;
  month: Month;
  weekday: Weekday;
  route: RouteLatitudes;
  /**
   * The world economy, 1 being normal (§20).
   *
   * A single scalar because A.2 makes it one: it is the term a recession or a
   * boom moves, and it applies to every segment equally. Whether business
   * travel is more recession-proof than leisure is a real question and not one
   * A.2 answers, so this does not invent an answer.
   */
  economy?: number;
  /** The market's average fare in minor units. Defaults to the reference. */
  marketFareMinor?: number;
}

/**
 * The pool for one route on one day.
 *
 * Pure, like everything here: the same route on the same date under the same
 * economy always produces the same number, which is what M13-02's economy
 * regression suite compares against.
 */
export function modulateDemand(
  inputs: ModulationInputs,
  config: ModulationConfig = DEFAULT_MODULATION,
): ModulatedDemand {
  const { dailyPassengers, shares, month, weekday, route } = inputs;
  const economy = inputs.economy ?? 1;
  const fare = inputs.marketFareMinor ?? config.referenceFareMinor;

  if (!Number.isFinite(dailyPassengers) || dailyPassengers < 0) {
    throw new Error(`Base pool must be zero or more, got ${String(dailyPassengers)}`);
  }
  if (!Number.isFinite(economy) || economy < 0) {
    throw new Error(`Economy must be zero or more, got ${String(economy)}`);
  }

  const bySegment = {} as Record<DemandSegment, SegmentFactors>;
  let total = 0;

  for (const segment of DEMAND_SEGMENTS) {
    const base = dailyPassengers * shares[segment];
    const season = seasonFactor(segment, month, route, config);
    const day = dayOfWeekFactor(segment, weekday, config);
    const induced = inducedDemand(segment, fare, config);
    const passengers = base * season * day * economy * induced;

    bySegment[segment] = { base, season, dayOfWeek: day, economy, induced, passengers };
    total += passengers;
  }

  return {
    dailyPassengers: total,
    bySegment,
    shares:
      total === 0
        ? { business: 0, leisure: 0, vfr: 0 }
        : {
            business: bySegment.business.passengers / total,
            leisure: bySegment.leisure.passengers / total,
            vfr: bySegment.vfr.passengers / total,
          },
  };
}
