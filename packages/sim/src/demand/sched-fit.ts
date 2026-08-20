/**
 * Whether you fly at a time the passenger wants (M3-04, App. A.3, §8.2).
 *
 * `SchedFit` sits in A.3's utility function with a β of 1.0 for business — the
 * third-largest business coefficient, behind product and frequency — and the
 * design doc never defines it. A.3 gives one line:
 *
 * > *"how well departure times match segment preference (business wants
 * > early-out/late-back; leisure doesn't care)"*
 *
 * So the curves here are **designed, not sourced**. Everything else in M3 was
 * calibrated against a published figure — A.8's worked example, A.2's
 * elasticities, EU261's bands — and this is the first model in the milestone
 * with no external anchor. It is worth saying plainly rather than letting the
 * shape look more authoritative than it is: these are plausible curves chosen
 * to make the mechanic behave the way A.3 describes, and A.11's tuning
 * discipline applies to them more than to anything else in the demand model.
 *
 * ## Why business is bimodal on a single direction
 *
 * "Early-out/late-back" reads like two different markets, and the temptation is
 * to give business one morning peak and put the evening peak on the return
 * route. That is wrong for the way the logit runs.
 *
 * The logit resolves **one direction of one route** at a time — A.4 splits a
 * directional pool between operators. On any given day AMS→LHR carries both the
 * people going out in the morning *and* the people going home in the evening,
 * because the return half of somebody else's trip is an outbound departure in
 * this market. So a single direction genuinely has two business peaks, and a
 * unimodal morning curve would make an 18:00 departure look worthless when it
 * is in fact the second-best slot of the day.
 *
 * ## Hourly anchors, interpolated
 *
 * Twenty-four numbers per segment rather than a formula, for the reason M3-02
 * gives for its weekday table: the shape is not smooth. Business has two peaks
 * and a hole between them, and no curve expresses that as clearly as the
 * numbers do.
 *
 * They are interpolated rather than read as buckets, and circularly, so 23:30
 * blends into 00:00. Buckets would put a cliff on each hour boundary, and a
 * cliff is something a player finds and games — moving a departure from 06:59
 * to 07:00 for a step change in share is not a decision anyone should be
 * rewarded for making.
 *
 * ## Local time, approximated from longitude
 *
 * The curve is over **local clock time at the origin**, and Tailfin has no
 * timezone data: `airport` carries latitude and longitude and nothing else, and
 * `ScheduledLeg.departureMinute` is minutes from the cycle anchor rather than a
 * clock reading.
 *
 * So local time is derived from longitude at fifteen degrees to the hour. That
 * is the honest approximation and it is wrong in known ways — it ignores
 * political timezone boundaries (Spain runs an hour ahead of its longitude,
 * China runs one zone across five), ignores daylight saving entirely, and
 * cannot produce the half-hour offsets India and parts of Australia use. The
 * error is under an hour for most of the world and up to about three hours at
 * the extremes.
 *
 * What would fix it is a timezone column on `airport`, populated at import
 * (M1-01's territory) — at which point {@link localMinuteOfDay} is the only
 * function that changes. The approximation is deliberately isolated here for
 * that reason.
 */

import type { DemandSegment } from '@tailfin/shared';

import { MINUTES_PER_DAY } from '../schedule/rotation';

import { DEMAND_SEGMENTS } from './modulation';

/** How many anchors a curve has — one per hour of local time. */
export const CURVE_HOURS = 24;

/**
 * Balance numbers: how much each segment likes each hour of the local day.
 *
 * Values are 0..1 where 1 is the segment's most-wanted hour. The absolute level
 * matters as well as the shape — β_sched multiplies it directly, so a segment
 * whose curve never reaches 1 simply cares less overall.
 */
export interface SchedFitConfig {
  curve: Record<DemandSegment, readonly number[]>;
  /**
   * How much a pile of mediocre departures can substitute for a good one.
   *
   * Departures combine as "at least one of these suits me" (see
   * {@link schedFit}), and at an exponent of 1 that is plain noisy-or — which
   * saturates far too fast to be a mechanic. Measured: six business departures
   * spread across the day score 1.00, and six crammed into the dead middle of
   * the afternoon still score **0.91**. A β_sched of 1.0 then makes the
   * difference between the best and worst possible six-flight schedule worth
   * 0.09 of utility, which is nothing.
   *
   * Raising the exponent discounts mediocre departures before combining them
   * and takes the root afterwards, so a single departure still scores exactly
   * its own fit and adding one can still never hurt. At 2, that same pair of
   * banks scores 1.00 against 0.71 — a gap worth having.
   *
   * It is a balance number like any other and belongs in config for the same
   * reason: it decides whether frequency can buy its way out of a bad schedule.
   */
  bankExponent: number;
}

