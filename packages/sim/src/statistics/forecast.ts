/**
 * §14.2's forecast, which is a **band** and never a number (M8-09).
 *
 * > Forecasts come from committed schedule, current booking curves, known events
 * > and contracted costs. They carry a **confidence band, never a single
 * > number** — the same honesty rule as event forecasting.
 *
 * ## What this is, and what it deliberately is not
 *
 * This is a projection of an airline's own recent history: a least-squares line
 * through the trailing buckets, carried forward, with a band from how badly that
 * line fitted. It does **not** read the committed schedule, the booking curve or
 * §18's events, because none of those exists as a queryable forecast input yet —
 * the schedule horizon is 14 game days, bookings are not modelled as a curve, and
 * §18 has no event model at all.
 *
 * Saying so is the point. A forecast that claimed those inputs while using none
 * of them would be the *"number players will not trust"* §14.1 is about, and the
 * band is what keeps this one honest: a noisy airline gets a wide one, and no
 * caller can mistake it for a promise.
 *
 * ## The band widens with distance, because it must
 *
 * §14.2 asks for *"a confidence band widening with distance"*. The half-width
 * scales with `sqrt(1 + horizon / observed)`, which is the ordinary standard
 * error of a prediction made further from the data than the data reaches. A
 * fixed-width band would say a ninety-day forecast is as good as a seven-day
 * one, which is the specific dishonesty the rule exists to prevent.
 *
 * ## Refusing is a valid answer
 *
 * Fewer than {@link MIN_OBSERVATIONS} real points and there is no forecast at
 * all — `null`, not a flat line through one number. An airline three days old
 * has no trend, and inventing one is worse than an empty chart.
 *
 * No balance literals: the multiplier and the minimum are properties of the
 * arithmetic rather than of the economy, and neither prices anything.
 */

/** Below this many observed buckets there is no trend to project. */
export const MIN_OBSERVATIONS = 3;

/**
 * How many residual standard deviations the band spans either side of the line.
 *
 * Two, which is roughly a 95% interval for normal residuals. A property of the
 * statistic, not a tuning knob — the honest reading of *"confidence band"*, and
 * a narrower one would be a claim about the model nobody has earned.
 */
const BAND_SIGMAS = 2;

export interface ForecastBand {
  /** Game days ahead of the last observation this band describes. */
  horizonDays: number;
  /** The projection itself. Always between `low` and `high`. */
  mid: number;
  low: number;
  high: number;
  /** How many observed buckets the line was fitted through. */
  observations: number;
}

/**
 * Project a series forward, with a band.
 *
 * `history` is oldest first, one entry per bucket, and `null` means the bucket
 * was not measured rather than measured as zero — a week the airline flew
 * nothing must not drag a load-factor trend to the floor. Nulls are skipped and
 * the surviving points keep their original positions, so a gap widens the band
 * instead of being silently closed up.
 *
 * `bucketDays` is how long one bucket is, so a caller folding game weeks and a
 * caller folding game days get the same answer for the same horizon.
 */
export function forecastBand(
  history: readonly (number | null)[],
  horizonDays: number,
  bucketDays = 1,
): ForecastBand | null {
  const points: { x: number; y: number }[] = [];
  history.forEach((value, index) => {
    if (value !== null && Number.isFinite(value)) points.push({ x: index, y: value });
  });
  if (points.length < MIN_OBSERVATIONS || bucketDays <= 0 || horizonDays <= 0) return null;

  const n = points.length;
  const meanX = points.reduce((total, p) => total + p.x, 0) / n;
  const meanY = points.reduce((total, p) => total + p.y, 0) / n;

  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sxx += (point.x - meanX) ** 2;
    sxy += (point.x - meanX) * (point.y - meanY);
  }
  // Every observation in the same bucket: no slope to speak of, so the flat line
  // through the mean is the honest projection rather than a division by zero.
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;

  let residualSquares = 0;
  for (const point of points) {
    residualSquares += (point.y - (slope * point.x + intercept)) ** 2;
  }
  // n - 2 is the residual degrees of freedom of a fitted line; with exactly two
  // usable points the fit is perfect and says nothing, so fall back to n.
  const sigma = Math.sqrt(residualSquares / Math.max(1, n - 2));

  const lastX = history.length - 1;
  const aheadBuckets = horizonDays / bucketDays;
  const mid = slope * (lastX + aheadBuckets) + intercept;

  /*
   * The band widens with distance. `observedBuckets` is how far the data itself
   * reaches, so forecasting one window ahead of a window of data multiplies the
   * half-width by √2 — and ninety days from thirty days of history is wider
   * still, which is exactly what §14.2 asks the chart to show.
   */
  const observedBuckets = Math.max(1, lastX);
  const halfWidth = BAND_SIGMAS * sigma * Math.sqrt(1 + aheadBuckets / observedBuckets);

  return {
    horizonDays,
    mid,
    low: mid - halfWidth,
    high: mid + halfWidth,
    observations: n,
  };
}

/**
 * A band clamped into the range its metric can actually occupy.
 *
 * A load factor cannot be 1.4 and a forecast that says so is not honest about
 * uncertainty, it is wrong about arithmetic. Applied by the caller, per metric,
 * because only the caller knows which metrics are bounded — nothing here should
 * decide that a currency figure cannot be negative.
 */
export function clampBand(band: ForecastBand, min: number, max: number): ForecastBand {
  const clamp = (value: number): number => Math.min(max, Math.max(min, value));
  return { ...band, mid: clamp(band.mid), low: clamp(band.low), high: clamp(band.high) };
}
