/**
 * What that fuel costs, and where the price came from (M2-05, §9.3, §11, §20).
 *
 * `flight/fuel.ts` answers *how many tonnes*. This answers *how many dollars*,
 * and the two are separate on purpose: burn is a property of the airframe and the
 * sector, price is a property of the **station and the day**, and §9.3 is explicit
 * that they vary independently — *"into-plane fees vary by airport, prices vary by
 * region."*
 *
 * ## One world curve, many stations
 *
 * §11: *"Fuel price fluctuates on a world curve."* §20 then puts an **oil shock**
 * on the events table. Those two together are why the price is modelled as a
 * single world number that every station scales rather than as an independent
 * price per airport: a shock has to move the whole map at once, and it cannot do
 * that if each station holds its own unrelated figure.
 *
 * The regional factor is what survives the shock — a cheap Gulf station stays
 * cheap relative to an expensive European one — which is what keeps **tankering**
 * (§9.3) a live decision during a shock rather than a solved one.
 *
 * ## What is not here
 *
 * Tankering itself. Uplifting cheap fuel to avoid buying dear fuel trades price
 * against the burn cost of the extra weight, so it needs the payload/range model
 * as well as this one, and §9.3 files it as *"a great advanced mechanic"* rather
 * than MVP. The hook it will need is {@link stationPricePerTonne}: a tankering
 * decision is that function evaluated at both ends of a sector.
 *
 * Hedging is post-MVP by §11's own note, and belongs to the finance layer (§13)
 * rather than here — it changes the price the airline *pays*, not the price the
 * station *charges*.
 */

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';

/**
 * The world fuel curve at a moment in game time (§11).
 *
 * A level rather than a series: the curve is world state that the caller samples,
 * because `packages/sim` may not read a clock (CONTRIBUTING invariant 2). Whoever
 * knows the in-game date passes in the level for that date.
 */
export interface FuelMarket {
  /** Jet A-1, dollars per tonne, at the world reference. */
  basePricePerTonne: number;
}

/**
 * The world curve's opening level — a balance number (invariant 3), and one the
 * design doc supplies an anchor for rather than leaving to taste.
 *
 * $1,000/t is not picked off a spot chart. It is **solved from §13.4's worked
 * example**: that airline flies eight ~200 nm ATR 72 sectors a day and spends
 * *"fuel 168k"* a month, which is $700 a sector, which at the 0.655 t
 * `computeFuelBurn` gives for those sectors is about $1,065/t all-in. Take off a
 * NW-European into-plane fee of $35/t and a regional premium of 3%, and the world
 * reference is $1,000/t. See `flight/fuel.test.ts`, which runs that whole chain
 * and lands within half a percent of the published figure.
 *
 * Calibrating the **price** to the doc rather than the burn curve is deliberate.
 * The burn curve is physics and was derived independently; the price is a dial,
 * and this is the only place the design doc puts a number on the end of it. It is
 * also historically unremarkable — Jet A-1 sat near $1,000/t through 2023 and
 * touched $1,400/t in 2022, which is the range §20's oil shock has to move within.
 */
export const DEFAULT_FUEL_MARKET: FuelMarket = {
  basePricePerTonne: ECONOMY_CONFIG_V1.fuel.basePricePerTonne,
};

/**
 * Version tag, mirroring `FUEL_BURN_CONFIG_VERSION` and
 * `world.economy_config_version`.
 *
 * More load-bearing here than elsewhere: the world curve is *meant* to move, so a
 * fuel line from October has to record the level it was billed at or it cannot be
 * explained afterwards at all (invariant 4).
 */
export const FUEL_MARKET_VERSION = 'v1' as const;

/**
 * One station's fuel pricing (§9.3).
 *
 * Both fields belong to the airport rather than to the airline. What the airline
 * negotiates — volume deals, a supplier contract — is a §9.3 vendor concern and
 * arrives as a separate discount when that lands; it is not folded in here,
 * because a player has to be able to see what the station charges before seeing
 * what they managed to knock off it.
 */
