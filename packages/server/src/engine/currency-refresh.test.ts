import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RATE_SCALE } from '@tailfin/shared';

import { FX_SOURCE_HOST, type FxRateSource } from '../currency/fx-source';
import { seedCurrencyRates } from '../currency/rates';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { currencyRate } from '../db/schema';

import { refreshFxRates } from './currency-refresh';

/**
 * The nightly display-currency refresh (M8-02).
 *
 * A worker job on the real clock. The source is a stub, so nothing touches the
 * network and the daily gate is driven by an injected `now`. `currency_rate` is a
 * global singleton table, so `beforeEach` resets every row to a `seed` row with
 * an old timestamp — that clears any live rate a prior run left behind, so the
 * gate starts open and the tests are deterministic regardless of order. Requires
 * `DATABASE_URL`; CI has it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [engine/currency-refresh.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/** A source returning a handful of rates per USD. */
const STUB: FxRateSource = () => Promise.resolve({ EUR: 0.9, GBP: 0.8, JPY: 150, USD: 1, XYZ: 42 });

describeDb('refreshFxRates', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = createDatabase();
    await seedCurrencyRates(db.db);
  });

  beforeEach(async () => {
    // Reset the gate: every row a `seed` row, old, so `max(refreshed_at where
    // source != 'seed')` is null and the next refresh runs. Leaves `rate_e6`
    // alone, which is all the assertions below read.
    await db.db
      .update(currencyRate)
      .set({ source: 'seed', refreshedAt: new Date('2000-01-01T00:00:00.000Z') });
  });

  afterAll(async () => {
    await db.close();
  });

  async function rateOf(code: string): Promise<{ rateE6: number; source: string } | undefined> {
    const [row] = await db.db
      .select({ rateE6: currencyRate.rateE6, source: currencyRate.source })
      .from(currencyRate)
      .where(eq(currencyRate.code, code));
    return row;
  }

  it('updates supported rates from the source and pins USD to the scale', async () => {
    const result = await refreshFxRates(db.db, STUB, new Date('2024-01-01T00:00:00.000Z'));
    expect(result.refreshed).toBe(true);

    expect(await rateOf('EUR')).toMatchObject({ rateE6: 900_000, source: FX_SOURCE_HOST });
    expect(await rateOf('GBP')).toMatchObject({ rateE6: 800_000, source: FX_SOURCE_HOST });
    expect(await rateOf('JPY')).toMatchObject({ rateE6: 150_000_000, source: FX_SOURCE_HOST });
    // USD is pinned regardless of what the source claims about it.
    expect((await rateOf('USD'))?.rateE6).toBe(RATE_SCALE);
    // A code we do not support is ignored, not inserted.
    expect(await rateOf('XYZ')).toBeUndefined();
  });

  it('does not refresh again within a day of the last live refresh', async () => {
    const base = new Date('2024-06-01T00:00:00.000Z');
    const first = await refreshFxRates(db.db, STUB, base);
    expect(first.refreshed).toBe(true);

    const hourLater = new Date(base.getTime() + 60 * 60 * 1000);
    const second = await refreshFxRates(db.db, STUB, hourLater);
    expect(second).toEqual({ refreshed: false, reason: 'fresh' });

    // A day and change later, it refreshes again.
    const dayLater = new Date(base.getTime() + 25 * 60 * 60 * 1000);
    const third = await refreshFxRates(db.db, STUB, dayLater);
    expect(third.refreshed).toBe(true);
  });

  it('propagates a source failure and leaves the last good rates in place', async () => {
    // Seed a known live rate first, then fail a refresh and prove it is untouched.
    await refreshFxRates(db.db, STUB, new Date('2024-01-01T00:00:00.000Z'));
    const before = (await rateOf('EUR'))?.rateE6;
    expect(before).toBe(900_000);

    // Reset the gate so the throwing source is actually reached this call.
    await db.db
      .update(currencyRate)
      .set({ source: 'seed', refreshedAt: new Date('2000-01-01T00:00:00.000Z') });
    const throwing: FxRateSource = () => Promise.reject(new Error('source down'));
    await expect(
      refreshFxRates(db.db, throwing, new Date('2024-02-01T00:00:00.000Z')),
    ).rejects.toThrow('source down');

    expect((await rateOf('EUR'))?.rateE6).toBe(before);
  });
});
