import { describe, expect, it } from 'vitest';

import { clampBand, forecastBand, MIN_OBSERVATIONS } from './forecast';
import { trendOf } from './trend';

/**
 * §14.2's forecast and trend, and M8-09's second acceptance criterion.
 *
 * > Forecasts return a band, never a single number.
 *
 * Which is two claims: that a band comes back at all, and that it is a *band* —
 * wider further out, and refused outright when there is nothing to project.
 */
describe('the forecast band', () => {
  it('projects a clean trend to the right place', () => {
    // 10, 12, 14, 16, 18 — a slope of 2 per bucket, six buckets ahead.
    const band = forecastBand([10, 12, 14, 16, 18], 6, 1);
    expect(band).not.toBeNull();
    expect(band?.mid).toBeCloseTo(30, 6);
    // A perfect fit has no residual, so the band is the line. Honest: there is
    // genuinely no evidence of noise in this series.
    expect(band?.low).toBeCloseTo(30, 6);
    expect(band?.high).toBeCloseTo(30, 6);
  });

  it('never returns a bare number — the band is always present (AC2)', () => {
    const band = forecastBand([10, 14, 11, 17, 12, 19], 30, 1);
    expect(band).not.toBeNull();
    expect(band?.low).toBeLessThan(band?.mid ?? 0);
    expect(band?.high).toBeGreaterThan(band?.mid ?? 0);
  });

  it('widens with distance, so ninety days is not as good as seven', () => {
    const noisy = [10, 14, 11, 17, 12, 19, 13, 21];
    const near = forecastBand(noisy, 7, 1);
    const far = forecastBand(noisy, 90, 1);
    const width = (b: NonNullable<typeof near>) => b.high - b.low;

    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    // §14.2 asks for "a confidence band widening with distance". A fixed width
    // would claim a ninety-day forecast is as good as a seven-day one.
    expect(width(far!)).toBeGreaterThan(width(near!));
  });

  it('refuses rather than inventing a trend from nothing', () => {
    expect(forecastBand([], 30)).toBeNull();
    expect(forecastBand([5], 30)).toBeNull();
    expect(forecastBand([5, 6], 30)).toBeNull();
    expect(forecastBand([5, 6, 7], 30)).not.toBeNull();
    expect(MIN_OBSERVATIONS).toBe(3);
  });

  it('treats an unmeasured bucket as a gap, not as a zero', () => {
    // A week the airline flew nothing must not drag a load-factor trend to the
    // floor. Skipped, and the gap widens the band rather than closing up.
    const withGap = forecastBand([0.8, null, 0.82, null, 0.84, 0.86], 7, 1);
    expect(withGap).not.toBeNull();
    expect(withGap?.mid ?? 0).toBeGreaterThan(0.8);
    expect(withGap?.observations).toBe(4);
  });

  it('does not divide by zero when every point is in the same bucket', () => {
    const band = forecastBand([3, 3, 3], 30, 1);
    expect(band?.mid).toBeCloseTo(3, 10);
  });

  it('honours the bucket length, so weeks and days agree about a horizon', () => {
    const series = [10, 12, 14, 16];
    const weekly = forecastBand(series, 28, 7);
    const daily = forecastBand(series, 4, 1);
    expect(weekly?.mid).toBeCloseTo(daily?.mid ?? 0, 10);
  });

  it('clamps into the range a metric can occupy, when the caller says so', () => {
    const band = forecastBand([0.9, 0.94, 0.98, 1.0], 30, 1);
    expect(band).not.toBeNull();
    const clamped = clampBand(band!, 0, 1);
    // A load factor cannot be 1.4. That is not uncertainty, it is arithmetic.
    expect(clamped.high).toBeLessThanOrEqual(1);
    expect(clamped.low).toBeGreaterThanOrEqual(0);
  });
});

describe('the trend', () => {
  it('carries the level and the movement, never one without the other', () => {
    const trend = trendOf(30, 120, 100);
    expect(trend.value).toBe(120);
    expect(trend.previousValue).toBe(100);
    expect(trend.changeAbsolute).toBe(20);
    expect(trend.changePct).toBeCloseTo(0.2, 10);
    expect(trend.direction).toBe('up');
  });

  it('says nothing about whether up is good', () => {
    // A rising CASK is bad and a rising load factor is good. Deciding that here
    // would put a judgement in a module that cannot see the metric.
    expect(trendOf(7, 5, 4).direction).toBe('up');
    expect(trendOf(7, 4, 5).direction).toBe('down');
    expect(trendOf(7, 4, 4).direction).toBe('flat');
  });

  it('keeps the absolute change when there is no percentage to take', () => {
    const fromZero = trendOf(7, 40, 0);
    expect(fromZero.changePct).toBeNull();
    expect(fromZero.changeAbsolute).toBe(40);
    expect(fromZero.direction).toBe('up');
  });

  it('is unknown, not flat, when a window was never measured', () => {
    const unmeasured = trendOf(90, null, 12);
    expect(unmeasured.direction).toBe('unknown');
    expect(unmeasured.changeAbsolute).toBeNull();
  });

  it('handles a negative previous value without inverting the percentage', () => {
    // A loss of 100 becoming a loss of 50 is a 50% improvement, not −50%.
    const recovering = trendOf(30, -50, -100);
    expect(recovering.changeAbsolute).toBe(50);
    expect(recovering.changePct).toBeCloseTo(0.5, 10);
    expect(recovering.direction).toBe('up');
  });
});
