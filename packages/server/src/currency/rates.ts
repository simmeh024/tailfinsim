import { eq } from 'drizzle-orm';

import {
  type CurrenciesResponse,
  type CurrencyRateView,
  DEFAULT_CURRENCY,
  type DisplayCurrency,
  RATE_SCALE,
  SUPPORTED_CURRENCIES,
  TOP_CURRENCIES,
} from '@tailfin/shared';

import { currencyRate, player } from '../db/schema';

import type { Database } from '../db/client';

/**
 * Display-currency rates (M8-02).
 *
 * The store side of the currency feature: seed a baseline set of rates, read
 * them back for `GET /api/currencies`, and read/write a player's chosen display
 * currency. The nightly refresh that keeps the rates live lives in the worker
 * (`engine/currency-refresh.ts`); this module owns only the seed and the reads.
 *
 * All money stays USD minor units; a rate is a display ratio, carried as
 * `rateE6` (rate × 1,000,000 vs USD).
 */

/**
 * A recent snapshot of rates vs USD, shipped so a fresh database and any node
 * without a worker (production, until OPS-12) still show sensible numbers. The
 * worker overwrites these nightly; they are a floor, not the truth. Approximate
 * late-2024 values — precision is the live refresh's job, not the seed's.
 */
const BASELINE_RATES_PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149,
  AUD: 1.52,
  AED: 3.67,
  BRL: 5.1,
  CAD: 1.36,
  CHF: 0.88,
  CNY: 7.2,
  DKK: 6.85,
  HKD: 7.82,
  INR: 83,
  KRW: 1330,
  MXN: 17.1,
  NOK: 10.7,
  NZD: 1.64,
  SEK: 10.5,
  SGD: 1.35,
  ZAR: 18.5,
};

/** The seed rate for one code as an integer `rateE6`, USD pinned exactly. */
export function baselineRateE6(code: string): number {
  if (code === DEFAULT_CURRENCY) return RATE_SCALE;
  const rate = BASELINE_RATES_PER_USD[code];
  // Every supported currency has a baseline; a missing one is a programming
  // error, not a runtime condition, so fall back to parity rather than throw
  // during startup seeding.
  return rate ? Math.round(rate * RATE_SCALE) : RATE_SCALE;
}

export interface SeedRatesResult {
  inserted: number;
  existing: number;
}

/**
 * Insert a baseline rate for every supported currency that has none yet.
 *
 * Insert-if-absent, never update — like the economy and catalogue seeds — so a
 * deploy cannot revert a live rate the worker refreshed. Called at web startup.
 * The worker updates the rows afterwards; this only guarantees a row exists.
 */
export async function seedCurrencyRates(db: Database): Promise<SeedRatesResult> {
  const rows = SUPPORTED_CURRENCIES.map((c) => ({
    code: c.code,
    rateE6: baselineRateE6(c.code),
    source: 'seed',
  }));
  const inserted = await db
    .insert(currencyRate)
    .values(rows)
    .onConflictDoNothing()
    .returning({ code: currencyRate.code });
  return { inserted: inserted.length, existing: rows.length - inserted.length };
}

/** Every supported currency with its current rate, for `GET /api/currencies`. */
export async function listCurrencies(db: Database): Promise<CurrenciesResponse> {
  const rows = await db
    .select({
      code: currencyRate.code,
      rateE6: currencyRate.rateE6,
      refreshedAt: currencyRate.refreshedAt,
    })
    .from(currencyRate);
  const byCode = new Map(rows.map((r) => [r.code, r]));

  const top = new Set<string>(TOP_CURRENCIES);
  const currencies: CurrencyRateView[] = SUPPORTED_CURRENCIES.map((meta) => {
    const row = byCode.get(meta.code);
    return {
      code: meta.code,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      // A supported currency with no row yet (a race with the seed) falls back to
      // its baseline rather than vanishing from the list.
      rateE6: row?.rateE6 ?? baselineRateE6(meta.code),
      refreshedAt: (row?.refreshedAt ?? new Date(0)).toISOString(),
      top: top.has(meta.code),
    };
  });

  return { currencies, top: [...TOP_CURRENCIES] };
}

/** A player's chosen display currency, resolving a null column to the default. */
export async function readPlayerCurrency(db: Database, playerId: string): Promise<DisplayCurrency> {
  const [row] = await db
    .select({ displayCurrency: player.displayCurrency })
    .from(player)
    .where(eq(player.id, playerId))
    .limit(1);
  return row?.displayCurrency ?? DEFAULT_CURRENCY;
}

/**
 * Set a player's display currency, owner-scoped by `playerId` (the session
 * player). The code is a validated `DisplayCurrency`, so the column only ever
 * holds a supported value. Returns false when no such player row exists.
 */
export async function setPlayerCurrency(
  db: Database,
  playerId: string,
  currency: DisplayCurrency,
): Promise<boolean> {
  const updated = await db
    .update(player)
    .set({ displayCurrency: currency })
    .where(eq(player.id, playerId))
    .returning({ id: player.id });
  return updated.length > 0;
}