export const DEFAULT_SCHED_FIT: SchedFitConfig = {
  curve: {
    /**
     * Two peaks and a hole. 07:00 is the best hour of the day, 18:00 nearly as
     * good, and the middle of the afternoon is worth less than a third of
     * either. Overnight is close to worthless: a 03:00 departure is not a
     * business proposition at any price, which is why the trough is 0.02 rather
     * than something merely low.
     */
    //         00    01    02    03    04    05    06    07    08    09    10    11
    business: [
      0.02, 0.02, 0.02, 0.02, 0.05, 0.35, 0.85, 1.0, 0.95, 0.7, 0.45, 0.35,
      //     12    13    14    15    16    17    18    19    20    21    22    23
      0.3, 0.3, 0.35, 0.45, 0.65, 0.85, 0.95, 0.85, 0.6, 0.3, 0.1, 0.04,
    ],
    /**
     * Broad and mid-day tolerant, exactly as A.3 says. Anything between 09:00
     * and 17:00 is close to ideal, and the early morning is only mildly worse —
     * a 07:00 holiday departure is normal, and often the cheap one. What
     * leisure dislikes is the small hours, and even then less than business
     * does.
     */
    leisure: [
      0.12, 0.1, 0.1, 0.1, 0.15, 0.45, 0.72, 0.88, 0.94, 0.97, 1.0, 1.0, 1.0, 0.98, 0.96, 0.94,
      0.92, 0.9, 0.85, 0.76, 0.64, 0.48, 0.3, 0.18,
    ],
    /**
     * Near-flat, per the issue. Someone flying home to see family will take
     * whatever is going; the only real preference is against the small hours,
     * and even that is mild. The full range is about a third, against nearly
     * the whole scale for business — that gap *is* the mechanic.
     */
    vfr: [
      0.7, 0.66, 0.64, 0.64, 0.7, 0.8, 0.88, 0.93, 0.96, 0.98, 1.0, 1.0, 1.0, 1.0, 0.99, 0.98, 0.97,
      0.96, 0.95, 0.93, 0.9, 0.85, 0.8, 0.74,
    ],
  },
  bankExponent: 2,
};

/** Version tag. A share has to stay explicable after a retune (invariant 4). */
export const SCHED_FIT_CONFIG_VERSION = 'v1' as const;

/**
 * UTC offset in minutes, approximated from longitude at 15° to the hour.
 *
 * See the module note for what this gets wrong. It is deliberately the only
 * place that makes the assumption, so a real timezone column replaces one
 * function rather than a scattering of arithmetic.
 */
export function approximateUtcOffsetMinutes(longitudeDeg: number): number {
  if (!Number.isFinite(longitudeDeg) || longitudeDeg < -180 || longitudeDeg > 180) {
    throw new Error(`Longitude must be within ±180°, got ${String(longitudeDeg)}`);
  }
  return Math.round((longitudeDeg / 15) * 60);
}

