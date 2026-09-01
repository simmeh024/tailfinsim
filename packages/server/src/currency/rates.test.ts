import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_CURRENCY,
  RATE_SCALE,
  SUPPORTED_CURRENCIES,
  TOP_CURRENCIES,
} from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { currencyRate, player } from '../db/schema';

import {
  baselineRateE6,
  listCurrencies,
  readPlayerCurrency,
  seedCurrencyRates,
  setPlayerCurrency,
} from './rates';

/**
 * Display-currency store (M8-02).
 *
 * Seeding, the currency list, and a player's own preference. All display-only:
 * no money value is read or written here. Requires `DATABASE_URL`; CI has it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [currency/rates.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('currency rates', () => {
  let db: DatabaseHandle;
  const madePlayers: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    // The web startup seeds these; the test guarantees the rows exist regardless
    // of order, since seeding is insert-if-absent.
    await seedCurrencyRates(db.db);
  });

  afterEach(async () => {
    if (madePlayers.length > 0) {
      await db.db.delete(player).where(inArray(player.id, madePlayers.splice(0)));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makePlayer(displayCurrency?: string): Promise<string> {
    const [row] = await db.db
      .insert(player)
      .values({
        displayName: `Currency Tester ${Math.random().toString(36).slice(2, 6)}`,
        displayCurrency,
      })
      .returning({ id: player.id });
    if (!row) throw new Error('no player');
    madePlayers.push(row.id);
    return row.id;
  }

  it('seeds a rate for every supported currency, idempotently', async () => {
    const again = await seedCurrencyRates(db.db);
    // A second seed inserts nothing — the rows are already there.
    expect(again.inserted).toBe(0);
    expect(again.existing).toBe(SUPPORTED_CURRENCIES.length);

    const rows = await db.db.select({ code: currencyRate.code }).from(currencyRate);
    const codes = new Set(rows.map((r) => r.code));
    for (const meta of SUPPORTED_CURRENCIES) {
      expect(codes.has(meta.code), `${meta.code} seeded`).toBe(true);
    }
  });

  it('pins USD to exactly the rate scale', async () => {
    const [usd] = await db.db
      .select({ rateE6: currencyRate.rateE6 })
      .from(currencyRate)
      .where(eq(currencyRate.code, 'USD'));
    expect(usd?.rateE6).toBe(RATE_SCALE);
    expect(baselineRateE6('USD')).toBe(RATE_SCALE);
  });

  it('lists every supported currency with metadata and the pinned five flagged', async () => {
    const response = await listCurrencies(db.db);
    expect(response.currencies).toHaveLength(SUPPORTED_CURRENCIES.length);
    expect(response.top).toEqual([...TOP_CURRENCIES]);

    const usd = response.currencies.find((c) => c.code === 'USD');
    expect(usd).toMatchObject({ symbol: '$', decimals: 2, rateE6: RATE_SCALE, top: true });

    const flaggedTop = response.currencies.filter((c) => c.top).map((c) => c.code);
    expect(new Set(flaggedTop)).toEqual(new Set(TOP_CURRENCIES));

    const jpy = response.currencies.find((c) => c.code === 'JPY');
    expect(jpy?.decimals).toBe(0);
  });

  it('defaults a player with no stored currency to USD', async () => {
    const id = await makePlayer();
    expect(await readPlayerCurrency(db.db, id)).toBe(DEFAULT_CURRENCY);
  });

  it('sets and reads back a player’s chosen currency', async () => {
    const id = await makePlayer();
    expect(await setPlayerCurrency(db.db, id, 'EUR')).toBe(true);
    expect(await readPlayerCurrency(db.db, id)).toBe('EUR');
    // And can be changed again.
    expect(await setPlayerCurrency(db.db, id, 'JPY')).toBe(true);
    expect(await readPlayerCurrency(db.db, id)).toBe('JPY');
  });

  it('reports no change for a player that does not exist', async () => {
    const changed = await setPlayerCurrency(db.db, '00000000-0000-4000-8000-0000000000ff', 'GBP');
    expect(changed).toBe(false);
  });
});