export interface FuelStation {
  /** ICAO code, so a cost line can name where the fuel was bought. */
  icao: string;
  /**
   * Multiplier on the world price for this station's region.
   *
   * 1 is the world reference. Rotterdam-adjacent Europe sits near it; a station
   * far from a refinery or a pipeline sits well above; a Gulf station sits below.
   */
  regionFactor: number;
  /**
   * The handler's charge for actually putting it in the aircraft, per tonne.
   *
   * Flat against the world curve rather than scaled by it, and that is the point:
   * it is a **service** charge — a bowser, a driver and a hose — so during an oil
   * shock it stays put while the fuel around it doubles. It is also why a small
   * uplift at an expensive-to-handle station is worse than the headline price
   * suggests.
   */
  intoPlaneFeePerTonne: number;
}

/** Dollars per tonne actually payable at a station, fuel and fee together. */
export function stationPricePerTonne(market: FuelMarket, station: FuelStation): number {
  assertPositive(market.basePricePerTonne, 'Base fuel price');
  assertPositive(station.regionFactor, 'Region factor');
  assertNonNegative(station.intoPlaneFeePerTonne, 'Into-plane fee');
  return market.basePricePerTonne * station.regionFactor + station.intoPlaneFeePerTonne;
}

/** Where each part of the bill came from, so no figure is a dead end (§14.1). */
export interface FuelCostComponent {
  source: 'fuel' | 'into-plane';
  cost: number;
  detail: string;
}

export interface FuelCostResult {
  /** What the sector's fuel cost, all in. */
  totalCost: number;
  /** The commodity alone. */
  fuelCost: number;
  /** The handler's charge for delivering it. */
  intoPlaneCost: number;
  /** Tonnes billed — echoed back so the bill states its own quantity. */
  tonnes: number;
  /** Dollars per tonne all in, which is the number to compare stations on. */
  pricePerTonne: number;
  /** Where the money went. Sums to `totalCost`. */
  components: FuelCostComponent[];
  /** Which station sold it. */
  icao: string;
}

function assertPositive(value: number, what: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} must be positive, got ${String(value)}`);
  }
}

function assertNonNegative(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${what} must be zero or more, got ${String(value)}`);
  }
}

function round(value: number, places = 0): string {
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/**
 * Cost of a given number of tonnes bought at a given station.
 *
 * Takes tonnes rather than a `FuelBurnResult`, which keeps this side of the model
 * unaware of flights entirely: the same function prices a sector's burn, an
 * overnight top-up, and a tankering uplift, and none of those are the same object.
 */
export function computeFuelCost(
  tonnes: number,
  market: FuelMarket,
  station: FuelStation,
): FuelCostResult {
  assertNonNegative(tonnes, 'Fuel quantity');

  const pricePerTonne = stationPricePerTonne(market, station);
  const commodityPerTonne = market.basePricePerTonne * station.regionFactor;
  const fuelCost = tonnes * commodityPerTonne;
  const intoPlaneCost = tonnes * station.intoPlaneFeePerTonne;

  const components: FuelCostComponent[] = [
    {
      source: 'fuel',
      cost: fuelCost,
      detail:
        `${round(tonnes, 2)} t at $${round(commodityPerTonne)}/t — ` +
        `the world price of $${round(market.basePricePerTonne)}/t ` +
        (station.regionFactor === 1
          ? `and ${station.icao} is at the world reference.`
          : station.regionFactor > 1
            ? `and ${station.icao} is ${round((station.regionFactor - 1) * 100)}% above it.`
            : `and ${station.icao} is ${round((1 - station.regionFactor) * 100)}% below it.`),
    },
  ];

  if (station.intoPlaneFeePerTonne > 0) {
    components.push({
      source: 'into-plane',
      cost: intoPlaneCost,
      detail: `Into-plane fee at ${station.icao}, $${round(station.intoPlaneFeePerTonne)}/t.`,
    });
  }

  return {
    totalCost: fuelCost + intoPlaneCost,
    fuelCost,
    intoPlaneCost,
    tonnes,
    pricePerTonne,
    components,
    icao: station.icao,
  };
}
