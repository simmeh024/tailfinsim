/**
 * Write resolved timezones onto the airport table (M3-04a).
 *
 * Follows the same shape as `catchment/apply.ts`: read the airports, resolve in
 * memory, write back in one statement per batch. The bulk update is a `VALUES`
 * join rather than a statement per row because there are tens of thousands of
 * airports and 86,000 round trips is a different kind of slow.
 */

import { sql } from 'drizzle-orm';

import { airport } from '../../db/schema';

import {
  resolveTimezones,
  summarise,
  type TimezoneSummary,
  type ResolvedTimezone,
} from './resolve';

import type { Database } from '../../db/client';
import type { GeoNamesCity } from '../catchment/sources';

/** How many rows go into one `VALUES` list. */
const BATCH = 1_000;

export interface ApplyTimezoneResult extends TimezoneSummary {
  updated: number;
}

/**
 * Resolve and store a timezone for every airport.
 *
 * Every airport, not only the tiered ones — a timezone is a fact about where a
 * place is, not about whether anybody flies there, and scoping it to the
 * classified set would mean re-running this whenever tiers change.
 */
export async function applyTimezones(
  db: Database,
  cities: readonly GeoNamesCity[],
): Promise<ApplyTimezoneResult> {
  const airports = await db
    .select({
      id: airport.id,
      latitude: airport.latitude,
      longitude: airport.longitude,
      isoCountry: airport.isoCountry,
    })
    .from(airport);

  const resolved = resolveTimezones(airports, cities);
  let updated = 0;

  for (let start = 0; start < resolved.length; start += BATCH) {
    updated += await writeBatch(db, resolved.slice(start, start + BATCH));
  }

  return { ...summarise(resolved), updated };
}

async function writeBatch(db: Database, rows: readonly ResolvedTimezone[]): Promise<number> {
  if (rows.length === 0) return 0;

  const values = sql.join(
    rows.map(
      (row) =>
        sql`(${row.airportId}::uuid, ${row.timezone}::text, ${row.utcOffsetMinutes}::integer, ${row.basis}::text)`,
    ),
    sql`, `,
  );

  await db.execute(sql`
    update ${airport} as a
    set timezone = v.timezone,
        utc_offset_minutes = v.utc_offset_minutes,
        timezone_basis = v.timezone_basis
    from (values ${values}) as v(id, timezone, utc_offset_minutes, timezone_basis)
    where a.id = v.id
  `);

  return rows.length;
}

export function formatTimezoneResult(result: ApplyTimezoneResult): string {
  const share = (n: number) =>
    result.total === 0 ? '0%' : `${((n / result.total) * 100).toFixed(1)}%`;

  return [
    `${String(result.updated)} airports given a timezone`,
    `  nearest city  ${String(result.byBasis['nearest-city']).padStart(6)}  ${share(result.byBasis['nearest-city'])}`,
    `  country       ${String(result.byBasis.country).padStart(6)}  ${share(result.byBasis.country)}`,
    `  longitude     ${String(result.byBasis.longitude).padStart(6)}  ${share(result.byBasis.longitude)}`,
    `  furthest deciding city: ${String(result.furthestCityKm)} km`,
  ].join('\n');
}
