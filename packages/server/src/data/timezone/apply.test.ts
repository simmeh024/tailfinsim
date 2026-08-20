import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../../db/client';
import { airport } from '../../db/schema';

import { applyTimezones, formatTimezoneResult } from './apply';

import type { GeoNamesCity } from '../catchment/sources';

/**
 * Writing resolved timezones back (M3-04a).
 *
 * Against a real Postgres, deliberately. The update is a `VALUES` join with
 * explicit casts, and `CLAUDE.md` records what happens to drizzle constructs
 * that typecheck and then behave differently on the real thing — a correlated
 * subquery in a select list came back empty and was never diagnosed. A bulk
 * update is the same class of construct, so asserting it against the real
 * server is the only way to know it works.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [apply.test] DATABASE_URL not set — skipping timezone write tests.\n');
const describeDb = url ? describe : describe.skip;

/** Source ids well outside the OurAirports range, so nothing real collides. */
const SOURCE_BASE = 990_000_100;

function city(
  over: Partial<GeoNamesCity> & Pick<GeoNamesCity, 'latitude' | 'longitude'>,
): GeoNamesCity {
  return {
    geonameId: 1,
    name: 'Testville',
    countryCode: 'NL',
    population: 100_000,
    featureCode: 'PPL',
    timezone: 'Europe/Amsterdam',
    ...over,
  };
}

describeDb('applyTimezones', () => {
  let db: DatabaseHandle;
  const created: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    if (created.length > 0) {
      await db.db.delete(airport).where(inArray(airport.id, created));
      created.length = 0;
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function insertAirport(over: {
    ident: string;
    latitude: number;
    longitude: number;
    isoCountry: string;
    sourceId: number;
  }): Promise<string> {
    const [row] = await db.db
      .insert(airport)
      .values({
        sourceId: over.sourceId,
        ident: over.ident,
        name: `${over.ident} test field`,
        isoCountry: over.isoCountry,
        kind: 'large_airport',
        latitude: over.latitude,
        longitude: over.longitude,
        scheduledService: true,
        hasRunwayData: false,
      })
      .returning({ id: airport.id });

    if (!row) throw new Error('insert returned nothing');
    created.push(row.id);
    return row.id;
  }

  it('writes the timezone, the offset and the basis', async () => {
    const id = await insertAirport({
      ident: 'ZZT1',
      latitude: 52.3086,
      longitude: 4.7639,
      isoCountry: 'NL',
      sourceId: SOURCE_BASE + 1,
    });

    await applyTimezones(db.db, [city({ latitude: 52.374, longitude: 4.89 })]);

    const [stored] = await db.db
      .select({
        timezone: airport.timezone,
        offset: airport.utcOffsetMinutes,
        basis: airport.timezoneBasis,
      })
      .from(airport)
      .where(eq(airport.id, id));

    expect(stored?.timezone).toBe('Europe/Amsterdam');
    expect(stored?.offset).toBe(60);
    expect(stored?.basis).toBe('nearest-city');
  });

  it('stores a negative offset as a negative number', async () => {
    // The cast is `::integer`; a negative that arrived as text would either
    // fail loudly or come back wrong, and both are worth knowing about.
    const id = await insertAirport({
      ident: 'ZZT2',
      latitude: 39.8617,
      longitude: -104.6731,
      isoCountry: 'US',
      sourceId: SOURCE_BASE + 2,
    });

    await applyTimezones(db.db, [
      city({ latitude: 39.74, longitude: -104.98, countryCode: 'US', timezone: 'America/Denver' }),
    ]);

    const [stored] = await db.db
      .select({ offset: airport.utcOffsetMinutes })
      .from(airport)
      .where(eq(airport.id, id));

    expect(stored?.offset).toBe(-420);
  });

  it('stores a null timezone when it fell through to longitude', async () => {
    const id = await insertAirport({
      ident: 'ZZT3',
      latitude: -75,
      longitude: 30,
      isoCountry: 'ZZ',
      sourceId: SOURCE_BASE + 3,
    });

    await applyTimezones(db.db, []);

    const [stored] = await db.db
      .select({
        timezone: airport.timezone,
        offset: airport.utcOffsetMinutes,
        basis: airport.timezoneBasis,
      })
      .from(airport)
      .where(eq(airport.id, id));

    expect(stored?.timezone).toBeNull();
    expect(stored?.basis).toBe('longitude');
    expect(stored?.offset).toBe(120);
  });

  it('is re-runnable and updates in place', async () => {
    // M1-03's standing requirement for every derivation here: running it twice
    // must not double anything or leave a stale value behind.
    const id = await insertAirport({
      ident: 'ZZT4',
      latitude: 52.3086,
      longitude: 4.7639,
      isoCountry: 'NL',
      sourceId: SOURCE_BASE + 4,
    });

    await applyTimezones(db.db, [city({ latitude: 52.374, longitude: 4.89 })]);
    await applyTimezones(db.db, [
      city({ latitude: 52.374, longitude: 4.89, timezone: 'Europe/Lisbon' }),
    ]);

    const [stored] = await db.db
      .select({ timezone: airport.timezone, offset: airport.utcOffsetMinutes })
      .from(airport)
      .where(eq(airport.id, id));

    expect(stored?.timezone).toBe('Europe/Lisbon');
    expect(stored?.offset).toBe(0);
  });

  it('covers every airport in one run, across batch boundaries', async () => {
    // The batching is invisible in a small fixture and is exactly where an
    // off-by-one hides, so this asserts the count the run reports against the
    // count actually carrying a basis.
    const before = await db.db.select({ n: sql<number>`count(*)::int` }).from(airport);
    const total = before[0]?.n ?? 0;

    await insertAirport({
      ident: 'ZZT5',
      latitude: 52.3086,
      longitude: 4.7639,
      isoCountry: 'NL',
      sourceId: SOURCE_BASE + 5,
    });

    const result = await applyTimezones(db.db, [city({ latitude: 52.374, longitude: 4.89 })]);

    expect(result.updated).toBe(total + 1);
    expect(result.total).toBe(total + 1);

    const [withBasis] = await db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(airport)
      .where(sql`${airport.timezoneBasis} is not null`);

    expect(withBasis?.n).toBe(total + 1);
  });
});

describe('formatTimezoneResult', () => {
  it('reports the share resolved by each route', () => {
    const text = formatTimezoneResult({
      total: 4,
      byBasis: { 'nearest-city': 3, country: 1, longitude: 0 },
      furthestCityKm: 187.4,
      updated: 4,
    });

    expect(text).toContain('4 airports given a timezone');
    expect(text).toContain('75.0%');
    expect(text).toContain('187.4 km');
  });

  it('does not divide by zero on an empty run', () => {
    const text = formatTimezoneResult({
      total: 0,
      byBasis: { 'nearest-city': 0, country: 0, longitude: 0 },
      furthestCityKm: 0,
      updated: 0,
    });

    expect(text).toContain('0%');
    expect(text).not.toContain('NaN');
  });
});
