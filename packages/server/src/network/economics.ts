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
import { handlingPriceFactor } from '@tailfin/sim';
import type { FareFloorAircraft, FuelMarket, FuelStation } from '@tailfin/sim';

import { demandPool, route } from '../db/schema';
import { loadWorldFuelContext, marketNow, stationFor, loadAirportFuelRows } from '../economy/fuel';
import { loadWorldEconomyConfig } from '../economy/loader';
import { handlingArrangementFor, handlingPriceBalanceOf } from '../ground/contracts';
import { activeSocialMediaEffects } from '../office/specialists';

import { competitorsFor } from './competitors';
import { loadOperatingBasis } from './operating-fleet';

import type { RouteEconomics, RouteRow } from './fares';
import type { Database } from '../db/client';
import type { PinnedEconomyConfig } from '../economy/config';
import type { AirportFuelRow, WorldFuelContext } from '../economy/fuel';

/**
 * A representative narrowbody, for a route with no aeroplane on it.
 *
 * **No longer the production answer for a route the airline flies.** Since
 * IMPROVE-02 the floor and the preview are drawn from the types actually
 * scheduled over the pair (`operating-fleet.ts`), so this is what remains: the
 * stated assumption behind a *hypothetical*. A player pricing a route before
 * assigning an aircraft is asking what it would cost, and the basis that comes
 * back with the answer says `unassigned` and names this.
 *
 * Roughly an A320-family aircraft in a two-class layout. Kept exactly as it was
 * so that the change is visible as one thing: routes with a fleet move, routes
 * without one do not.
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

/**
 * The handling multiplier for a caller with no airline to resolve one for.
 *
 * 1 is the standard grade — the reference, in the same sense as
 * {@link REFERENCE_AIRFRAME} and {@link REFERENCE_FEES}, and for the same reason
 * those exist: a system that does not exist yet arrives as a named reference
 * rather than as a stub.
 *
 * The system that does not exist here is **NPC ground handling**. Nothing signs a
 * ground contract for a `kind = 'npc'` airline, so an NPC's real arrangement
 * today is walk-up — and costing them at 1.35× would charge them for a feature
 * that has not been built for them rather than for a choice they made. Costing
 * them at the standard grade treats them as holding a contract any player can
 * also hold, which is what M3-12's *"never receive resources or modifiers
 * unavailable to players"* actually asks for. When NPCs sign contracts, resolve
 * it the way `createEconomicsProvider` does below and delete this.
 */
export const REFERENCE_HANDLING_PRICE_FACTOR = 1;

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
 * Real demand, real money, and — since IMPROVE-02 — the **real aeroplane**: the
 * floor and the projection are drawn from the types this airline schedules over
 * the pair, so a player flying ATRs is no longer quoted an A320's costs. What is
 * still a stand-in is airport charges, and the basis on the response says which
 * aircraft the figures are for.
 *
 * The money became real in M3-11: the fuel price, the cost table and A.10's
 * floor ratio are read from the route's own world through its pinned economy
 * version, so a retune moves every fare floor in that world on the next request
 * and only in that world. The `market` override stays for tests.
 */
/**
 * The lookups that are the same for every route in one request.
 *
 * A caller costing a whole rotation asks the provider once per leg, and four of
 * the reads behind it do not vary between legs: the world's fuel context and its
 * pinned economy are properties of the world, and the social media effects and
 * the active route count are properties of the airline. An eight-leg schedule was
 * making thirty-two round trips for four answers.
 *
 * Primed per request rather than cached in the provider closure, and that is the
 * point: `createEconomicsProvider` is built once at startup, and a world's seed
 * and epoch **change** when it is reset (ADR-0005). A process-lifetime cache of
 * those would keep serving a reset world its old calendar. A scope lives for one
 * request and cannot go stale within it.
 *
 * The airport rows are batched rather than merely deduplicated, because the legs
 * of a rotation usually have different origins — deduplication alone would save
 * nothing.
 */
export interface RouteEconomicsScope {
  fuelCtx: WorldFuelContext | null;
  economy: PinnedEconomyConfig;
  airportRows: Map<string, AirportFuelRow>;
  effects: Awaited<ReturnType<typeof activeSocialMediaEffects>>;
  activeRoutes: number;
}

/**
 * Read everything a set of legs shares, once.
 *
 * `worldId` and `airlineId` are the caller's own — every leg of a rotation
 * belongs to the same airline in the same world, which is the assumption that
 * makes this sound.
 */