/** Bring any minute onto the clock, including a negative one. */
function onClock(minute: number): number {
  return ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Local clock minute-of-day at a given longitude, for a UTC instant.
 *
 * This is the bridge between the schedule, which counts minutes from a cycle
 * anchor, and the curves, which are read against a wall clock.
 */
export function localMinuteOfDay(at: Date, longitudeDeg: number): number {
  const utcMinutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  if (!Number.isFinite(utcMinutes)) {
    throw new Error('Departure time is not a date');
  }
  return onClock(utcMinutes + approximateUtcOffsetMinutes(longitudeDeg));
}

/**
 * How well one departure suits one segment, 0..1.
 *
 * Linear interpolation between the two neighbouring hourly anchors, wrapping at
 * midnight — see the module note on why this is not a bucket lookup.
 *
 * The minute is taken as a clock reading, so a value outside 0–1439 wraps
 * rather than throwing: a rotation that runs past midnight legitimately
 * produces one, and 25:00 is 01:00.
 */
export function departureFit(
  localMinute: number,
  segment: DemandSegment,
  config: SchedFitConfig = DEFAULT_SCHED_FIT,
): number {
  if (!Number.isFinite(localMinute)) {
    throw new Error(`Departure minute must be a number, got ${String(localMinute)}`);
  }

  const curve = config.curve[segment];
  if (curve.length !== CURVE_HOURS) {
    throw new Error(
      `The ${segment} curve needs ${String(CURVE_HOURS)} hourly values, got ${String(curve.length)}`,
    );
  }

  const position = onClock(localMinute) / 60;
  const hour = Math.floor(position);
  const next = (hour + 1) % CURVE_HOURS;
  const blend = position - hour;

  const from = curve[hour];
  const to = curve[next];
  if (from === undefined || to === undefined) {
    throw new Error(`The ${segment} curve has a hole at hour ${String(hour)}`);
  }

  return from + (to - from) * blend;
}

/**
 * How well a whole bank of departures suits one segment, 0..1.
 *
 * **A passenger needs one flight, not all of them**, so the departures combine
 * as "at least one of these suits me" rather than as an average:
 *
 * ```
 * SchedFit = (1 − Π(1 − fit_i^γ))^(1/γ)      γ = bankExponent
 * ```
 *
 * The obvious alternative — the mean fit across the bank — was rejected, and
 * the reason is worth recording because the mean looks more natural. Under a
 * mean, adding a badly-timed fourth departure *lowers* SchedFit, so an operator
 * is punished for offering more choice. That is wrong on its own terms, and it
 * also double-counts: A.3 already prices frequency separately through
 * `β_freq · ln(Frequency)`, and SchedFit is meant to measure timing quality,
 * not quantity.
 *
 * The exponent is there because the plain form (γ = 1) turned out to saturate
 * too fast to be a mechanic. That was measured rather than guessed: at γ = 1,
 * six business departures crammed into the dead middle of the afternoon score
 * **0.91** against 1.00 for six spread across the day, so the worst possible
 * six-flight schedule costs 0.09 of utility and frequency simply buys its way
 * out of bad timing. At γ = 2 the same comparison is 0.71 against 1.00.
 *
 * Both properties survive the exponent, and both are asserted as tests: one
 * departure returns its own fit exactly, and adding a departure can never lower
 * the score.
 *
 * What does *not* change is that SchedFit still saturates eventually, and that
 * is intended rather than hidden — a six-times-daily operator spread across the
 * day genuinely does have a flight when you want one. Scheduling skill matters
 * most where the choices are scarce.
 */
export function schedFit(
  localMinutes: readonly number[],
  segment: DemandSegment,
  config: SchedFitConfig = DEFAULT_SCHED_FIT,
): number {
  if (localMinutes.length === 0) {
    throw new Error('An operator with no departures is not in this market');
  }

  const exponent = config.bankExponent;
  if (!Number.isFinite(exponent) || exponent <= 0) {
    throw new Error(`Bank exponent must be positive, got ${String(exponent)}`);
  }

  let missAll = 1;
  for (const minute of localMinutes) {
    missAll *= 1 - departureFit(minute, segment, config) ** exponent;
  }
  // The root undoes the discount, so a single departure returns its own fit
  // exactly however the exponent is tuned.
  return (1 - missAll) ** (1 / exponent);
}

/**
 * Every segment's fit for one bank, shaped for the logit.
 *
 * This is the integration seam: the result drops straight into M3-03's
 * `Operator.schedFit`, so a caller assembles a market without knowing how the
 * curves work.
 */
export function schedFitBySegment(
  localMinutes: readonly number[],
  config: SchedFitConfig = DEFAULT_SCHED_FIT,
): Record<DemandSegment, number> {
  const result = {} as Record<DemandSegment, number>;
  for (const segment of DEMAND_SEGMENTS) {
    result[segment] = schedFit(localMinutes, segment, config);
  }
  return result;
}

/**
 * The best and worst hours of the day for a segment, and the spread between.
 *
 * Exists so the difference between the segments is inspectable rather than
 * implied — a curve that has quietly been retuned flat is a curve that has
 * stopped being a mechanic, and §14.1's no-dead-end-numbers rule applies to
 * balance data as much as to a player-facing figure.
 */
export function curveProfile(
  segment: DemandSegment,
  config: SchedFitConfig = DEFAULT_SCHED_FIT,
): { bestHour: number; worstHour: number; spread: number } {
  const curve = config.curve[segment];
  let bestHour = 0;
  let worstHour = 0;

  curve.forEach((value, hour) => {
    if (value > (curve[bestHour] ?? 0)) bestHour = hour;
    if (value < (curve[worstHour] ?? 0)) worstHour = hour;
  });

  return {
    bestHour,
    worstHour,
    spread: (curve[bestHour] ?? 0) - (curve[worstHour] ?? 0),
  };
}
