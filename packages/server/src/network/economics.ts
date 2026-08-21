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
 * - **Competitors are not.** Nobody else is flying, because there are no AI
 *   carriers (M3-12) and one player. An empty competitor list is a real state,
 *   not a stub — a monopoly is a market of one — so the preview is correct
 *   today and gets more interesting rather than less wrong.
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
        eq(demandPool.originIcao, row.originIcao),
        eq(demandPool.destinationIcao, row.destinationIcao),
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

    return {
      aircraft: REFERENCE_AIRFRAME,
      market: market ?? { basePricePerTonne: economy.fuel.basePricePerTonne },
      originStation: { ...REFERENCE_STATION, icao: row.originIcao },
      originFees: REFERENCE_FEES,
      destinationFees: REFERENCE_FEES,
      segmentPools,
      // No AI carriers yet (M3-12) and one player. A monopoly is a market of one.
      competitors: [],
      self: REFERENCE_SELF,
      settlement: economy.costs.settlement,
      fareFloorRatio: economy.pricing.fareFloorRatio,
    };
  };
}
