import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Database } from './db/client';
import { clearLandingStatsCache, readLandingStats } from './landing-stats';

/**
 * The landing page's figures: caching, and failing without taking the page down
 * (LANDING-09).
 *
 * A fake database rather than a real one, because what is worth protecting here
 * is not the SQL — `app.test.ts` runs that against Postgres in CI — but the
 * behaviour around it: how often it is asked, what happens when it refuses, and
 * whether a cold cache under load makes one query or a hundred. None of that
 * needs a database, and all of it should be checked on every machine.
 */

function fakeDb(rows: unknown[] | Error, onQuery = () => undefined as void): Database {
  return {
    execute: () => {
      onQuery();
      // A rejected promise rather than a synchronous throw: that is how a real
      // driver fails, and `readLandingStats` has to catch it the same way.
      if (rows instanceof Error) return Promise.reject(rows);
      return Promise.resolve({ rows });
    },
  } as unknown as Database;
}

afterEach(() => {
  clearLandingStatsCache();
  vi.restoreAllMocks();
});

describe('reading the figures', () => {
  it('returns the two counts', async () => {
    const db = fakeDb([{ airlines: 1247, aircraft_types: 18 }]);
    await expect(readLandingStats(db)).resolves.toEqual({ airlines: 1247, aircraftTypes: 18 });
  });

  it('asks the database once per window, however many visitors arrive', async () => {
    /*
     * LANDING-09's sharpest operational line: *"a landing page must never make a
     * database do work per visitor."* The front door is the most-hit URL in the
     * product and production is two vCPUs shared with Postgres.
     */
    let queries = 0;
    const db = fakeDb([{ airlines: 5, aircraft_types: 18 }], () => {
      queries += 1;
    });

    const start = Date.now();
    for (let i = 0; i < 50; i += 1) await readLandingStats(db, start + i);
    expect(queries).toBe(1);

    // ...and it does refresh once the window has passed, rather than caching for
    // the lifetime of the process.
    await readLandingStats(db, start + 5 * 60 * 1000 + 1);
    expect(queries).toBe(2);
  });

  it('makes one query when a cold cache is hit concurrently', async () => {
    /*
     * The cold moment is a deploy, and a deploy is exactly when traffic arrives
     * all at once — so the in-flight promise is shared rather than each request
     * starting its own count.
     */
    let queries = 0;
    const db = fakeDb([{ airlines: 5, aircraft_types: 18 }], () => {
      queries += 1;
    });

    await Promise.all(Array.from({ length: 20 }, async () => readLandingStats(db)));
    expect(queries).toBe(1);
  });
});

describe('when the database will not answer', () => {
  it('reports unknown rather than throwing', async () => {
    /*
     * The page must render. A front door that 500s because a count failed is a
     * worse page than one with two em-dashes, and LANDING-09 requires the
     * strip's failure to be invisible.
     */
    const db = fakeDb(new Error('connection refused'));
    await expect(readLandingStats(db)).resolves.toEqual({ airlines: null, aircraftTypes: null });
  });

  it('never reports zero for a count it could not take', async () => {
    // `null` and `0` are different claims. Zero would be a fabricated statistic
    // reached by a more technical route than typing one.
    const db = fakeDb(new Error('connection refused'));
    const stats = await readLandingStats(db);
    expect(stats.airlines).toBeNull();
    expect(stats.aircraftTypes).toBeNull();
  });

  it('keeps serving the last good figures', async () => {
    // Stale is better than blank: the numbers were true five minutes ago and
    // neither of them moves quickly.
    const start = Date.now();
    await readLandingStats(fakeDb([{ airlines: 42, aircraft_types: 18 }]), start);

    const later = start + 5 * 60 * 1000 + 1;
    await expect(readLandingStats(fakeDb(new Error('down')), later)).resolves.toEqual({
      airlines: 42,
      aircraftTypes: 18,
    });
  });

  it('reports unknown when the query answers with no row at all', async () => {
    const db = fakeDb([]);
    await expect(readLandingStats(db)).resolves.toEqual({ airlines: null, aircraftTypes: null });
  });
});
