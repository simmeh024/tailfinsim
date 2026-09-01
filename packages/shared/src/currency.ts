import { z } from 'zod';

import { Timestamp } from './primitives';

/**
 * Display currency (M8-02, §24).
 *
 * The internal accounting currency is **USD, integer minor units** — that is
 * what every money value in the database, on the wire and in `@tailfin/sim` is,
 * and none of that changes. A player may pick a *display* currency; the client
 * converts USD minor units to it at the render boundary using a rate from
 * `currency_rate`, and nothing else. So a rate is a **display** concern: no
 * stored or computed money value is ever denominated in anything but USD.
 *
 * A rate is a ratio, not money, so it is exempt from the no-float-money rule —
 * but it is still carried as a **scaled integer** (`rateE6`, rate × 1,000,000)
 * so conversion is deterministic rather than a float multiply.
 */

/** One supported currency's fixed metadata — not its (moving) rate. */
export interface CurrencyMeta {
  /** ISO-4217 code, e.g. `USD`. */
  code: string;
  /** Human name for the settings list, e.g. `US Dollar`. */
  name: string;
  /** The symbol to show, e.g. `$`. */
  symbol: string;
  /** Minor-unit digits: 2 for most, 0 for JPY/KRW. Drives display formatting. */
  decimals: number;
}

/**
 * The five currencies pinned to the top of the settings list, in this order.
 * Dollar first, because USD is the default and the accounting currency.
 */
export const TOP_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD'] as const;

/**
 * Every supported display currency. The five in `TOP_CURRENCIES` come first and
 * in that order; the rest follow alphabetically by code. `SUPPORTED_CURRENCIES`
 * is the single source of truth for which codes exist — the zod enum, the seed
 * baseline and the settings list all derive from it.
 */
export const SUPPORTED_CURRENCIES: readonly CurrencyMeta[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
  { code: 'GBP', name: 'British Pound', symbol: '£', decimals: 2 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0 },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimals: 2 },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', decimals: 2 },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', decimals: 2 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', decimals: 2 },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', decimals: 2 },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', decimals: 2 },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr', decimals: 2 },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', decimals: 2 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimals: 2 },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', decimals: 0 },
  { code: 'MXN', name: 'Mexican Peso', symbol: 'MX$', decimals: 2 },
  { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr', decimals: 2 },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', decimals: 2 },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', decimals: 2 },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', decimals: 2 },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', decimals: 2 },
];

/** The accounting currency and the default a player displays until they choose. */
export const DEFAULT_CURRENCY = 'USD' as const;

/** The scale of `rateE6`: a rate is stored/carried as `rate × 1,000,000`. */
export const RATE_SCALE = 1_000_000 as const;

const CURRENCY_CODES = SUPPORTED_CURRENCIES.map((c) => c.code) as [string, ...string[]];

/** A supported display-currency code. The enum is derived from `SUPPORTED_CURRENCIES`. */
export const DisplayCurrency = z.enum(CURRENCY_CODES);
export type DisplayCurrency = z.infer<typeof DisplayCurrency>;

/** Look up a currency's metadata, or `undefined` for an unsupported code. */
export function currencyMeta(code: string): CurrencyMeta | undefined {
  return SUPPORTED_CURRENCIES.find((c) => c.code === code);
}

/**
 * Convert USD minor units to another currency's minor units at `rateE6`.
 *
 * Integer throughout, rounded half-up, so the result is deterministic and the
 * no-float-money rule holds even though the rate is fractional. This is a
 * **display** conversion — it never feeds a stored value or a calculation.
 *
 * Note the source is always USD minor units (2 decimals); the *target's* own
 * decimal count is a formatting concern the caller applies, not this function's.
 */
export function convertUsdMinor(usdMinor: number, rateE6: number): number {
  // usdMinor * (rateE6 / RATE_SCALE), rounded to the nearest integer minor unit.
  return Math.round((usdMinor * rateE6) / RATE_SCALE);
}

/** One currency's live rate, as `GET /api/currencies` returns it. */
export const CurrencyRateView = z.object({
  code: DisplayCurrency,
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(4),
  /** Rate × 1,000,000 vs USD. USD is exactly `RATE_SCALE`. */
  rateE6: z.number().int().positive(),
  /** When the worker last refreshed this rate. */
  refreshedAt: Timestamp,
  /** Whether this is one of the five pinned to the top of the settings list. */
  top: z.boolean(),
});
export type CurrencyRateView = z.infer<typeof CurrencyRateView>;

/** `GET /api/currencies` — the supported currencies and their current rates. */
export const CurrenciesResponse = z.object({
  currencies: z.array(CurrencyRateView),
  /** The pinned five, in order, so the client need not re-derive it. */
  top: z.array(DisplayCurrency),
});
export type CurrenciesResponse = z.infer<typeof CurrenciesResponse>;

/** `PUT /api/me/currency` — choose a display currency. */
export const SetCurrencyRequest = z
  .object({
    currency: DisplayCurrency,
  })
  .strict();
export type SetCurrencyRequest = z.infer<typeof SetCurrencyRequest>;

/** `PUT /api/me/currency` result — the currency now in force. */
export const SetCurrencyResponse = z.object({
  currency: DisplayCurrency,
});
export type SetCurrencyResponse = z.infer<typeof SetCurrencyResponse>;
