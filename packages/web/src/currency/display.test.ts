import { afterEach, describe, expect, it } from 'vitest';

import type { CurrencyRateView } from '@tailfin/shared';

import {
  activeCurrency,
  compactUsdMinor,
  formatUsdMinor,
  inputToUsdMinor,
  setDisplayCurrency,
  usdMinorToInput,
} from './display';

/**
 * The display-currency formatter (M8-02).
 *
 * Converts USD minor units to the active currency at the render boundary. The
 * state is module-level, so each test sets it and the last one restores USD.
 */
function rate(code: string, rateE6: number, decimals = 2): CurrencyRateView {
  return {
    code,
    name: code,
    symbol: code === 'EUR' ? '€' : code === 'JPY' ? '¥' : '$',
    decimals,
    rateE6,
    refreshedAt: '2024-01-01T00:00:00.000Z',
    top: true,
  };
}

const RATES: CurrencyRateView[] = [
  rate('USD', 1_000_000, 2),
  rate('EUR', 900_000, 2),
  rate('JPY', 150_000_000, 0),
];

afterEach(() => {
  setDisplayCurrency('USD', RATES);
});

describe('formatUsdMinor', () => {
  it('shows USD by default, with symbol and two decimals', () => {
    setDisplayCurrency('USD', RATES);
    expect(activeCurrency()).toBe('USD');
    // $10,000.00 — the exact grouping/space can vary by runtime, so assert parts.
    const out = formatUsdMinor(1_000_000);
    expect(out).toContain('$');
    expect(out).toContain('10,000.00');
  });

  it('converts to the chosen currency at its rate', () => {
    setDisplayCurrency('EUR', RATES);
    // $100.00 (10_000 minor) × 0.9 = €90.00.
    const out = formatUsdMinor(10_000);
    expect(out).toContain('€');
    expect(out).toContain('90.00');
  });

  it('honours a currency with no minor units (JPY: no decimals)', () => {
    setDisplayCurrency('JPY', RATES);
    // $1.00 (100 minor) × 150 = ¥150, no decimal point.
    const out = formatUsdMinor(100);
    expect(out).toContain('150');
    expect(out).not.toContain('.');
  });

  it('applies a fraction-digit override (salaries show no cents)', () => {
    setDisplayCurrency('USD', RATES);
    expect(formatUsdMinor(123_456, { fractionDigits: 0 })).not.toContain('.');
  });

  it('falls back to parity for an unknown currency', () => {
    setDisplayCurrency('ZZZ', RATES);
    // Unsupported code resolves to USD.
    expect(activeCurrency()).toBe('USD');
  });
});

/*
 * A money field's two directions. A field pre-filled with a *formatted* figure
 * cannot be read back — the pricing tab once pre-filled `$120.00` and dropped
 * every cabin the player did not retype — so the field holds a plain number in
 * the display currency, and what is typed there comes back as USD minor units.
 */
describe('money fields', () => {
  it('shows a plain number in the display currency, at its own decimals', () => {
    setDisplayCurrency('USD', RATES);
    expect(usdMinorToInput(123_456)).toBe('1234.56');
    setDisplayCurrency('EUR', RATES);
    expect(usdMinorToInput(12_000)).toBe('108.00');
    setDisplayCurrency('JPY', RATES);
    expect(usdMinorToInput(12_000)).toBe('18000');
  });

  it('reads a typed number back as USD minor units', () => {
    setDisplayCurrency('USD', RATES);
    expect(inputToUsdMinor('99')).toBe(9_900);
    expect(inputToUsdMinor(' 120.5 ')).toBe(12_050);
    setDisplayCurrency('EUR', RATES);
    expect(inputToUsdMinor('90.00')).toBe(10_000);
  });

  it('refuses anything that is not a plain non-negative number', () => {
    setDisplayCurrency('USD', RATES);
    for (const typed of ['', '$120.00', '1,234.00', '-5', '12abc', '.5', '1e3']) {
      expect(inputToUsdMinor(typed)).toBeUndefined();
    }
  });

  it('round-trips what it shows, in every test currency', () => {
    for (const code of ['USD', 'EUR', 'JPY']) {
      setDisplayCurrency(code, RATES);
      for (const usdMinor of [0, 1, 99, 12_000, 30_000, 123_457, 9_999_999]) {
        // JPY shows whole yen, which is finer than a US cent, so it comes back
        // exactly as well.
        expect(inputToUsdMinor(usdMinorToInput(usdMinor))).toBe(usdMinor);
      }
    }
  });
});

describe('compactUsdMinor', () => {
  it('abbreviates thousands and millions with the active symbol', () => {
    setDisplayCurrency('USD', RATES);
    expect(compactUsdMinor(1_200_000)).toBe('$12.0k'); // $12,000
    expect(compactUsdMinor(500_000_000)).toBe('$5.0M'); // $5,000,000
    expect(compactUsdMinor(50_000)).toBe('$500'); // $500

    setDisplayCurrency('EUR', RATES);
    expect(compactUsdMinor(1_200_000)).toContain('€');
  });
});
