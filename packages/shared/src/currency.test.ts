import { describe, expect, it } from 'vitest';

import {
  convertUsdMinor,
  currencyMeta,
  DEFAULT_CURRENCY,
  DisplayCurrency,
  RATE_SCALE,
  SUPPORTED_CURRENCIES,
  TOP_CURRENCIES,
} from './currency';

/**
 * Display currency (M8-02).
 *
 * The metadata and the conversion are the parts other packages depend on: the
 * server seeds from `SUPPORTED_CURRENCIES` and the web converts with
 * `convertUsdMinor`. These pin the invariants both rely on.
 */
describe('currency metadata', () => {
  it('lists the default and the pinned five, in order, all supported', () => {
    expect(DEFAULT_CURRENCY).toBe('USD');
    expect(TOP_CURRENCIES).toEqual(['USD', 'EUR', 'GBP', 'JPY', 'AUD']);
    for (const code of TOP_CURRENCIES) {
      expect(currencyMeta(code), `${code} must be supported`).toBeDefined();
    }
    // The pinned five are the head of the list, in the same order.
    expect(SUPPORTED_CURRENCIES.slice(0, TOP_CURRENCIES.length).map((c) => c.code)).toEqual([
      ...TOP_CURRENCIES,
    ]);
  });

  it('gives JPY and KRW zero minor digits and the rest two', () => {
    expect(currencyMeta('JPY')?.decimals).toBe(0);
    expect(currencyMeta('KRW')?.decimals).toBe(0);
    expect(currencyMeta('USD')?.decimals).toBe(2);
    expect(currencyMeta('EUR')?.decimals).toBe(2);
  });

  it('has a unique code, a symbol and a name for every currency', () => {
    const codes = SUPPORTED_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of SUPPORTED_CURRENCIES) {
      expect(c.symbol.length).toBeGreaterThan(0);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it('accepts a supported code and rejects an unknown one', () => {
    expect(DisplayCurrency.safeParse('EUR').success).toBe(true);
    expect(DisplayCurrency.safeParse('XyZ').success).toBe(false);
    expect(DisplayCurrency.safeParse('usd').success).toBe(false); // case-sensitive ISO codes
  });
});

describe('convertUsdMinor', () => {
  it('is identity at parity (USD → USD)', () => {
    expect(convertUsdMinor(12_345, RATE_SCALE)).toBe(12_345);
  });

  it('converts by the scaled rate and rounds to the nearest minor unit', () => {
    // $100.00 at 0.92 EUR/USD = €92.00 → 9_200 minor.
    expect(convertUsdMinor(10_000, Math.round(0.92 * RATE_SCALE))).toBe(9_200);
    // $1.005 worth (100 minor) at 1.5 → 150.
    expect(convertUsdMinor(100, Math.round(1.5 * RATE_SCALE))).toBe(150);
    // Rounds half up: 101 minor × 1.005 = 101.505 → 102.
    expect(convertUsdMinor(101, Math.round(1.005 * RATE_SCALE))).toBe(102);
  });

  it('always returns an integer (no floating-point money)', () => {
    for (const rate of [1.0, 0.79, 149, 1330, 0.000123]) {
      const out = convertUsdMinor(7_777, Math.round(rate * RATE_SCALE));
      expect(Number.isInteger(out)).toBe(true);
    }
  });
});
