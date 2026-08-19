import { describe, expect, it } from 'vitest';

import {
  MINOR_UNITS_PER_MAJOR,
  majorFromMinor,
  minorFromMajor,
  roundMinor,
  sumMinor,
} from './money';

/**
 * Money (M2-06).
 *
 * Small module, and the tests are about the two rules that make a `flight_result`
 * reconcile: rounding is symmetric about zero, and a total is a sum of already
 * whole amounts rather than a rounded sum of fractions.
 */

describe('roundMinor', () => {
  it('leaves a whole amount alone', () => {
    expect(roundMinor(1_234)).toBe(1_234);
    expect(roundMinor(0)).toBe(0);
  });

  it('rounds half away from zero, symmetrically', () => {
    // The property `Math.round` does not have. A charge and its refund must
    // round by the same amount, or reversing a transaction leaves a cent behind.
    expect(roundMinor(0.5)).toBe(1);
    expect(roundMinor(-0.5)).toBe(-1);
    expect(roundMinor(2.5)).toBe(3);
    expect(roundMinor(-2.5)).toBe(-3);
  });

  it('cancels a charge exactly when reversed', () => {
    for (const amount of [0.5, 1.5, -0.5, 12.34, -99.995]) {
      expect(roundMinor(amount) + roundMinor(-amount)).toBe(0);
    }
  });

  it('never returns negative zero, which would serialise as "-0"', () => {
    expect(Object.is(roundMinor(-0.4), 0)).toBe(true);
    expect(Object.is(roundMinor(-0), 0)).toBe(true);
  });

  it('refuses a non-finite amount', () => {
    expect(() => roundMinor(Number.NaN)).toThrow(/finite/);
    expect(() => roundMinor(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe('minorFromMajor', () => {
  it('is the one boundary between dollars and cents', () => {
    expect(minorFromMajor(1)).toBe(MINOR_UNITS_PER_MAJOR);
    expect(minorFromMajor(1_000)).toBe(100_000);
    expect(minorFromMajor(12.34)).toBe(1_234);
  });

  it('rounds a fractional cent rather than carrying it', () => {
    // $700.505 is 70050.5 cents. Half away from zero.
    expect(minorFromMajor(700.505)).toBe(70_051);
  });

  it('round-trips through majorFromMinor for whole amounts', () => {
    expect(majorFromMinor(minorFromMajor(856.8))).toBeCloseTo(856.8, 10);
  });
});

describe('sumMinor', () => {
  it('adds whole amounts', () => {
    expect(sumMinor([100, 250, 3])).toBe(353);
    expect(sumMinor([])).toBe(0);
  });

  it('refuses a fractional amount, which is the ordering bug it exists to catch', () => {
    // Summing fractions and rounding once at the end gives a total that does not
    // equal the sum of the displayed lines. This makes that unrepresentable.
    expect(() => sumMinor([100.5, 200])).toThrow(/whole minor units/);
  });
});
