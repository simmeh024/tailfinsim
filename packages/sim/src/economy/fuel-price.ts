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
 * ## What M5-07 added
 *
 * Until M5-07 there was one station in the world: every airport was charged
 * `EconomyConfig`'s `fuel.defaultStation`, so §9.3's *"prices vary by region"*
 * was modelled and then applied uniformly. {@link stationFuelPricing} resolves a
 * real station now — region, tier and a per-station spread — and
 * {@link worldFuelPrice} makes §11's *"world curve"* actually move over the
 * world's own calendar rather than sitting at its opening level for ever.
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
import type { AirportTier, FuelCurveBalance, FuelRegion, StationFuelRates } from '@tailfin/shared';

import { deriveRng } from '../random';

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

// ---------------------------------------------------------------------------
// Where a station's price comes from (M5-07, §9.3, §11)
// ---------------------------------------------------------------------------

/**
 * Which fuel region an airport sits in, or `null` when its geography is unknown.
 *
 * §9.3's *"prices vary by region"*, resolved. **Derived, not stored** — the same
 * argument `ground/station.ts` makes about vendors: there are ~4,400
 * scheduled-service airports and a region is a pure function of where one is, so
 * a column would be 4,400 rows of duplicated geography to migrate whenever the
 * classification changed, and a world reset (ADR-0005) would have to remember to
 * leave it alone.
 *
 * The country is consulted before the continent, because the continent is
 * materially wrong twice: OurAirports puts the Gulf in `AS`, where it would price
 * like Singapore rather than like the well it sits on, and Mexico and the whole
 * Caribbean in `NA`, where they would price like Houston rather than like the
 * importers they are. Those two are the override list, and it is a judgement
 * rather than a dataset — which is why it is written out rather than computed.
 *
 * A `null` continent is a real case in the source data, not a theoretical one, so
 * it returns `null` rather than being forced into a bucket: the caller falls back
 * to `EconomyConfig`'s `fuel.defaultStation`, which is what that field is for.
 */
export function fuelRegionOf(
  continent: string | null,
  isoCountry: string | null,
): FuelRegion | null {
  if (isoCountry !== null) {
    const override = REGION_BY_COUNTRY[isoCountry.toUpperCase()];
    if (override !== undefined) return override;
  }
  if (continent === null) return null;
  return REGION_BY_CONTINENT[continent.toUpperCase()] ?? null;
}

/**
 * The countries whose continent does not describe what fuel costs there.
 *
 * Two groups, and no others: the Gulf and the Levant, which sit on the crude and
 * price at the well rather than as Asian importers; and Mexico, Central America
 * and the Caribbean, which OurAirports files under `NA` but which import their
 * product and price accordingly. US territories in the Caribbean — Puerto Rico
 * and the US Virgin Islands — are deliberately **absent**: they are fed from the
 * US Gulf Coast on US terms, so the continent is right about them.
 */
const REGION_BY_COUNTRY: Readonly<Record<string, FuelRegion>> = {
  // At the well.
  AE: 'middle_east',
  BH: 'middle_east',
  IQ: 'middle_east',
  IR: 'middle_east',
  KW: 'middle_east',
  OM: 'middle_east',
  QA: 'middle_east',
  SA: 'middle_east',
  YE: 'middle_east',
  // The Levant, which prices with the Gulf rather than with south Asia.
  IL: 'middle_east',
  JO: 'middle_east',
  LB: 'middle_east',
  PS: 'middle_east',
  SY: 'middle_east',
  // Mexico, Central America and the Caribbean — `NA` by continent, importers in fact.
  MX: 'latin_america',
  GT: 'latin_america',
  BZ: 'latin_america',
  SV: 'latin_america',
  HN: 'latin_america',
  NI: 'latin_america',
  CR: 'latin_america',
  PA: 'latin_america',
  CU: 'latin_america',
  DO: 'latin_america',
  HT: 'latin_america',
  JM: 'latin_america',
  BS: 'latin_america',
  TT: 'latin_america',
  BB: 'latin_america',
  AG: 'latin_america',
  DM: 'latin_america',
  GD: 'latin_america',
  KN: 'latin_america',
  LC: 'latin_america',
  VC: 'latin_america',
  AW: 'latin_america',
  CW: 'latin_america',
  SX: 'latin_america',
  BQ: 'latin_america',
  KY: 'latin_america',
  TC: 'latin_america',
  VG: 'latin_america',
  AI: 'latin_america',
  MS: 'latin_america',
  GP: 'latin_america',
  MQ: 'latin_america',
  BL: 'latin_america',
  MF: 'latin_america',
};

/**
 * The default reading, from OurAirports' continent code.
 *
 * `OC` folds into `asia_pacific` rather than becoming a seventh region: Oceania's
 * jet fuel is Singapore's jet fuel plus a freight leg, and the freight leg is a
 * *station* fact that the tier fee factor already prices. `AN` is absent —
 * Antarctica has no fuel market to describe, and a station there falls back to
 * the default rates like any other airport whose geography says nothing.
 */
const REGION_BY_CONTINENT: Readonly<Record<string, FuelRegion>> = {
  EU: 'europe',
  NA: 'north_america',
  SA: 'latin_america',
  AS: 'asia_pacific',
  OC: 'asia_pacific',
  AF: 'africa',
};

/** The regional rate tables and station modifiers, as balance (invariant 3). */
export interface FuelStationConfig {
  regions: Record<FuelRegion, StationFuelRates>;
  defaultStation: StationFuelRates;
  tierFeeFactor: Record<AirportTier, number>;
  stationSpread: number;
}

