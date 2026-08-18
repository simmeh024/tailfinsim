import { type CountryIndicator, type GeoNamesCity } from './sources';

/**
 * Turning cities and country statistics into the four numbers A.2 consumes.
 *
 * Pure — no database, no network — because every decision here is a judgement
 * that someone will want to argue with, and an argument is much easier against a
 * function you can call with made-up numbers.
 *
 * ## The four values
 *
 * A.2's gravity model is
 *
 *     D_base = k · (Pop_o · Wealth_o · Pop_d · Wealth_d)^α · f(distance) · Affinity_od
 *
 * so `population` is a count of people and the three indices are **multipliers
 * normalised to a world median of 1.0**. That normalisation is the important
 * part: A.2 multiplies them together, so a raw GDP-per-capita of 55,000 would
 * not be "rich", it would be a number that swamps the population term entirely.
 * Anchoring the median at 1.0 means the indices tilt demand rather than define
 * it, and `k` stays meaningful.
 */

/** Cities within this range of an airport count towards its catchment. */
export const CATCHMENT_RADIUS_KM = 100;

/**
 * How far the indices may travel from the median.
 *
 * Raw GDP per capita spans about 400× between Burundi and Luxembourg. Feeding
 * that spread into a product would make the poorest markets round to no demand
 * at all, which is both wrong — people fly there — and bad for the game, since
 * §B.3 wants thin, uncontested regional markets to be a viable strategy rather
 * than an empty map. Compressing to a 0.25–4 band keeps the ordering while
 * keeping every market playable.
 */
export const INDEX_MIN = 0.25;
export const INDEX_MAX = 4;

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance. The same haversine M1-04 will need for the route matrix. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type AirportTier = 'flagship' | 'large' | 'medium' | 'small' | 'regional';

/**
 * How a shared metro population is divided between its airports.
 *
 * M1-03 requires multi-airport cities to "split catchment between them rather
 * than double-counting". Splitting *equally* would be the obvious approach and
 * would be wrong: it would hand Luton the same share of London as Heathrow, and
 * then the demand model would conclude they are the same size of market.
 *
 * Weighting by tier is the honest version — tier is already a measure of how much
 * traffic an airport carries (M1-02), so it is the right shape for "how much of
 * this metro does this airport actually serve". The numbers are a judgement, not
 * a measurement, and are deliberately far apart so a flagship dominates its metro
 * rather than merely leading it.
 */
export const TIER_WEIGHTS: Record<AirportTier, number> = {
  flagship: 16,
  large: 8,
  medium: 3,
  small: 1,
  regional: 0.5,
};

export interface CatchmentAirport {
  id: string;
  ident: string;
  latitude: number;
  longitude: number;
  isoCountry: string;
  tier: AirportTier;
}

