/**
 * Which timezone an airport is in (M3-04a).
 *
 * OurAirports does not say. Its 14 columns carry position, codes, elevation and
 * country, and nothing about time. GeoNames does say — the `cities15000` dump
 * already downloaded for the catchment derivation (M1-03) carries an IANA zone
 * name per city in field 17, which `parseGeoNamesCities` used to discard.
 *
 * So an airport takes the timezone of the nearest city, which is the honest
 * version of the question anyway: an aerodrome is in whatever zone the place it
 * serves is in.
 *
 * ## Why nearest city rather than a longitude band
 *
 * Because the whole point is the cases longitude gets wrong, and they are all
 * cases where the boundary is political rather than geometric:
 *
 * - **Mainland Spain** sits around 4°W, which is UTC−0 by longitude and UTC+1
 *   in fact. A band would also fail to separate it from the Canaries, which
 *   really are UTC+0 — and the nearest city does, because the nearest city to a
 *   Canary airport is in the Canaries.
 * - **China** spans five geometric zones and observes one.
 * - **India** and **Nepal** are on half- and three-quarter-hour offsets that no
 *   band can express.
 *
 * ## Recording how, not just what
 *
 * Every airport records which of the three routes decided it, the same way
 * `airport.tier_basis` records how a tier was reached. A resolution that fell
 * through to the longitude approximation is a different quality of answer from
 * one decided by a city 8 km away, and a figure whose provenance cannot be
 * inspected is the dead end §14.1 forbids.
 */

import { approximateUtcOffsetMinutes } from '@tailfin/sim';

import { distanceKm } from '../catchment/derive';

import { isKnownTimeZone, standardOffsetMinutes } from './offset';

import type { GeoNamesCity } from '../catchment/sources';

/**
 * How far a city may be and still decide an airport's timezone.
 *
 * Generous on purpose. A zone boundary is hundreds of kilometres wide in most
 * of the world, so a city 200 km away is nearly always in the same zone — and
 * the alternative for a remote field is not a better answer, it is the country
 * fallback. The risk of reaching too far is a wrong zone near a border; the
 * risk of not reaching far enough is a wrong zone everywhere remote.
 */
export const NEAREST_CITY_RADIUS_KM = 250;

/** Degrees per grid cell. Comfortably wider than the radius at any latitude used. */
const CELL_SIZE_DEG = 2;

/** How each airport's zone was decided. */
export type TimezoneBasis = 'nearest-city' | 'country' | 'longitude';

export interface TimezoneAirport {
  id: string;
  latitude: number;
  longitude: number;
  isoCountry: string;
}

export interface ResolvedTimezone {
  airportId: string;
  /** The IANA name, or null when nothing better than longitude was available. */
  timezone: string | null;
  /** Standard-time offset in minutes east of UTC. Never null — there is always a fallback. */
  utcOffsetMinutes: number;
  basis: TimezoneBasis;
  /** How far away the deciding city was, when one decided it. */
  distanceKm: number | null;
}

/**
 * The dominant zone in each country, by the population living in it.
 *
 * Population-weighted rather than by city count, because a country's zones are
 * rarely evenly populated: nearly everyone in Indonesia is in the western zone,
 * and counting towns would give the eastern one more weight than it deserves.
 */
export function dominantZoneByCountry(cities: readonly GeoNamesCity[]): Map<string, string> {
  const byCountry = new Map<string, Map<string, number>>();

  for (const city of cities) {
    if (city.timezone === '' || !isKnownTimeZone(city.timezone)) continue;
    const zones = byCountry.get(city.countryCode) ?? new Map<string, number>();
    zones.set(city.timezone, (zones.get(city.timezone) ?? 0) + city.population);
    byCountry.set(city.countryCode, zones);
  }

  const dominant = new Map<string, string>();
  for (const [country, zones] of byCountry) {
    let best = '';
    let bestPopulation = -1;
    // Sorted before comparing so a tie resolves the same way on every run —
    // Map iteration order is insertion order, which depends on how the dump
    // happened to be sorted, and that is not a thing to make an import depend on.
    for (const [zone, population] of [...zones].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (population > bestPopulation) {
        best = zone;
        bestPopulation = population;
      }
    }
    if (best !== '') dominant.set(country, best);
  }

  return dominant;
}

interface Cell {
  cities: GeoNamesCity[];
}