/** Slices of the shipped payload, never a second copy of the numbers (invariant 3). */
export const DEFAULT_FUEL_STATION_CONFIG: FuelStationConfig = {
  regions: ECONOMY_CONFIG_V1.fuel.regions,
  defaultStation: ECONOMY_CONFIG_V1.fuel.defaultStation,
  tierFeeFactor: ECONOMY_CONFIG_V1.fuel.tierFeeFactor,
  stationSpread: ECONOMY_CONFIG_V1.fuel.stationSpread,
};

/** What the caller knows about an airport, which is all this needs to price it. */
export interface FuelStationInputs {
  icao: string;
  /** OurAirports' continent code, or null where the row does not carry one. */
  continent: string | null;
  /** ISO 3166-1 alpha-2. */
  isoCountry: string | null;
  /** M1-02's tier. Null for anything without scheduled service. */
  tier: AirportTier | null;
}

/**
 * What one station charges: its region's rates, adjusted for the station itself.
 *
 * Three effects, each answering a different question a player would ask about
 * their fuel bill:
 *
 *   - **the region** decides the commodity multiplier, and is the number a shock
 *     moves;
 *   - **the tier** decides the into-plane fee, because the fee buys a physical
 *     service and a hydrant stand is not a trucked-in bowser;
 *   - **the station spread** is local supply luck, drawn once per airport per
 *     world so it is a fact about that airport rather than noise on the quote.
 *
 * The spread stream is keyed on `('fuel', icao)` and on nothing else — not on
 * time, not on how many stations were priced first — so two workers, a replay and
 * the fare-floor preview all agree about what a station charges, and a station's
 * fuel luck is uncorrelated with its ground vendors.
 *
 * An airport with no tier is charged the `medium` factor rather than refused: a
 * tier is null only for a field with no scheduled service, and if an aircraft got
 * there it bought fuel there.
 */
export function stationFuelPricing(
  worldSeed: string,
  station: FuelStationInputs,
  config: FuelStationConfig = DEFAULT_FUEL_STATION_CONFIG,
): FuelStation {
  const region = fuelRegionOf(station.continent, station.isoCountry);
  const rates = region === null ? config.defaultStation : config.regions[region];

  // Symmetric about the region's factor, so a region's mean price is the region's
  // price — a spread that only ever added would quietly retune every region up.
  const draw = deriveRng(worldSeed, 'fuel', station.icao)();
  const jitter = 1 + (draw * 2 - 1) * config.stationSpread;

  const feeFactor = config.tierFeeFactor[station.tier ?? 'medium'];

  return {
    icao: station.icao,
    regionFactor: rates.regionFactor * jitter,
    intoPlaneFeePerTonne: rates.intoPlaneFeePerTonne * feeFactor,
  };
}

/** Milliseconds in a day, for walking the curve along the world's calendar. */
const MS_PER_DAY = 86_400_000;

/** Slice of the shipped payload — the curve, as balance (invariant 3). */
export const DEFAULT_FUEL_CURVE: FuelCurveBalance = ECONOMY_CONFIG_V1.fuel.curve;

/** Where the curve is sampled, and by whose calendar. */
export interface WorldFuelSample {
  basePricePerTonne: number;
  worldSeed: string;
  /** The world's in-game start, from `world.epoch`. Day zero of the curve. */
  epoch: Date;
  /** The in-game instant the fuel is bought at. */
  gameNow: Date;
}

/**
 * The world curve's level at an instant in the world's own calendar (§11).
 *
 * A closed form rather than a walk, and that is the load-bearing decision. A
 * random walk would make the price at a given in-game instant depend on how many
 * times anything had asked for it — so a `flight_result` from October could never
 * be re-derived, and two workers pricing the same arrival could disagree. This is
 * a pure function of the instant, which is what invariant 2 and M13-01's replay
 * harness need.
 *
 * The phases come from the world seed, so two worlds founded on the same day do
 * not move in lockstep — and, because a phase is a property of the world rather
 * than of the moment, the same world always reproduces the same curve.
 *
 * Game time in, dollars out. `packages/sim` may not read a clock (invariant 2),
 * so whoever knows the in-game date passes it in, exactly as `contractTermEnd`
 * takes a signing instant.
 */
export function worldFuelPrice(
  sample: WorldFuelSample,
  curve: FuelCurveBalance = DEFAULT_FUEL_CURVE,
): number {
  assertPositive(sample.basePricePerTonne, 'Base fuel price');
  const days = (sample.gameNow.getTime() - sample.epoch.getTime()) / MS_PER_DAY;
  if (!Number.isFinite(days)) {
    throw new Error('Fuel curve needs a finite game instant and epoch');
  }

  let factor = 1;
  curve.cycles.forEach((cycle, index) => {
    assertPositive(cycle.periodDays, 'Curve period');
    // One draw per cycle, keyed on the cycle's ordinal so adding a third cycle
    // does not move the phases of the first two.
    const phase = deriveRng(sample.worldSeed, 'fuel-curve', String(index))();
    factor += cycle.amplitudeFraction * Math.sin(2 * Math.PI * (days / cycle.periodDays + phase));
  });

  const clamped = Math.min(curve.maxFactor, Math.max(curve.minFactor, factor));
  return sample.basePricePerTonne * clamped;
}

/** The curve sampled into the shape {@link computeFuelCost} takes. */
export function worldFuelMarket(
  sample: WorldFuelSample,
  curve: FuelCurveBalance = DEFAULT_FUEL_CURVE,
): FuelMarket {
  return { basePricePerTonne: worldFuelPrice(sample, curve) };
}
