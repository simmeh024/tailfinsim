import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readZipEntry } from '../zip';

/**
 * Where the catchment numbers come from (M1-03).
 *
 * Two public sources, both fetched at derivation time and checksummed into
 * `dataset_version` rather than committed — the same trade M1-01 made, for the
 * same reason: they are large, third-party and updated on someone else's
 * schedule, and a copy in git would be heavy and stale.
 *
 *   - **GeoNames `cities15000`** (CC BY 4.0) — ~30,000 settlements above 15,000
 *     people, with coordinates and population. This is what makes catchment a
 *     computed number rather than a guess.
 *   - **World Bank indicators** — GDP per capita and international tourist
 *     arrivals, by country and year.
 *
 * Country-level wealth and tourism is a real limitation and worth stating: it
 * means Rotterdam and Amsterdam get the same wealth multiplier. The alternative
 * is a per-city economic dataset, which does not exist in public domain at world
 * scale. The city-level signal comes from population and from administrative
 * status instead — see `derive.ts`.
 */

export const GEONAMES_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const GEONAMES_ENTRY = 'cities15000.txt';

/** World Bank indicator codes. */
export const INDICATORS = {
  /** GDP per capita, current US$. */
  gdpPerCapita: 'NY.GDP.PCAP.CD',
  /** International tourism, number of arrivals. */
  touristArrivals: 'ST.INT.ARVL',
  /** Population, total — the denominator that turns arrivals into a rate. */
  population: 'SP.POP.TOTL',
} as const;

export interface GeoNamesCity {
  geonameId: number;
  name: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  population: number;
  /** GeoNames feature code — `PPLC` is a national capital, `PPLA` a first-order admin seat. */
  featureCode: string;
}

/**
 * Parses the GeoNames tab-separated dump.
 *
 * Not CSV: the file is tab-separated with no quoting at all, so the CSV parser
 * would mangle any name containing a comma. Its columns are positional and
 * documented at https://download.geonames.org/export/dump/readme.txt.
 */
export function parseGeoNamesCities(text: string): GeoNamesCity[] {
  const cities: GeoNamesCity[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const f = line.split('\t');
    // 19 columns in the documented layout; anything shorter is not this file.
    if (f.length < 15) continue;

    const geonameId = Number.parseInt(f[0] ?? '', 10);
    const latitude = Number.parseFloat(f[4] ?? '');
    const longitude = Number.parseFloat(f[5] ?? '');
    const population = Number.parseInt(f[14] ?? '', 10);
    const countryCode = (f[8] ?? '').trim().toUpperCase();

    if (
      !Number.isFinite(geonameId) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(population) ||
      population <= 0 ||
      !/^[A-Z]{2}$/.test(countryCode)
    ) {
      continue;
    }

    cities.push({
      geonameId,
      name: (f[1] ?? '').trim(),
      latitude,
      longitude,
      countryCode,
      population,
      featureCode: (f[7] ?? '').trim(),
    });
  }

  if (cities.length === 0) throw new Error('GeoNames dump parsed to zero cities');
  return cities;
}

export interface CountryIndicator {
  /** ISO 3166-1 alpha-2. */
  country: string;
  value: number;
  year: number;
}

/**
 * Reads one World Bank indicator, keeping the most recent year each country has.
 *
 * Countries report on different schedules and many are years behind, so asking
 * for a single year would return nulls for a third of the world. Taking each
 * country's latest non-null observation is the only way to get usable coverage,
 * and the year is kept so the audit trail can show how stale a value is.
 */
export function parseWorldBankIndicator(json: unknown): Map<string, CountryIndicator> {
  if (!Array.isArray(json) || json.length < 2) {
    throw new Error('World Bank response was not the expected [meta, rows] pair');
  }
  const rows: unknown = json[1];
  if (!Array.isArray(rows)) throw new Error('World Bank response carried no rows');

  const latest = new Map<string, CountryIndicator>();

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const countryRaw = record.countryiso3code;
    const iso2 = (record.country as { id?: unknown } | undefined)?.id;
    const value = record.value;
    // `date` is a string year in this API, but the field is typed unknown — a
    // non-string means the response shape moved and the row is not usable.
    const rawYear = record.date;
    const year = typeof rawYear === 'string' ? Number.parseInt(rawYear, 10) : Number.NaN;

    // The `country.id` field is the alpha-2 code; countryiso3code is alpha-3.
    // Aggregates (EU, world, income bands) also appear here and are skipped by
    // the alpha-2 shape test below.
    const country = typeof iso2 === 'string' ? iso2.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    if (!Number.isFinite(year)) continue;
    void countryRaw;

    const existing = latest.get(country);
    if (!existing || year > existing.year) latest.set(country, { country, value, year });
  }

  if (latest.size === 0) throw new Error('World Bank indicator yielded no usable country values');
  return latest;
}

export interface CatchmentSources {
  cities: GeoNamesCity[];
  gdpPerCapita: Map<string, CountryIndicator>;
  touristArrivals: Map<string, CountryIndicator>;
  population: Map<string, CountryIndicator>;
  checksum: string;
}

async function fetchCached(
  url: string,
  cachePath: string | null,
  offline: boolean,
): Promise<Buffer> {
  if (offline) {
    if (!cachePath) throw new Error('offline mode requires a cacheDir');
    return readFileSync(cachePath);
  }
  if (cachePath && existsSync(cachePath)) return readFileSync(cachePath);

  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`GET ${url} failed with ${String(response.status)}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error(`GET ${url} returned an empty body`);
  if (cachePath) writeFileSync(cachePath, body);
  return body;
}

function worldBankUrl(indicator: string): string {
  // `mrnev=1` asks for the most recent non-empty value per country, which is
  // exactly the coverage problem described above — but it is not honoured by
  // every mirror, so the parser takes the latest year regardless.
  return `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&mrnev=1`;
}

export async function fetchCatchmentSources(
  options: { cacheDir?: string; offline?: boolean } = {},
): Promise<CatchmentSources> {
  const { cacheDir, offline = false } = options;
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  const path = (name: string): string | null => (cacheDir ? join(cacheDir, name) : null);
  const hash = createHash('sha256');

  const citiesZip = await fetchCached(GEONAMES_URL, path('cities15000.zip'), offline);
  hash.update(citiesZip);
  const cities = parseGeoNamesCities(readZipEntry(citiesZip, GEONAMES_ENTRY).toString('utf8'));

  const indicators: Record<keyof typeof INDICATORS, Map<string, CountryIndicator>> = {
    gdpPerCapita: new Map(),
    touristArrivals: new Map(),
    population: new Map(),
  };

  for (const key of Object.keys(INDICATORS) as (keyof typeof INDICATORS)[]) {
    const body = await fetchCached(
      worldBankUrl(INDICATORS[key]),
      path(`worldbank-${INDICATORS[key]}.json`),
      offline,
    );
    hash.update(body);
    indicators[key] = parseWorldBankIndicator(JSON.parse(body.toString('utf8')));
  }

  return {
    cities,
    gdpPerCapita: indicators.gdpPerCapita,
    touristArrivals: indicators.touristArrivals,
    population: indicators.population,
    checksum: hash.digest('hex'),
  };
}