function cellKey(latitude: number, longitude: number): string {
  return `${String(Math.floor(latitude / CELL_SIZE_DEG))}:${String(Math.floor(longitude / CELL_SIZE_DEG))}`;
}

/**
 * Assign every airport a timezone and a standard offset.
 *
 * Nearest city inside {@link NEAREST_CITY_RADIUS_KM}, else the country's
 * dominant zone, else longitude ÷ 15 — which is the approximation this whole
 * module exists to stop relying on, kept only so that no airport is left
 * without an answer.
 */
export function resolveTimezones(
  airports: readonly TimezoneAirport[],
  cities: readonly GeoNamesCity[],
): ResolvedTimezone[] {
  // Bucket the cities rather than the airports: there are far fewer of them,
  // and each airport then reads a handful of cells instead of the whole list.
  const grid = new Map<string, Cell>();
  for (const city of cities) {
    if (city.timezone === '') continue;
    const key = cellKey(city.latitude, city.longitude);
    const cell = grid.get(key);
    if (cell) cell.cities.push(city);
    else grid.set(key, { cities: [city] });
  }

  const dominant = dominantZoneByCountry(cities);
  // One `Intl` construction per zone rather than per airport: there are a few
  // hundred zones and tens of thousands of airports.
  const offsets = new Map<string, number>();
  const offsetFor = (zone: string): number => {
    const known = offsets.get(zone);
    if (known !== undefined) return known;
    const computed = standardOffsetMinutes(zone);
    offsets.set(zone, computed);
    return computed;
  };

  const span = Math.ceil(NEAREST_CITY_RADIUS_KM / 111 / CELL_SIZE_DEG) + 1;
  const resolved: ResolvedTimezone[] = [];

  for (const airport of airports) {
    let nearest: { city: GeoNamesCity; km: number } | null = null;

    const latCell = Math.floor(airport.latitude / CELL_SIZE_DEG);
    const lonCell = Math.floor(airport.longitude / CELL_SIZE_DEG);
    for (let dLat = -span; dLat <= span; dLat += 1) {
      for (let dLon = -span; dLon <= span; dLon += 1) {
        const cell = grid.get(`${String(latCell + dLat)}:${String(lonCell + dLon)}`);
        if (!cell) continue;
        for (const city of cell.cities) {
          const km = distanceKm(airport.latitude, airport.longitude, city.latitude, city.longitude);
          if (km > NEAREST_CITY_RADIUS_KM) continue;
          // Ties broken by name so the result does not depend on file order.
          if (
            nearest === null ||
            km < nearest.km ||
            (km === nearest.km && city.name.localeCompare(nearest.city.name) < 0)
          ) {
            nearest = { city, km };
          }
        }
      }
    }

    if (nearest !== null && isKnownTimeZone(nearest.city.timezone)) {
      resolved.push({
        airportId: airport.id,
        timezone: nearest.city.timezone,
        utcOffsetMinutes: offsetFor(nearest.city.timezone),
        basis: 'nearest-city',
        distanceKm: Math.round(nearest.km * 10) / 10,
      });
      continue;
    }

    const countryZone = dominant.get(airport.isoCountry);
    if (countryZone !== undefined) {
      resolved.push({
        airportId: airport.id,
        timezone: countryZone,
        utcOffsetMinutes: offsetFor(countryZone),
        basis: 'country',
        distanceKm: null,
      });
      continue;
    }

    resolved.push({
      airportId: airport.id,
      timezone: null,
      utcOffsetMinutes: approximateUtcOffsetMinutes(airport.longitude),
      basis: 'longitude',
      distanceKm: null,
    });
  }

  return resolved;
}

/** What a run resolved, for the operator running it. */
export interface TimezoneSummary {
  total: number;
  byBasis: Record<TimezoneBasis, number>;
  /** The furthest a deciding city was from its airport — a smell test for the radius. */
  furthestCityKm: number;
}

export function summarise(resolved: readonly ResolvedTimezone[]): TimezoneSummary {
  const byBasis: Record<TimezoneBasis, number> = {
    'nearest-city': 0,
    country: 0,
    longitude: 0,
  };
  let furthest = 0;

  for (const row of resolved) {
    byBasis[row.basis] += 1;
    if (row.distanceKm !== null && row.distanceKm > furthest) furthest = row.distanceKm;
  }

  return { total: resolved.length, byBasis, furthestCityKm: furthest };
}