export interface CatchmentResult {
  airportId: string;
  population: number;
  wealthIndex: number;
  tourismIndex: number;
  businessIndex: number;
  basis: {
    radiusKm: number;
    citiesInRange: number;
    /** Population before the multi-airport split, so the split is visible. */
    rawPopulation: number;
    /** This airport's share of its metro, 0–1. Below 1 means it shares with others. */
    shareOfMetro: number;
    competingAirports: number;
    largestCity: string | null;
    capitalInRange: boolean;
    gdpPerCapita: number | null;
    gdpYear: number | null;
    arrivalsPerResident: number | null;
    fallbacks: string[];
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * Normalises a raw quantity into a multiplier centred on 1.0.
 *
 * Uses the **square root** of the ratio to the median rather than the ratio
 * itself. A.2 already raises the whole product to α ≈ 0.4, and applying a raw
 * ratio on top would compound two exponents into a curve nobody intended; the
 * square root keeps the index a gentle tilt. Then clamped — see INDEX_MIN.
 */
export function normaliseIndex(value: number, medianValue: number): number {
  if (medianValue <= 0 || value <= 0) return 1;
  return clamp(Math.sqrt(value / medianValue), INDEX_MIN, INDEX_MAX);
}

interface CityAllocation {
  city: GeoNamesCity;
  airports: { airport: CatchmentAirport; weight: number }[];
}

/**
 * Allocates every city to the airports within range, pro-rata by tier weight.
 *
 * This is where double-counting is prevented: a city contributes its population
 * once, divided among its airports, so summing catchment across a metro gives
 * the metro's population rather than a multiple of it.
 */
function allocateCities(
  airports: readonly CatchmentAirport[],
  cities: readonly GeoNamesCity[],
): Map<string, { population: number; raw: number; cities: GeoNamesCity[]; competitors: number }> {
  // Bucket airports by a coarse lat/lon grid so each city only tests nearby ones.
  // 86,000 airports × 30,000 cities is 2.6 billion pairs; the grid makes it
  // tractable without changing the answer.
  const cellSize = 1; // degrees — comfortably larger than the 100 km radius at most latitudes
  const grid = new Map<string, CatchmentAirport[]>();
  const key = (lat: number, lon: number): string =>
    `${String(Math.floor(lat / cellSize))}:${String(Math.floor(lon / cellSize))}`;

  for (const airport of airports) {
    const cell = key(airport.latitude, airport.longitude);
    const bucket = grid.get(cell);
    if (bucket) bucket.push(airport);
    else grid.set(cell, [airport]);
  }

  const result = new Map<
    string,
    { population: number; raw: number; cities: GeoNamesCity[]; competitors: number }
  >();
  for (const airport of airports) {
    result.set(airport.id, { population: 0, raw: 0, cities: [], competitors: 0 });
  }

  for (const city of cities) {
    const allocation: CityAllocation = { city, airports: [] };

    // Two cells either side covers the radius at any latitude the grid is used at.
    const latCell = Math.floor(city.latitude / cellSize);
    const lonCell = Math.floor(city.longitude / cellSize);
    for (let dLat = -2; dLat <= 2; dLat += 1) {
      for (let dLon = -2; dLon <= 2; dLon += 1) {
        const bucket = grid.get(`${String(latCell + dLat)}:${String(lonCell + dLon)}`);
        if (!bucket) continue;
        for (const airport of bucket) {
          const km = distanceKm(city.latitude, city.longitude, airport.latitude, airport.longitude);
          if (km <= CATCHMENT_RADIUS_KM) {
            allocation.airports.push({ airport, weight: TIER_WEIGHTS[airport.tier] });
          }
        }
      }
    }

    if (allocation.airports.length === 0) continue;

    const totalWeight = allocation.airports.reduce((sum, entry) => sum + entry.weight, 0);
    for (const entry of allocation.airports) {
      const bucket = result.get(entry.airport.id);
      if (!bucket) continue;
      bucket.population += (city.population * entry.weight) / totalWeight;
      bucket.raw += city.population;
      bucket.cities.push(city);
      bucket.competitors = Math.max(bucket.competitors, allocation.airports.length - 1);
    }
  }

  return result;
}

export interface DeriveInput {
  airports: readonly CatchmentAirport[];
  cities: readonly GeoNamesCity[];
  gdpPerCapita: ReadonlyMap<string, CountryIndicator>;
  touristArrivals: ReadonlyMap<string, CountryIndicator>;
  countryPopulation: ReadonlyMap<string, CountryIndicator>;
}

export function deriveCatchment(input: DeriveInput): CatchmentResult[] {
  const { airports, cities, gdpPerCapita, touristArrivals, countryPopulation } = input;

  const allocations = allocateCities(airports, cities);

  // World medians, computed over the countries that actually have data rather
  // than over airports — otherwise a country with 400 airstrips would drag the
  // median towards itself.
  const gdpMedian = median([...gdpPerCapita.values()].map((v) => v.value));
  const arrivalsPerResident = new Map<string, number>();
  for (const [country, arrivals] of touristArrivals) {
    const people = countryPopulation.get(country);
    if (people && people.value > 0) arrivalsPerResident.set(country, arrivals.value / people.value);
  }
  const arrivalsMedian = median([...arrivalsPerResident.values()]);

  return airports.map((airport) => {
    const allocation = allocations.get(airport.id) ?? {
      population: 0,
      raw: 0,
      cities: [],
      competitors: 0,
    };
    const fallbacks: string[] = [];

    // ------------------------------------------------------------ population --
    let population = Math.round(allocation.population);
    if (population <= 0) {
      // An airport with no GeoNames settlement within 100 km is genuinely remote —
      // an island strip or a bush field. It still has *some* market, and a zero
      // would multiply the whole city pair to nothing in A.2. GeoNames' floor is
      // 15,000 people, so anything below it is invisible to us by construction.
      population = 5_000;
      fallbacks.push('no city within radius — floored');
    }

    // ---------------------------------------------------------------- wealth --
    const gdp = gdpPerCapita.get(airport.isoCountry);
    if (!gdp) fallbacks.push('no GDP per capita for country — index 1.0');
    const wealthIndex = gdp ? normaliseIndex(gdp.value, gdpMedian) : 1;

    // --------------------------------------------------------------- tourism --
    const arrivals = arrivalsPerResident.get(airport.isoCountry);
    if (arrivals === undefined) fallbacks.push('no tourism arrivals for country — index 1.0');
    const tourismIndex = arrivals === undefined ? 1 : normaliseIndex(arrivals, arrivalsMedian);

    // -------------------------------------------------------------- business --
    // Country wealth says how commercial a place is likely to be; being a capital
    // or a first-order administrative seat says whether *this* city is where that
    // commerce sits. Without the second term every Dutch airport would look
    // equally like a business destination, and A.2's Affinity term needs to tell
    // AMS–LHR from AMS–PMI.
    const capitalInRange = allocation.cities.some((city) => city.featureCode === 'PPLC');
    const adminSeatInRange = allocation.cities.some((city) => city.featureCode.startsWith('PPLA'));
    const statusBonus = capitalInRange ? 1.4 : adminSeatInRange ? 1.15 : 1;
    const businessIndex = clamp(wealthIndex * statusBonus, INDEX_MIN, INDEX_MAX);

    const largestCity = allocation.cities.reduce<GeoNamesCity | null>(
      (best, city) => (best === null || city.population > best.population ? city : best),
      null,
    );

    return {
      airportId: airport.id,
      population,
      wealthIndex,
      tourismIndex,
      businessIndex,
      basis: {
        radiusKm: CATCHMENT_RADIUS_KM,
        citiesInRange: allocation.cities.length,
        rawPopulation: Math.round(allocation.raw),
        shareOfMetro: allocation.raw > 0 ? allocation.population / allocation.raw : 1,
        competingAirports: allocation.competitors,
        largestCity: largestCity?.name ?? null,
        capitalInRange,
        gdpPerCapita: gdp?.value ?? null,
        gdpYear: gdp?.year ?? null,
        arrivalsPerResident: arrivals ?? null,
        fallbacks,
      },
    };
  });
}
