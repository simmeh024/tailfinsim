/**
 * When the seats actually sell (M3-08, App. A.15, A.7).
 *
 * A.7 said demand resolves once, one in-game day ahead — an anti-exploit rule,
 * stopping a player flipping fares seconds before departure. §14 wants a
 * booking-curve chart. A.15 reconciles them in one sentence:
 *
 * > *"Demand accrues progressively across a booking horizon and each booking is
 * > priced at the fare in force at that moment."*
 *
 * So the logit runs **once per in-game day per departure**, on that day's slice
 * of the pool, at whatever the fares are then. The anti-exploit property
 * survives exactly: a fare change can only reach bookings **not yet taken**,
 * because the ones already taken were priced on the day they happened and this
 * module never looks backwards.
 *
 * ## The horizon is fourteen slices, not fifteen
 *
 * A.15's horizon is *"14 in-game days before departure"*, and its third band is
 * *"the final 48 h"*. Those two only agree if the slices are `daysOut` 14 down
 * to **1**: seven days in the first band, five in the second, and two — exactly
 * forty-eight hours — in the last. Departure day itself carries no slice, which
 * is also how a real booking close works.
 *
 * ```
 * daysOut 14 … 8   15%   early leisure, price-led
 * daysOut  7 … 3   45%
 * daysOut  2 … 1   40%   late business, price-tolerant
 * ```
 *
 * Flat inside each band. A.15 specifies band totals rather than a smooth curve,
 * so the steps between bands are the model it asks for rather than an artefact
 * — and a fitted curve would invent precision the design doc does not have.
 *
 * ## The mix shifts, and that is the whole point
 *
 * A.15 again: the segment mix moving across the horizon *"is what makes
 * late-window pricing genuinely different from early-window pricing and gives
 * revenue management (post-MVP) something real to manage."*
 *
 * Each band tilts the segments, and then **each segment's fourteen daily
 * fractions are normalised to sum to exactly one**. That is what makes the
 * horizon reconstitute the day's demand rather than approximately reconstitute
 * it: whatever the tilts are retuned to, every passenger in the pool books on
 * exactly one day. Same discipline as M3-06's cabin propensities.
 *
 * ## The published shares are an aggregate, and a route moves them
 *
 * A consequence worth stating, because it looks like an error until you see
 * why it is not. A.15's 15/45/40 are shares of *total* demand, and the tilts
 * are calibrated so a route with no segment bias lands on them — measured at
 * 15.4 / 44.7 / 39.9.
 *
 * A real route does not land there, and should not. A leisure-heavy pair books
 * earlier in aggregate (18.1 / 47.5 / 34.4 on a 20/60/20 route) and a
 * business-heavy one books later, because the segments accrue on different
 * schedules. That *is* A.15's *"the segment mix shifts across the curve"*,
 * observed from the other end — and a model that pinned every route to
 * 15/45/40 would have had to delete it.
 */

