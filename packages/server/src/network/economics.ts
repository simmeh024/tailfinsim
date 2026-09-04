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

import { and, count, eq } from 'drizzle-orm';

import type { AirportFees, DemandSegment } from '@tailfin/shared';
import type { FareFloorAircraft, FuelMarket, FuelStation } from '@tailfin/sim';

import { demandPool, route } from '../db/schema';
import { loadWorldFuelContext, marketNow, stationFor, loadAirportFuelRows } from '../economy/fuel';
import { loadWorldEconomyConfig } from '../economy/loader';
import { activeSocialMediaEffects } from '../office/specialists';

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

/**
 * A station, for a caller that has no world to derive one from.
 *
 * **No longer the production answer.** Until M5-07 every fare floor in the game
 * was drawn against this one station, which is what made §9.3's *"prices vary by
 * region"* modelled but never applied; `createEconomicsProvider` now resolves the
 * origin's own rates from its row. What is left is the fixture the pure fare-floor
 * and waterfall tests price against, where no world exists to have a seed.
 *
 * The rates are the world reference — factor 1, and the fee at NW-European
 * levels — rather than the $4,000/t placeholder that stood here before. That
 * number was four times the price of the fuel it was a handling charge on, and it
 * survived only because nothing compared it to a real one.
 */
export const REFERENCE_STATION: FuelStation = {
  icao: 'REF',
  regionFactor: 1,
  intoPlaneFeePerTonne: 35,
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
    const [economy, segmentPools, effects, activeRoutes, fuelCtx, originRows] = await Promise.all([
      loadWorldEconomyConfig(db, row.worldId),
      poolsFor(db, row),
      activeSocialMediaEffects(db, row.airlineId),
      countActiveRoutes(db, row.airlineId),
      loadWorldFuelContext(db, row.worldId),
      loadAirportFuelRows(db, [row.originIcao]),
    ]);

    /*
     * §9.1's attractiveness specialist. The bonus applies only once the airline
     * flies more than one route: a single-route carrier has no network for a
     * marketer to work with, and the second route is the first thing the
     * specialist has something to say about. Zero otherwise, which keeps the
     * term out of every market where it does not apply.
     */
    const attractiveness =
      effects.attractiveness && activeRoutes > 1 ? economy.socialMedia.attractivenessUtility : 0;

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
      /*
       * The fuel half became real in M5-07: the world curve is sampled at the
       * world's own reading of now, and the station is the *origin's* — its
       * region, its tier, its spread. So a floor out of a Gulf hub is genuinely
       * lower than the same sector out of an African one, and a floor quoted
       * today is not the floor quoted next season.
       *
       * `market` stays overridable for tests. A world whose row has gone falls
       * back to the opening level and the default rates rather than refusing to
       * quote a floor.
       */
      market:
        market ??
        (fuelCtx === null
          ? { basePricePerTonne: economy.fuel.basePricePerTonne }
          : marketNow(fuelCtx, new Date(), economy)),
      originStation:
        fuelCtx === null
          ? { ...economy.fuel.defaultStation, icao: row.originIcao }
          : stationFor(row.originIcao, originRows.get(row.originIcao), fuelCtx, economy),
      originFees: REFERENCE_FEES,
      destinationFees: REFERENCE_FEES,
      segmentPools,
      competitors,
      self: { ...REFERENCE_SELF, attractiveness },
      settlement: economy.costs.settlement,
      fareFloorRatio: economy.pricing.fareFloorRatio,
    };
  };
}

/**
 * How many routes this airline is currently flying.
 *
 * Only `active` routes count — a closed route is not a network the specialist
 * can market. A grouped `count` rather than a correlated subquery, which is the
 * shape CLAUDE.md records as the one that actually comes back right on Postgres.
 */
async function countActiveRoutes(db: Database, airlineId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(route)
    .where(and(eq(route.airlineId, airlineId), eq(route.active, true)));
  return row?.value ?? 0;
}
