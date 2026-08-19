import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG, type WorldConfig } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, demandPool, world } from '../db/schema';
import { createWorld } from '../world/lifecycle';

import { clearDemandPools, generateDemandPools } from './generate';

/**
 * Generating a world's demand pools, against a real Postgres (M3-01).
 *
 * The gravity model is proven in `@tailfin/sim` and is not retested here. What
 * is here is the half only a database can settle:
 *
 *   - **A market is stored once, not twice.** The canonical ordering is a check
 *     constraint, so the application cannot write both directions.
 *   - **The shares add up in the row**, not merely in the model — this row is
 *     what every commercial decision reads.
 *   - Airports without catchment data are skipped rather than sized from nulls.
 *   - Re-running writes nothing new.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [demand/generate.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function code(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'A';
  }
  return out;
}

describeDb('generating demand pools', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(world).where(eq(world.id, id));
    }
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  interface Place {
    latitude: number;
    longitude: number;
    population?: number | null;
    wealth?: number | null;
    tourism?: number | null;
    business?: number | null;
    country?: string;
  }

  async function makeAirport(place: Place): Promise<string> {
    const icao = code();
    await db.db.insert(airport).values({
      sourceId: Math.floor(Math.random() * 2_000_000_000),
      ident: `TEST-${icao}-${Math.random().toString(36).slice(2, 8)}`,
      icaoCode: icao,
      name: `Test Field ${icao}`,
      isoCountry: place.country ?? 'NL',
      kind: 'large_airport',
      latitude: place.latitude,
      longitude: place.longitude,
      scheduledService: true,
      hasRunwayData: false,
      catchmentPopulation: place.population === undefined ? 2_000_000 : place.population,
      wealthIndex: place.wealth === undefined ? '1.5000' : place.wealth?.toFixed(4),
      tourismIndex: place.tourism === undefined ? '1.2000' : place.tourism?.toFixed(4),
      businessIndex: place.business === undefined ? '1.6000' : place.business?.toFixed(4),
    });
    madeAirports.push(icao);
    return icao;
  }

  async function makeWorld(): Promise<string> {
    const config: WorldConfig = {
      ...FLAGSHIP_CONFIG,
      name: `demand-${Math.random().toString(36).slice(2, 10)}`,
    };
    const { world: created } = await createWorld(db.db, config);
    madeWorlds.push(created.id);
    return created.id;
  }

  /** Amsterdam, London and Palma — far enough apart to be real markets. */
  async function threeCities(): Promise<string[]> {
    return [
      await makeAirport({ latitude: 52.3086, longitude: 4.76389 }),
      await makeAirport({ latitude: 51.4706, longitude: -0.461941, country: 'GB' }),
      await makeAirport({ latitude: 39.5517, longitude: 2.7388, country: 'ES', tourism: 3.8 }),
    ];
  }

  it('writes one row per pair, not one per direction', async () => {
    // Three airports is three unordered pairs. Six would mean the market has a
    // direction, which it does not.
    const worldId = await makeWorld();
    await threeCities();

    const result = await generateDemandPools(db.db, worldId);

    expect(result.airports).toBe(3);
    expect(result.pairsConsidered).toBe(3);
    expect(result.poolsWritten).toBe(3);

    const rows = await db.db.select().from(demandPool).where(eq(demandPool.worldId, worldId));
    expect(rows).toHaveLength(3);
  });

  it('stores the pair in canonical order, enforced by the database', async () => {
    const worldId = await makeWorld();
    await threeCities();
    await generateDemandPools(db.db, worldId);

    const rows = await db.db.select().from(demandPool).where(eq(demandPool.worldId, worldId));
    for (const row of rows) {
      expect(row.originIcao < row.destinationIcao).toBe(true);
    }

    // And the constraint refuses the other ordering outright, so no future
    // caller can write both.
    const [first] = rows;
    if (!first) throw new Error('no pools');
    await expect(
      db.db.insert(demandPool).values({
        worldId,
        originIcao: first.destinationIcao,
        destinationIcao: first.originIcao,
        distanceNm: 200,
        dailyPassengers: '100.00',
        businessShare: '0.3000',
        leisureShare: '0.5000',
        vfrShare: '0.2000',
        basis: '{}',
        gravityVersion: 'v1',
      }),
    ).rejects.toThrow();
  });

  it('stores shares that add to one, and a basis that explains the number', async () => {
    const worldId = await makeWorld();
    await threeCities();
    await generateDemandPools(db.db, worldId);

    const rows = await db.db.select().from(demandPool).where(eq(demandPool.worldId, worldId));
    for (const row of rows) {
      // `numeric` arrives as a string from the driver — normalise at the
      // boundary rather than trusting the declared type.
      const total = Number(row.businessShare) + Number(row.leisureShare) + Number(row.vfrShare);
      expect(total).toBeCloseTo(1, 3);
      expect(Number(row.dailyPassengers)).toBeGreaterThan(0);

      const basis = JSON.parse(row.basis) as { massTerm: number; affinity: { value: number } };
      expect(basis.massTerm).toBeGreaterThan(0);
      expect(basis.affinity.value).toBeGreaterThanOrEqual(1);
      expect(row.gravityVersion).toBe('v1');
    }
  });

  it('refuses shares that do not add up, whatever writes them', async () => {
    const worldId = await makeWorld();
    const [a, b] = await threeCities();

    let caught: unknown;
    try {
      await db.db.insert(demandPool).values({
        worldId,
        originIcao: a! < b! ? a! : b!,
        destinationIcao: a! < b! ? b! : a!,
        distanceNm: 200,
        dailyPassengers: '100.00',
        businessShare: '0.5000',
        leisureShare: '0.5000',
        vfrShare: '0.5000',
        basis: '{}',
        gravityVersion: 'v1',
      });
    } catch (error) {
      caught = error;
    }

    // Walk the cause chain: Drizzle's wrapper message matches any failure.
    const reported: string[] = [];
    let current: unknown = caught;
    while (current instanceof Error) {
      const name = (current as { constraint?: unknown }).constraint;
      if (typeof name === 'string') reported.push(name);
      current = current.cause;
    }
    expect(reported).toContain('demand_pool_shares_sum_to_one');
  });

  it('skips an airport with no catchment data rather than sizing it from nulls', async () => {
    // No scheduled service means no catchment, which means no demand pool — the
    // same rule the column itself uses.
    const worldId = await makeWorld();
    await threeCities();
    await makeAirport({
      latitude: 45,
      longitude: 5,
      population: null,
      wealth: null,
      tourism: null,
      business: null,
    });

    const result = await generateDemandPools(db.db, worldId);

    expect(result.airports).toBe(3);
    expect(result.poolsWritten).toBe(3);
  });

  it('drops a pair too small to be a market', async () => {
    const worldId = await makeWorld();
    await makeAirport({ latitude: 52.3086, longitude: 4.76389, population: 800 });
    await makeAirport({ latitude: 39.5517, longitude: 2.7388, population: 800, country: 'ES' });

    const result = await generateDemandPools(db.db, worldId);

    expect(result.pairsConsidered).toBe(1);
    expect(result.poolsWritten).toBe(0);
  });

  it('is a no-op on a second run, so a repeat cannot double a world’s markets', async () => {
    const worldId = await makeWorld();
    await threeCities();

    await generateDemandPools(db.db, worldId);
    const second = await generateDemandPools(db.db, worldId);

    const rows = await db.db.select().from(demandPool).where(eq(demandPool.worldId, worldId));
    expect(rows).toHaveLength(3);
    // It still *considered* them — the constraint is what refused the writes.
    expect(second.pairsConsidered).toBe(3);
  });

  it('clears a world’s pools so a retune can be regenerated cleanly', async () => {
    // Changing `k` and re-running without clearing would leave a world holding a
    // mixture of two economies.
    const worldId = await makeWorld();
    await threeCities();
    await generateDemandPools(db.db, worldId);

    expect(await clearDemandPools(db.db, worldId)).toBe(3);
    expect(
      await db.db.select().from(demandPool).where(eq(demandPool.worldId, worldId)),
    ).toHaveLength(0);
  });

  it('keeps two worlds’ pools apart', async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    await threeCities();

    await generateDemandPools(db.db, a);
    await generateDemandPools(db.db, b);

    expect(await db.db.select().from(demandPool).where(eq(demandPool.worldId, a))).toHaveLength(3);
    expect(await db.db.select().from(demandPool).where(eq(demandPool.worldId, b))).toHaveLength(3);
  });

  it('refuses a world that does not exist', async () => {
    await expect(generateDemandPools(db.db, crypto.randomUUID())).rejects.toThrow(/No world/);
  });
});
