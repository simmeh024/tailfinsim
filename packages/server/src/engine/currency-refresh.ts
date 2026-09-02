import { ne, sql } from 'drizzle-orm';

import { RATE_SCALE, SUPPORTED_CURRENCIES } from '@tailfin/shared';

import { activeFxHost, type FxRateSource } from '../currency/fx-source';
import { currencyRate } from '../db/schema';

import type { Database } from '../db/client';

/**
 * Keep display currencies in sync with the real world (M8-02).
 *
 * A worker job, global (not per-world) and on the **real** clock — an FX rate is
 * a real-world quantity, so unlike almost everything else in the engine it is not
 * measured in game time. It runs at most once per real day: a `seed` row is never
 * treated as a live refresh, so the first worker tick after a fresh seed updates
 * immediately, and thereafter the gate holds until a day has passed.
 *
 * No money moves. `rate_e6` is a display ratio (rate × 1,000,000 vs USD); the
 * conversion itself happens only at the client's render boundary.
 *
 * The refresh does not swallow its own failures — a throwing source or an
 * unreachable database propagates, and the caller in `simulation.ts` counts it
 * as `fxRefreshErrors` and moves on, leaving the last good rates in place.
 */

/** Refresh at most this often, measured against the newest live (non-seed) rate. */
export const FX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Don't even *attempt* a refresh more than once an hour of real time. The daily
 * gate above bounds successful refreshes; this bounds calls to the external
 * source when it is failing, so an outage cannot make the worker hit it every
 * tick. Held in memory by the engine, not the database.
 */
export const FX_ATTEMPT_INTERVAL_MS = 60 * 60 * 1000;

export type RefreshFxResult =
  { refreshed: false; reason: 'fresh' } | { refreshed: true; updated: number };

/**
 * Refresh the `currency_rate` table from `source`, if a day has passed since the
 * last live refresh. `now` is injected so the daily gate is testable.
 */
export async function refreshFxRates(
  db: Database,
  source: FxRateSource,
  now: Date = new Date(),
): Promise<RefreshFxResult> {
  // The newest live rate. Seed rows do not count, so a freshly seeded database
  // refreshes on the first tick rather than waiting a day.
  const [gate] = await db
    .select({ newest: sql<Date | null>`max(${currencyRate.refreshedAt})` })
    .from(currencyRate)
    .where(ne(currencyRate.source, 'seed'));
  const newest = gate?.newest ?? null;
  if (newest !== null && now.getTime() - new Date(newest).getTime() < FX_REFRESH_INTERVAL_MS) {
    return { refreshed: false, reason: 'fresh' };
  }

  const rates = await source();

  // Only currencies we support, and USD pinned exactly regardless of what the
  // source says about it. A source that omits a currency leaves its last rate
  // untouched rather than dropping it.
  const host = activeFxHost();
  let updated = 0;
  for (const meta of SUPPORTED_CURRENCIES) {
    const perUsd = meta.code === 'USD' ? 1 : rates[meta.code];
    if (typeof perUsd !== 'number' || !Number.isFinite(perUsd) || perUsd <= 0) continue;
    const rateE6 = meta.code === 'USD' ? RATE_SCALE : Math.round(perUsd * RATE_SCALE);
    await db
      .update(currencyRate)
      .set({ rateE6, source: host, refreshedAt: now })
      .where(sql`${currencyRate.code} = ${meta.code}`);
    updated += 1;
  }
  return { refreshed: true, updated };
}
