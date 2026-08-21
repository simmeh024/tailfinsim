import { and, eq, isNotNull } from 'drizzle-orm';

import {
  type DemandEndpoint,
  demandPool as sizePool,
  type GravityConfig,
  haversineNm,
  isViablePair,
  type SegmentConfig,
} from '@tailfin/sim';

import { airport, demandPool, world } from '../db/schema';
import { loadEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * Generating a world's demand pools (M3-01, App. A.2).
 *
 * A.2's step one, run once when a world is created: every viable city pair
 * sized, split into segments, and written. M3-02 modulates it live afterwards
 * and nothing recomputes it.
 *
 * ## A one-off job, not part of `createWorld`
 *
 * With ~4,400 scheduled-service airports there are 9.7 million unordered pairs.
 * Sizing them is fast — measured at 0.42 µs a pair, so about 4 seconds — but
 * *writing* the survivors is not, and a world creation that blocks for minutes
 * while it inserts a million rows is a world creation that times out.
 *
 * So this follows the pattern every other bulk job here uses: a CLI run
 * deliberately, like `data:airports` and `world:seed`. That also makes it
 * re-runnable, which matters because the coefficients are balance numbers and
 * retuning them means regenerating.
 *
 * ## Why it reads catchment rather than being given it
 *
 * The four numbers A.2 multiplies are M1-03's, already on the airport row and
 * already normalised to a world median of 1.0. An airport without them has no
 * scheduled service and therefore no demand pool to size — the same rule the
 * column itself uses, so the filter here is `is not null` rather than a
 * judgement this file makes.
 */

export interface GenerateOptions {
  gravity?: GravityConfig;
  segments?: SegmentConfig;
  /** Pools below this many passengers a day are not stored. */
  minimumDailyPassengers?: number;
  /**
   * Rows per insert.
   *
   * Postgres binds one parameter per column per row, and the limit is 65,535 —
   * at eleven columns that is 5,957 rows, so 2,000 leaves room and keeps each
   * statement small enough that a failure does not lose much work.
   */
  batchSize?: number;
  log?: (line: string) => void;
}

export interface GenerateResult {
  /** Airports with catchment data, and therefore a demand pool to be part of. */
  airports: number;
  /** Unordered pairs considered. */
  pairsConsidered: number;
  /** Pairs big enough to store. */
  poolsWritten: number;
  /** Wall-clock milliseconds, for comparing against M3-01's five-minute budget. */
  elapsedMs: number;
}

interface CatchmentAirport extends DemandEndpoint {
  latitude: number;
  longitude: number;
}

/**
 * Every airport that can be one end of a market.
 *
 * `wealth_index` is the discriminator rather than `scheduled_service`, because
 * the catchment columns are what A.2 actually consumes and M1-03 fills them only
 * where there is service. Reading the thing that is needed, rather than a proxy
 * for it, means an airport with service but no derived catchment is correctly
 * skipped instead of producing a pool from nulls.
 */
async function loadAirports(db: Database): Promise<CatchmentAirport[]> {
  const rows = await db
    .select({
      icaoCode: airport.icaoCode,
      latitude: airport.latitude,
      longitude: airport.longitude,
      isoCountry: airport.isoCountry,
      population: airport.catchmentPopulation,
      wealthIndex: airport.wealthIndex,
      tourismIndex: airport.tourismIndex,
      businessIndex: airport.businessIndex,
    })
    .from(airport)
    .where(
      and(
        isNotNull(airport.icaoCode),
        isNotNull(airport.catchmentPopulation),
        isNotNull(airport.wealthIndex),
        isNotNull(airport.tourismIndex),
        isNotNull(airport.businessIndex),
      ),
    );

  const airports: CatchmentAirport[] = [];
  for (const row of rows) {
    if (row.icaoCode === null || row.population === null) continue;
    // `numeric` comes back from the driver as a string. CLAUDE.md records this
    // as a trap already met — normalise at the boundary rather than trusting the
    // declared type, which is an assertion and not a conversion.
    const wealthIndex = Number(row.wealthIndex);
    const tourismIndex = Number(row.tourismIndex);
    const businessIndex = Number(row.businessIndex);
    if (!Number.isFinite(wealthIndex) || wealthIndex <= 0) continue;
    if (!Number.isFinite(tourismIndex) || tourismIndex <= 0) continue;
    if (!Number.isFinite(businessIndex) || businessIndex <= 0) continue;

    airports.push({
      icaoCode: row.icaoCode,
      latitude: row.latitude,
      longitude: row.longitude,
      isoCountry: row.isoCountry,
      population: row.population,
      wealthIndex,
      tourismIndex,
      businessIndex,
    });
  }

  // Sorted so the canonical `origin < destination` ordering falls out of the
  // loop rather than needing a comparison per pair, and so a re-run writes the
  // same rows in the same order.
  airports.sort((a, b) => (a.icaoCode < b.icaoCode ? -1 : 1));
  return airports;
}

/**
 * Size and store every viable pool for a world.
 *
 * Idempotent by way of the unique constraint on `(world_id, origin, destination)`
 * — a second run over the same world writes nothing new rather than doubling
 * every market. That is deliberate: regenerating after a coefficient change
 * should be `delete` then `generate`, so that changing `k` cannot leave a world
 * holding a mixture of two economies.
 */
export async function generateDemandPools(
  db: Database,
  worldId: string,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const batchSize = options.batchSize ?? 2_000;
  const log = options.log ?? (() => undefined);

  const worlds = await db
    .select({ id: world.id, economyConfigVersion: world.economyConfigVersion })
    .from(world)
    .where(eq(world.id, worldId));
  const target = worlds[0];
  if (!target) throw new Error(`No world ${worldId}`);

  // The world's own coefficients, through its pin (M3-11). This is the one
  // economy read that is not live: pools are sized once and stored, so moving a
  // world to a version with a different `k` does not resize what already exists
  // — re-running this job is what does, which is why it is a job at all.
  const economy = await loadEconomyConfig(db, target.economyConfigVersion);
  const gravity = options.gravity ?? economy.demand.gravity;
  const segments = options.segments ?? economy.demand.segments;
  const minimum = options.minimumDailyPassengers ?? economy.demand.viableDailyPassengers;
  log(`  economy ${economy.version}: k=${String(gravity.k)}, alpha=${String(gravity.alpha)}`);

  const started = Date.now();
  const airports = await loadAirports(db);
  log(`  ${String(airports.length)} airports with catchment data`);

  let pairsConsidered = 0;
  let poolsWritten = 0;
  let batch: (typeof demandPool.$inferInsert)[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await db.insert(demandPool).values(batch).onConflictDoNothing();
    poolsWritten += batch.length;
    batch = [];
  };

  for (let i = 0; i < airports.length; i += 1) {
    const origin = airports[i];
    if (!origin) continue;

    for (let j = i + 1; j < airports.length; j += 1) {
      const destination = airports[j];
      if (!destination) continue;

      pairsConsidered += 1;
      const distanceNm = haversineNm(
        origin.latitude,
        origin.longitude,
        destination.latitude,
        destination.longitude,
      );
      // A pair at zero distance is the same airport twice under two codes, and a
      // distance of zero fails the table's own check.
      if (distanceNm < 1) continue;

      const pool = sizePool(origin, destination, distanceNm, { gravity, segments });
      if (!isViablePair(pool, minimum)) continue;

      batch.push({
        worldId,
        originIcao: pool.originIcao,
        destinationIcao: pool.destinationIcao,
        distanceNm: Math.round(distanceNm),
        dailyPassengers: pool.dailyPassengers.toFixed(2),
        businessShare: pool.segments.business.toFixed(4),
        leisureShare: pool.segments.leisure.toFixed(4),
        vfrShare: pool.segments.vfr.toFixed(4),
        basis: JSON.stringify(pool.basis),
        // The world's economy version, so a pool stays explicable after the
        // gravity coefficients move (invariant 4).
        gravityVersion: economy.version,
      });

      if (batch.length >= batchSize) {
        await flush();
        if (poolsWritten % 100_000 === 0) {
          log(`  ${poolsWritten.toLocaleString()} pools written`);
        }
      }
    }
  }

  await flush();

  return {
    airports: airports.length,
    pairsConsidered,
    poolsWritten,
    elapsedMs: Date.now() - started,
  };
}

/** Remove a world's pools, so a coefficient change can be regenerated cleanly. */
export async function clearDemandPools(db: Database, worldId: string): Promise<number> {
  const removed = await db
    .delete(demandPool)
    .where(eq(demandPool.worldId, worldId))
    .returning({ id: demandPool.id });
  return removed.length;
}
