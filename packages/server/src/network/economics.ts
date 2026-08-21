/**
 * What a route costs and who wants it (M3-09).
 *
 * `fares.ts` takes its economics as a parameter and does not care where they
 * come from. This is the implementation that exists today, and it is honest
 * about which half is real:
 *
 * - **Demand is real.** M3-01 sized every viable pair into `demand_pool`, with
 *   its own segment mix, so the pools here are the world's own numbers rather
 *   than a placeholder.
 * - **The aircraft is not.** There is no fleet (M4), so the airframe comes from
 *   a reference config below. Every fare floor on the box is therefore drawn
 *   against a representative narrowbody rather than against the aeroplane the
 *   player actually flies, and it will move when M4 lands.
 * - **Competitors are real, since M3-12.** Every other active airline selling
 *   the pair — NPC incumbent or rival player — is resolved into the same
 *   `ClassOperator` shape and handed to the same allocator. An empty list is
 *   still a real state rather than a stub; it now means what it says, which is
 *   that this market genuinely has one operator in it.
 *
 * Stating that split matters more than hiding it. A preview built on a
 * reference airframe is useful; a preview that *looks* like it knows your fleet
 * and does not is a number a player would price against and be wrong.
 */

import { and, eq } from 'drizzle-orm';

import type { AirportFees, DemandSegment } from '@tailfin/shared';
import type { FareFloorAircraft, FuelMarket, FuelStation } from '@tailfin/sim';

import { demandPool } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import { competitorsFor } from './competitors';

import type { RouteEconomics, RouteRow } from './fares';
import type { Database } from '../db/client';

/**
 * A representative narrowbody, until M4's catalogue can answer.
 *
 * Roughly an A320-family aircraft in a two-class layout — the aeroplane most
 * short-haul routes in this game will be flown by. Named as a placeholder in
 * the type and in the docs so nobody mistakes it for a fleet lookup.
 */
export const REFERENCE_AIRFRAME: FareFloorAircraft = {
  cruiseSpeedKt: 447,
  cruiseBurnTPerNm: 0.0062,
  maxTakeoffWeightT: 79,
  seatsByCabin: { business: 12, economy: 162 },
};

/**
 * Reference airport charges, until M7 gives airports their own.
 *
 * `airport` carries tiers and runways but no fee schedule, so these are one set
 * for everywhere. That makes the floor identical at Heathrow and at a regional
 * strip, which is wrong and is the first thing M7-04 will fix.
 */
export const REFERENCE_FEES: AirportFees = {
  landingPerTonne: 900,
  paxFee: 1_200,
  parkingPerHour: 4_000,
  gateLeaseAnnual: 12_000_000,
};

export const REFERENCE_STATION: FuelStation = {
  icao: 'REF',
  regionFactor: 1,
  intoPlaneFeePerTonne: 4_000,
};

/** What an airline is assumed to be, until M6 and §15 can say. */
export const REFERENCE_SELF = { reputation: 0.35, productScore: 0.6, frequency: 2 };

/**
 * A city pair in the order `demand_pool` stores it.
 *
 * **A market has no direction.** `demand_pool` enforces that with the
 * `demand_pool_canonical_order` check — `origin_icao < destination_icao` — so
 * every pair is stored exactly once, and M3-01's generator only ever walks
 * `i < j`. A `route`, by contrast, *is* directional: `open-route.ts` stores
 * whichever way round the player typed it.
 *
 * Those two facts have to be reconciled somewhere, and until M3-12 they were
 * not. `poolsFor` matched the pair in route order, so a route opened as
 * LEBL→EHAM found no row and reported a market of **zero passengers** — while
 * the same physical market opened as EHAM→LEBL reported thousands. Roughly half
 * of all routes, decided by nothing more than the alphabet.
 */
export function canonicalPair(originIcao: string, destinationIcao: string): [string, string] {
  return originIcao < destinationIcao
    ? [originIcao, destinationIcao]
    : [destinationIcao, originIcao];
}

/**
 * The market this route sells into, from the world's own demand pools.
 *
 * `numeric` comes back from the driver as a **string** — the trap CLAUDE.md
 * records — so every share is parsed rather than trusted to be a number.
 * A pair with no pool row returns zero demand, which is the truthful answer for
 * a city pair M3-01 judged non-viable.
 */
export async function poolsFor(
  db: Database,
  row: RouteRow,
): Promise<Record<DemandSegment, number>> {
  const [poolOrigin, poolDestination] = canonicalPair(row.originIcao, row.destinationIcao);

  const found = await db
    .select({
      dailyPassengers: demandPool.dailyPassengers,
      businessShare: demandPool.businessShare,
      leisureShare: demandPool.leisureShare,
      vfrShare: demandPool.vfrShare,
    })
    .from(demandPool)
    .where(
      and(
        eq(demandPool.worldId, row.worldId),
        eq(demandPool.originIcao, poolOrigin),
        eq(demandPool.destinationIcao, poolDestination),
      ),
    )
    .limit(1);

  const pool = found[0];
  if (!pool) return { business: 0, leisure: 0, vfr: 0 };

  const daily = Number.parseFloat(pool.dailyPassengers);
  const share = (value: string): number => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };

  if (!Number.isFinite(daily)) return { business: 0, leisure: 0, vfr: 0 };

  return {
    business: daily * share(pool.businessShare),
    leisure: daily * share(pool.leisureShare),
    vfr: daily * share(pool.vfrShare),
  };
}

/**
 * The economics provider the server registers with.
 *
 * Real demand, real money, reference aircraft — see the module note on why that
 * split is stated rather than papered over.
 *
 * The money became real in M3-11: the fuel price, the cost table and A.10's
 * floor ratio are read from the route's own world through its pinned economy
 * version, so a retune moves every fare floor in that world on the next request
 * and only in that world. The `market` override stays for tests.
 */
export function createEconomicsProvider(
  db: Database,
  market?: FuelMarket,
): (row: RouteRow) => Promise<RouteEconomics> {
  return async (row) => {
    const [economy, segmentPools] = await Promise.all([
      loadWorldEconomyConfig(db, row.worldId),
      poolsFor(db, row),
    ]);

    const competitors = await competitorsFor(db, {
      worldId: row.worldId,
      originIcao: row.originIcao,
      destinationIcao: row.destinationIcao,
      excludeAirlineId: row.airlineId,
      economy,
      // A rival player is assumed to fly what this player is assumed to fly,
      // which is the only symmetric answer available before M4 gives anyone a
      // real fleet.
      playerSeatsByCabin: REFERENCE_AIRFRAME.seatsByCabin,
    });

    return {
      aircraft: REFERENCE_AIRFRAME,
      market: market ?? { basePricePerTonne: economy.fuel.basePricePerTonne },
      originStation: { ...REFERENCE_STATION, icao: row.originIcao },
      originFees: REFERENCE_FEES,
      destinationFees: REFERENCE_FEES,
      segmentPools,
      competitors,
      self: REFERENCE_SELF,
      settlement: economy.costs.settlement,
      fareFloorRatio: economy.pricing.fareFloorRatio,
    };
  };
}
