import { and, desc, eq, or, sql } from 'drizzle-orm';

import { type DemandSegment } from '@tailfin/shared';
import { fareFloor, type MarketView, routeVariableCostPerSeatMinor } from '@tailfin/sim';

import { type Database } from '../db/client';
import { airline, demandPool, route } from '../db/schema';
import { type PinnedEconomyConfig } from '../economy/config';
import { REFERENCE_AIRFRAME, REFERENCE_FEES, REFERENCE_STATION } from '../network/economics';

/**
 * Turning a stored market into something an NPC can decide about (M3-12).
 *
 * The costing here is **the player's costing**. `routeVariableCostPerSeatMinor`
 * and `fareFloor` are the same functions the route editor calls to tell a player
 * their fare is too low, run against the same `REFERENCE_AIRFRAME` a player's
 * own economics are drawn against until M4 lands a real fleet.
 *
 * That equality is not a convenience — it is M3-12's fourth acceptance
 * criterion, *"NPCs never receive resources or modifiers unavailable to
 * players"*, made structural. There is no NPC cost table to drift out of step,
 * because there is no NPC cost table.
 */

/** One `demand_pool` row, plus what it costs to fly. */
export interface MarketCandidate extends MarketView {
  /** Airline ids already selling this pair. Players and NPCs alike. */
  operatorIds: readonly string[];
}

function parseNumeric(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * What flying one seat on this sector costs, and the floor that implies.
 *
 * Cached by rounded distance across a review, because a review looks at forty
 * candidate markets and the cost model runs a block-time and a fuel-burn
 * calculation each time. Distance is the only input that varies between two
 * markets here — the airframe, the fees and the station are all the same
 * reference values — so rounding to the nautical mile is lossless for this
 * purpose and turns forty computations into a handful.
 */
export function createCostModel(economy: PinnedEconomyConfig) {
  const cache = new Map<number, { variableCostPerSeatMinor: number; floorMinor: number }>();

  return (greatCircleNm: number): { variableCostPerSeatMinor: number; floorMinor: number } => {
    const key = Math.max(1, Math.round(greatCircleNm));
    const hit = cache.get(key);
    if (hit) return hit;

    const cost = routeVariableCostPerSeatMinor(
      {
        distanceNm: key,
        aircraft: REFERENCE_AIRFRAME,
        market: { basePricePerTonne: economy.fuel.basePricePerTonne },
        originStation: { ...REFERENCE_STATION, icao: 'REF' },
        originFees: REFERENCE_FEES,
        destinationFees: REFERENCE_FEES,
      },
      economy.costs.settlement,
    );
    const floor = fareFloor(cost, economy.pricing.fareFloorRatio);

    const value = {
      variableCostPerSeatMinor: cost.perSeatMinor,
      floorMinor: floor.floorMinor,
    };
    cache.set(key, value);
    return value;
  };
}

/**
 * The biggest markets in a world, with what each already costs and who is in it.
 *
 * Ordered by daily passengers so a caller taking the first N gets the markets
 * that matter, which is what both seeding and entry review want.
 *
 * `demand_pool` stores each pair once, canonically ordered, so this returns each
 * market once too — an NPC route is opened in the stored direction, and the
 * demand model treats a market as undirected exactly as `poolsFor` does.
 */
export async function topMarkets(
  db: Database,
  worldId: string,
  economy: PinnedEconomyConfig,
  limit: number,
  minDailyPassengers: number,
): Promise<MarketCandidate[]> {
  const pools = await db
    .select({
      originIcao: demandPool.originIcao,
      destinationIcao: demandPool.destinationIcao,
      distanceNm: demandPool.distanceNm,
      dailyPassengers: demandPool.dailyPassengers,
      businessShare: demandPool.businessShare,
      leisureShare: demandPool.leisureShare,
      vfrShare: demandPool.vfrShare,
    })
    .from(demandPool)
    .where(
      and(
        eq(demandPool.worldId, worldId),
        sql`${demandPool.dailyPassengers} >= ${String(minDailyPassengers)}`,
      ),
    )
    .orderBy(desc(demandPool.dailyPassengers))
    .limit(limit);

  if (pools.length === 0) return [];

  const incumbents = await incumbentsFor(
    db,
    worldId,
    pools.map((p) => [p.originIcao, p.destinationIcao] as const),
  );
  const costOf = createCostModel(economy);

  return pools.map((pool) => {
    const daily = parseNumeric(pool.dailyPassengers);
    const segments: Record<DemandSegment, number> = {
      business: daily * parseNumeric(pool.businessShare),
      leisure: daily * parseNumeric(pool.leisureShare),
      vfr: daily * parseNumeric(pool.vfrShare),
    };
    const operatorIds = incumbents.get(pairKey(pool.originIcao, pool.destinationIcao)) ?? [];
    const cost = costOf(pool.distanceNm);

    return {
      originIcao: pool.originIcao,
      destinationIcao: pool.destinationIcao,
      greatCircleNm: pool.distanceNm,
      dailyPassengers: daily,
      segments,
      incumbents: operatorIds.length,
      operatorIds,
      ...cost,
    };
  });
}

/** A market's key, direction-independent — the same normalisation `poolsFor` uses. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Who already sells each of these pairs.
 *
 * One query for every pair rather than one per pair, and a grouped result rather
 * than a correlated subquery — the pattern CLAUDE.md records after a correlated
 * `select` came back empty against real Postgres.
 *
 * Matches **both directions**, because a market has no direction: an incumbent
 * flying LEBL→EHAM is competing with an NPC that would fly EHAM→LEBL, and
 * counting them separately is how a "monopoly" route ends up with two operators
 * neither of which knows about the other.
 */
export async function incumbentsFor(
  db: Database,
  worldId: string,
  pairs: readonly (readonly [string, string])[],
): Promise<Map<string, string[]>> {
  if (pairs.length === 0) return new Map();

  const wanted = new Set(pairs.map(([a, b]) => pairKey(a, b)));
  const endpoints = new Set(pairs.flat());

  const rows = await db
    .select({
      airlineId: route.airlineId,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
    })
    .from(route)
    .innerJoin(airline, eq(airline.id, route.airlineId))
    .where(
      and(
        eq(route.worldId, worldId),
        eq(route.active, true),
        // A ceased airline is not competition. Its rows stay as world history.
        eq(airline.status, 'active'),
        or(
          sql`${route.originIcao} in ${[...endpoints]}`,
          sql`${route.destinationIcao} in ${[...endpoints]}`,
        ),
      ),
    );

  const found = new Map<string, string[]>();
  for (const row of rows) {
    const key = pairKey(row.originIcao, row.destinationIcao);
    if (!wanted.has(key)) continue;
    const list = found.get(key) ?? [];
    if (!list.includes(row.airlineId)) list.push(row.airlineId);
    found.set(key, list);
  }
  return found;
}