import { type DemandSegment, ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import { DEMAND_SEGMENTS } from './modulation';

/** A.15: fourteen in-game days. `daysOut` runs 14 down to 1. */
export const BOOKING_HORIZON_DAYS = 14;

/** One stretch of the horizon, and how it leans. */
export interface BookingBand {
  /** Inclusive, counting down: 14 is the far end of the horizon. */
  fromDaysOut: number;
  toDaysOut: number;
  /** A.15's share of total demand for this band, before the segment tilt. */
  share: number;
  /**
   * How much each segment over- or under-books in this band, relative to its
   * own average. Normalised away afterwards, so only the *ratios between bands*
   * matter — a tilt of 2 everywhere is the same model as a tilt of 1 everywhere.
   */
  tilt: Record<DemandSegment, number>;
}

export interface BookingCurveConfig {
  bands: readonly BookingBand[];
}

/**
 * A.15's booking horizon, as currently tuned.
 *
 * The numbers live in `ECONOMY_CONFIG_V1` in `@tailfin/shared` — the same
 * payload that is seeded into `economy_config` and retuned live (M3-11, §22.3).
 * This constant is the default parameter for the pure functions below; the
 * server reads the world's pinned config instead, and lint stops it reaching
 * for this one.
 */
export const DEFAULT_BOOKING_CURVE: BookingCurveConfig = ECONOMY_CONFIG_V1.demand.bookingCurve;

/** Version tag. A booking has to stay explicable after a retune (invariant 4). */
export const BOOKING_CURVE_CONFIG_VERSION = 'v1' as const;

function assertHorizon(config: BookingCurveConfig): void {
  const covered = new Set<number>();
  let share = 0;

  for (const band of config.bands) {
    if (band.fromDaysOut < band.toDaysOut) {
      throw new Error(
        `A band counts down: ${String(band.fromDaysOut)} to ${String(band.toDaysOut)} is backwards`,
      );
    }
    for (let day = band.toDaysOut; day <= band.fromDaysOut; day += 1) {
      if (covered.has(day)) throw new Error(`Day ${String(day)} is in two bands`);
      covered.add(day);
    }
    share += band.share;
  }

  // Every day of the horizon exactly once, and the shares a whole. A gap here
  // would quietly delete a day's demand — the hardest kind of bug to see,
  // because the total merely comes out slightly low.
  for (let day = 1; day <= BOOKING_HORIZON_DAYS; day += 1) {
    if (!covered.has(day)) throw new Error(`Day ${String(day)} of the horizon is in no band`);
  }
  if (covered.size !== BOOKING_HORIZON_DAYS) {
    throw new Error(
      `Bands cover ${String(covered.size)} days, not ${String(BOOKING_HORIZON_DAYS)}`,
    );
  }
  if (Math.abs(share - 1) > 1e-9) {
    throw new Error(`Band shares sum to ${String(share)}, not 1`);
  }
}

function bandFor(daysOut: number, config: BookingCurveConfig): BookingBand {
  const band = config.bands.find((b) => daysOut <= b.fromDaysOut && daysOut >= b.toDaysOut);
  if (!band) throw new Error(`Day ${String(daysOut)} is outside the booking horizon`);
  return band;
}

/**
 * Each segment's daily fractions, normalised to sum to exactly one.
 *
 * The normalisation is what makes the horizon reconstitute the day's demand:
 * every passenger books on exactly one of the fourteen days, whatever the tilts
 * are retuned to.
 */
function dailyFractions(config: BookingCurveConfig): Record<DemandSegment, number[]> {
  assertHorizon(config);

  const result = {} as Record<DemandSegment, number[]>;

  for (const segment of DEMAND_SEGMENTS) {
    const raw: number[] = [];
    for (let daysOut = 1; daysOut <= BOOKING_HORIZON_DAYS; daysOut += 1) {
      const band = bandFor(daysOut, config);
      const days = band.fromDaysOut - band.toDaysOut + 1;
      const tilt = band.tilt[segment];
      if (!Number.isFinite(tilt) || tilt < 0) {
        throw new Error(`${segment} tilt must be zero or more, got ${String(tilt)}`);
      }
      raw[daysOut - 1] = (band.share / days) * tilt;
    }

    const total = raw.reduce((sum, w) => sum + w, 0);
    if (total <= 0) {
      throw new Error(`${segment} never books — every band tilts it to zero`);
    }
    result[segment] = raw.map((w) => w / total);
  }

  return result;
}

/**
 * The fraction of a segment's demand that books when the flight is `daysOut` away.
 *
 * `daysOut` is 14 at the far end of the horizon and 1 the day before departure.
 */
export function accrualFraction(
  daysOut: number,
  segment: DemandSegment,
  config: BookingCurveConfig = DEFAULT_BOOKING_CURVE,
): number {
  if (!Number.isInteger(daysOut) || daysOut < 1 || daysOut > BOOKING_HORIZON_DAYS) {
    throw new Error(`daysOut must be 1 to ${String(BOOKING_HORIZON_DAYS)}, got ${String(daysOut)}`);
  }
  return dailyFractions(config)[segment][daysOut - 1]!;
}

/**
 * One day's slice of a departure's demand, per segment.
 *
 * This is what the logit runs on: A.15's *"that day's slice of demand at current
 * fares and current competitor attributes"*. The caller supplies the fares in
 * force **today**, which is precisely why a fare change cannot reach yesterday.
 */
export function bookingSlice(
  daysOut: number,
  segmentPools: Record<DemandSegment, number>,
  config: BookingCurveConfig = DEFAULT_BOOKING_CURVE,
): Record<DemandSegment, number> {
  const fractions = dailyFractions(config);
  const slice = {} as Record<DemandSegment, number>;

  for (const segment of DEMAND_SEGMENTS) {
    const pool = segmentPools[segment];
    if (!Number.isFinite(pool) || pool < 0) {
      throw new Error(`${segment} pool must be zero or more, got ${String(pool)}`);
    }
    slice[segment] = pool * fractions[segment][daysOut - 1]!;
  }

  if (!Number.isInteger(daysOut) || daysOut < 1 || daysOut > BOOKING_HORIZON_DAYS) {
    throw new Error(`daysOut must be 1 to ${String(BOOKING_HORIZON_DAYS)}, got ${String(daysOut)}`);
  }
  return slice;
}

/* ----------------------------------------------------------- the record ---- */

/** What one day of selling actually did. */
export interface BookingDay {
  daysOut: number;
  bySegment: Record<DemandSegment, number>;
  passengers: number;
  /** The fare that was in force when these seats sold. */
  fareMinor: number;
  /** `passengers × fareMinor` on the day, which is why a later fare cannot change it. */
  revenueMinor: number;
}

/**
 * A departure's booking curve, as the dashboard asks for it (§14).
 *
 * Held as the days that happened rather than as a running total, because the
 * chart §14 wants is the shape, and because a total cannot answer *"what did I
 * sell that seat for"* — which is the question fare changes make interesting.
 */
export interface BookingCurve {
  departureId: string;
  days: readonly BookingDay[];
}

export function emptyCurve(departureId: string): BookingCurve {
  return { departureId, days: [] };
}

/**
 * Add a day's selling to the curve.
 *
 * Returns a new curve rather than mutating one: `packages/sim` returns data and
 * never writes it (invariant 2), and an append-only record is also the shape
 * that makes "only bookings not yet taken" true by construction — there is no
 * operation here that revisits a day already recorded.
 */
export function recordDay(curve: BookingCurve, day: BookingDay): BookingCurve {
  if (curve.days.some((d) => d.daysOut === day.daysOut)) {
    throw new Error(
      `${curve.departureId} already sold on day ${String(day.daysOut)} — a day cannot be re-run`,
    );
  }
  if (curve.days.some((d) => d.daysOut < day.daysOut)) {
    // Selling further out than a day already recorded would mean going back in
    // time, which is the exploit A.7 exists to prevent.
    throw new Error(
      `${curve.departureId} cannot sell at ${String(day.daysOut)} days out after selling closer in`,
    );
  }

  return { ...curve, days: [...curve.days, day] };
}

export interface CurveTotals {
  passengers: number;
  revenueMinor: number;
  bySegment: Record<DemandSegment, number>;
  /**
   * The average fare actually achieved, in minor units.
   *
   * Revenue ÷ passengers rather than the current fare — the whole point of the
   * curve is that a departure's seats sold at several different prices, and the
   * blended figure is the only honest one.
   */
  averageFareMinor: number;
  /** How much of the selling happened in A.15's final band. */
  lateShare: number;
}

export function curveTotals(
  curve: BookingCurve,
  config: BookingCurveConfig = DEFAULT_BOOKING_CURVE,
): CurveTotals {
  const lateBand = config.bands[config.bands.length - 1]!;

  let passengers = 0;
  let revenueMinor = 0;
  let late = 0;
  const bySegment = { business: 0, leisure: 0, vfr: 0 } as Record<DemandSegment, number>;

  for (const day of curve.days) {
    passengers += day.passengers;
    revenueMinor += day.revenueMinor;
    if (day.daysOut <= lateBand.fromDaysOut) late += day.passengers;
    for (const segment of DEMAND_SEGMENTS) bySegment[segment] += day.bySegment[segment];
  }

  return {
    passengers,
    revenueMinor,
    bySegment,
    averageFareMinor: passengers === 0 ? 0 : revenueMinor / passengers,
    lateShare: passengers === 0 ? 0 : late / passengers,
  };
}

/**
 * The segment mix of one band, as a share of that band's bookings.
 *
 * Exists so A.15's claim — that the mix shifts toward business late — is
 * inspectable rather than implied, and so a retune that flattened it is visible
 * as a number rather than only as a change in revenue somewhere downstream.
 */
export function bandMix(
  band: BookingBand,
  segmentPools: Record<DemandSegment, number>,
  config: BookingCurveConfig = DEFAULT_BOOKING_CURVE,
): Record<DemandSegment, number> {
  const fractions = dailyFractions(config);
  const totals = {} as Record<DemandSegment, number>;
  let all = 0;

  for (const segment of DEMAND_SEGMENTS) {
    let sum = 0;
    for (let daysOut = band.toDaysOut; daysOut <= band.fromDaysOut; daysOut += 1) {
      sum += segmentPools[segment] * fractions[segment][daysOut - 1]!;
    }
    totals[segment] = sum;
    all += sum;
  }

  if (all === 0) return { business: 0, leisure: 0, vfr: 0 };
  for (const segment of DEMAND_SEGMENTS) totals[segment] /= all;
  return totals;
}