export async function primeEconomicsScope(
  db: Database,
  input: { worldId: string; airlineId: string; originIcaos: readonly string[] },
): Promise<RouteEconomicsScope> {
  const [economy, effects, activeRoutes, fuelCtx, airportRows] = await Promise.all([
    loadWorldEconomyConfig(db, input.worldId),
    activeSocialMediaEffects(db, input.airlineId),
    countActiveRoutes(db, input.airlineId),
    loadWorldFuelContext(db, input.worldId),
    loadAirportFuelRows(db, input.originIcaos),
  ]);
  return { economy, effects, activeRoutes, fuelCtx, airportRows };
}

/**
 * The aeroplane a route's estimate is drawn for, and what to call the basis.
 *
 * Folds the three cases into what `RouteEconomics` needs. An `unassigned` route
 * is the only one that still sees {@link REFERENCE_AIRFRAME}, and it arrives
 * labelled rather than silent — which is the issue's *"do not silently present
 * an arbitrary reference aircraft as the player's aircraft"*.
 */
async function operatingAircraftFor(
  db: Database,
  row: RouteRow,
): Promise<{
  kind: 'single' | 'mixed' | 'unassigned';
  label: string;
  aircraft: FareFloorAircraft;
  fleet: readonly FareFloorAircraft[];
}> {
  const basis = await loadOperatingBasis(db, {
    worldId: row.worldId,
    airlineId: row.airlineId,
    originIcao: row.originIcao,
    destinationIcao: row.destinationIcao,
  });

  const busiest = basis.types[0];
  if (busiest === undefined) {
    return {
      kind: 'unassigned',
      label: `${basis.label} — costs shown for a representative narrowbody`,
      aircraft: REFERENCE_AIRFRAME,
      fleet: [REFERENCE_AIRFRAME],
    };
  }

  return {
    kind: basis.kind,
    label: basis.label,
    aircraft: busiest.aircraft,
    fleet: basis.types.map((type) => type.aircraft),
  };
}

export function createEconomicsProvider(
  db: Database,
  market?: FuelMarket,
): (row: RouteRow, scope?: RouteEconomicsScope) => Promise<RouteEconomics> {
  return async (row, scope) => {
    const [shared, segmentPools] = await Promise.all([
      scope ??
        primeEconomicsScope(db, {
          worldId: row.worldId,
          airlineId: row.airlineId,
          originIcaos: [row.originIcao],
        }),
      poolsFor(db, row),
    ]);
    const { economy, effects, activeRoutes, fuelCtx, airportRows: originRows } = shared;

    /*
     * What this airline actually flies over this pair (IMPROVE-02).
     *
     * Not part of `primeEconomicsScope`, deliberately: the scope holds what
     * every leg of a rotation shares, and the operating fleet is a property of
     * the *pair*. Two legs of one schedule have different answers.
     */
    const basis = await operatingAircraftFor(db, row);

    /*
     * §9.1's attractiveness specialist. The bonus applies only once the airline
     * flies more than one route: a single-route carrier has no network for a
     * marketer to work with, and the second route is the first thing the
     * specialist has something to say about. Zero otherwise, which keeps the
     * term out of every market where it does not apply.
     */
    const attractiveness =
      effects.attractiveness && activeRoutes > 1 ? economy.socialMedia.attractivenessUtility : 0;

    /*
     * What the origin's handling costs *this* airline (M5-06, §9.3). The floor
     * has to be drawn against the handling the flight will actually be billed,
     * or it is not a floor — see `fare-floor.ts`'s note on the release where it
     * was not.
     *
     * The origin's tier is handed in from `originRows`, which was already read
     * for the fuel station, so this does not pay for a second airport lookup.
     */
    const arrangement = await handlingArrangementFor(
      db,
      row.airlineId,
      row.originIcao,
      'ramp_baggage',
      economy,
      originRows.get(row.originIcao)?.tier ?? null,
    );

    const competitors = await competitorsFor(db, {
      worldId: row.worldId,
      originIcao: row.originIcao,
      destinationIcao: row.destinationIcao,
      excludeAirlineId: row.airlineId,
      economy,
      /*
       * A rival player is assumed to offer what *this* player offers.
       *
       * Still an assumption, and now a better-grounded one: since IMPROVE-02 it
       * is the seat count of the aeroplane this airline actually schedules here,
       * rather than a fixed 174 for everybody. Reading a competitor's own fleet
       * is a different question — it needs their schedules, which are theirs —
       * and symmetry is the honest stand-in until §15 gives rivals a fleet the
       * market can see.
       */
      playerSeatsByCabin: basis.aircraft.seatsByCabin,
    });

    return {
      aircraft: basis.aircraft,
      fleet: basis.fleet,
      basis: { kind: basis.kind, label: basis.label },
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
      handlingPriceFactor: handlingPriceFactor(arrangement, handlingPriceBalanceOf(economy)),
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
