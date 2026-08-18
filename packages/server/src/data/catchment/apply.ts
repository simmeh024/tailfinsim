import { isNotNull, sql } from 'drizzle-orm';

import { type Database } from '../../db/client';
import { airport, datasetVersion } from '../../db/schema';

import { deriveConnectivity } from './connectivity';
import { deriveCatchment, type CatchmentAirport } from './derive';
import { type CatchmentSources } from './sources';

/**
 * Writing catchment onto the airport table (M1-03).
 *
 * One transaction, like the import and the classifier. Half a world with demand
 * inputs and half without would be worse than none, because everything
 * downstream would read the missing half as "nobody lives there".
 */

const BATCH_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface CatchmentRunResult {
  airports: number;
  citiesUsed: number;
  countriesWithGdp: number;
  countriesWithTourism: number;
  /** Airports that fell back on a default for at least one value. */
  withFallbacks: number;
  populationFloored: number;
  /** Multi-airport metros found — airports sharing at least one city. */
  sharingCatchment: number;
  /** Airports that gained a proximity boost. */
  connectivityBoosted: number;
  checksum: string;
  samples: { ident: string; population: number; share: number }[];
}

/** Metros App. M1-03 names as the cases that must split rather than double-count. */
export const NAMED_MULTI_AIRPORT_CITIES = ['LON', 'NYC', 'TYO', 'PAR', 'MOW'];

export async function applyCatchment(
  db: Database,
  sources: CatchmentSources,
  options: { log?: (line: string) => void } = {},
): Promise<CatchmentRunResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  log(
    `Sources: ${String(sources.cities.length)} cities, ` +
      `${String(sources.gdpPerCapita.size)} countries with GDP, ` +
      `${String(sources.touristArrivals.size)} with tourism`,
  );

  return db.transaction(async (tx) => {
    // Only the scheduled-service subset gets catchment, for the same reason it
    // is the only subset with a tier: it is the only one with a demand pool.
    const rows = await tx
      .select({
        id: airport.id,
        ident: airport.ident,
        iataCode: airport.iataCode,
        latitude: airport.latitude,
        longitude: airport.longitude,
        isoCountry: airport.isoCountry,
        tier: airport.tier,
      })
      .from(airport)
      .where(isNotNull(airport.tier));

    if (rows.length === 0) {
      throw new Error(
        'No airports have a tier — run classify-airports before deriving catchment. ' +
          'Catchment is split by tier weight, so it cannot be computed first.',
      );
    }

    const airports: CatchmentAirport[] = rows.map((row) => ({
      id: row.id,
      ident: row.ident,
      latitude: row.latitude,
      longitude: row.longitude,
      isoCountry: row.isoCountry,
      tier: row.tier!,
    }));

    log(`Deriving catchment for ${String(airports.length)} airports…`);

    const connectivity = deriveConnectivity(airports);

    const results = deriveCatchment({
      airports,
      cities: sources.cities,
      gdpPerCapita: sources.gdpPerCapita,
      touristArrivals: sources.touristArrivals,
      countryPopulation: sources.population,
    });

    for (const batch of chunk(results, BATCH_SIZE)) {
      const values = sql.join(
        batch.map(
          (r) =>
            sql`(${r.airportId}::uuid, ${r.population}::bigint, ${r.wealthIndex.toFixed(4)}::numeric,
                 ${r.tourismIndex.toFixed(4)}::numeric, ${r.businessIndex.toFixed(4)}::numeric,
                 ${JSON.stringify({ ...r.basis, connectivity: connectivity.get(r.airportId) })}::text,
                 ${(connectivity.get(r.airportId)?.index ?? 1).toFixed(4)}::numeric)`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        update ${airport} as a
        set catchment_population = v.population,
            wealth_index = v.wealth,
            tourism_index = v.tourism,
            business_index = v.business,
            catchment_basis = v.basis,
            connectivity_index = v.connectivity,
            catchment_at = now()
        from (values ${values}) as v(id, population, wealth, tourism, business, basis, connectivity)
        where a.id = v.id
      `);
    }

    await tx
      .insert(datasetVersion)
      .values({
        dataset: 'catchment',
        version: new Date().toISOString().slice(0, 10),
        sourceUrl: 'https://download.geonames.org + https://api.worldbank.org',
        checksum: sources.checksum,
        rowCounts: JSON.stringify({
          airports: results.length,
          cities: sources.cities.length,
          countriesWithGdp: sources.gdpPerCapita.size,
        }),
      })
      .onConflictDoNothing();

    const byIdent = new Map(rows.map((row) => [row.id, row]));

    return {
      airports: results.length,
      citiesUsed: sources.cities.length,
      countriesWithGdp: sources.gdpPerCapita.size,
      countriesWithTourism: sources.touristArrivals.size,
      withFallbacks: results.filter((r) => r.basis.fallbacks.length > 0).length,
      populationFloored: results.filter((r) => r.basis.fallbacks.some((f) => f.includes('floored')))
        .length,
      sharingCatchment: results.filter((r) => r.basis.competingAirports > 0).length,
      connectivityBoosted: [...connectivity.values()].filter((c) => c.index > 1).length,
      checksum: sources.checksum,
      samples: results
        .filter((r) => r.basis.competingAirports > 0)
        .slice(0, 5)
        .map((r) => ({
          ident: byIdent.get(r.airportId)?.ident ?? '?',
          population: r.population,
          share: r.basis.shareOfMetro,
        })),
    };
  });
}

export function formatCatchmentResult(result: CatchmentRunResult): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  return [
    `Catchment written for ${n(result.airports)} airports.`,
    `  cities considered   ${n(result.citiesUsed)}`,
    `  countries with GDP  ${n(result.countriesWithGdp)}`,
    `  countries w/tourism ${n(result.countriesWithTourism)}`,
    `  sharing a metro     ${n(result.sharingCatchment)} airports split their catchment`,
    `  proximity boost     ${n(result.connectivityBoosted)} airports have a neighbour within 15 km`,
    `  used a fallback     ${n(result.withFallbacks)} (${n(result.populationFloored)} had no city within radius)`,
    `  checksum            ${result.checksum}`,
  ].join('\n');
}
