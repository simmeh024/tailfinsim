import { and, eq, inArray, sql } from 'drizzle-orm';

import { type Database } from '../../db/client';
import { airport, datasetVersion, runway } from '../../db/schema';
import { parseCsv } from '../csv';

import { type FetchedDataset } from './fetch';
import {
  normaliseAirports,
  normaliseRunways,
  type NormalisedAirport,
  type NormalisedRunway,
  type RejectedRow,
} from './normalise';
import {
  DEFAULT_SANITY_BOUNDS,
  formatCount,
  formatSanityReport,
  sanityCheck,
  type SanityBounds,
  type SanityReport,
} from './sanity';

/**
 * The OurAirports import (M1-01).
 *
 * One transaction. Either the whole dataset lands or none of it does — a
 * half-imported world map is worse than no world map, because everything
 * downstream would silently treat the gap as "no airport there".
 */

/**
 * How many rows go into one INSERT.
 *
 * Postgres caps a statement at 65,535 bound parameters. The airport insert binds
 * 17 columns, so 500 rows is ~8,500 parameters — comfortably clear of the limit
 * with room for the table to gain columns before anyone has to think about it
 * again.
 */
const BATCH_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ImportOptions {
  /** Re-import even when this exact checksum is already recorded. */
  force?: boolean;
  /**
   * Delete airports that have disappeared upstream.
   *
   * **Off by default, and the asymmetry with runways is deliberate.** Runways are
   * wholly-owned child data that nothing references, so they are kept in exact
   * sync. Airports are identity — routes, hubs, gates and flight history will all
   * point at them — and a mirror glitch that drops 10,000 rows for a day must not
   * quietly delete a player's hub. Removals are reported instead, and pruning is
   * a decision someone takes while looking at that number.
   */
  prune?: boolean;
  /**
   * Expected row counts. Defaults to the App. B.1 figures; the CLI never passes
   * anything else. Exists so a fixture dataset can state its own expectations
   * rather than the check having to be disabled to test anything.
   */
  sanityBounds?: SanityBounds;
  /** Progress and reporting sink. Defaults to stdout. */
  log?: (line: string) => void;
}

export interface ImportResult {
  skipped: boolean;
  checksum: string;
  version: string;
  airportsImported: number;
  runwaysImported: number;
  airportsWithoutRunwayData: number;
  scheduledServiceWithoutRunwayData: number;
  rejectedAirports: RejectedRow[];
  rejectedRunways: RejectedRow[];
  /** Present upstream last time, absent now. Deleted only when `prune` is set. */
  disappearedAirports: number;
  prunedAirports: number;
  removedRunways: number;
  sanity: SanityReport;
}

export class SanityCheckFailure extends Error {
  constructor(public readonly report: SanityReport) {
    super(
      `dataset failed ${String(report.failures.length)} sanity check(s): ` +
        report.failures.map((f) => f.label).join(', '),
    );
    this.name = 'SanityCheckFailure';
  }
}

export async function importOurAirports(
  db: Database,
  dataset: FetchedDataset,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const {
    force = false,
    prune = false,
    sanityBounds = DEFAULT_SANITY_BOUNDS,
    log = (line) => process.stdout.write(`${line}\n`),
  } = options;

  // --------------------------------------------------------------- parse ----

  log('Parsing…');
  const airportRows = parseCsv(dataset.files.airports);
  const runwayRows = parseCsv(dataset.files.runways);

  const airports = normaliseAirports(airportRows);
  const knownIdents = new Set(airports.rows.map((a) => a.ident));
  const runways = normaliseRunways(runwayRows, knownIdents);

  log(
    `  ${String(airports.rows.length)} airports (${String(airports.rejected.length)} rejected), ` +
      `${String(runways.rows.length)} runways (${String(runways.rejected.length)} rejected)`,
  );

  // ---------------------------------------------------------------- sanity ----

  const sanity = sanityCheck(airports.rows, runways.rows, sanityBounds);
  log('\nSanity checks against App. B.1:');
  log(formatSanityReport(sanity));
  if (!sanity.passed) throw new SanityCheckFailure(sanity);

  const identsWithRunways = new Set(runways.rows.map((r) => r.airportIdent));
  const withoutRunwayData = airports.rows.filter((a) => !identsWithRunways.has(a.ident));
  const scheduledWithoutRunwayData = withoutRunwayData.filter(
    (a) => a.scheduledService && a.kind !== 'closed',
  );

  // ---------------------------------------------------------------- write ----

  return db.transaction(async (tx) => {
    const already = await tx
      .select({ id: datasetVersion.id })
      .from(datasetVersion)
      .where(
        and(
          eq(datasetVersion.dataset, 'ourairports'),
          eq(datasetVersion.checksum, dataset.checksum),
        ),
      )
      .limit(1);

    if (already.length > 0 && !force) {
      log(
        `\nChecksum ${dataset.checksum.slice(0, 12)}… already imported — nothing to do (use --force).`,
      );
      return {
        skipped: true,
        checksum: dataset.checksum,
        version: dataset.version,
        airportsImported: 0,
        runwaysImported: 0,
        airportsWithoutRunwayData: withoutRunwayData.length,
        scheduledServiceWithoutRunwayData: scheduledWithoutRunwayData.length,
        rejectedAirports: airports.rejected,
        rejectedRunways: runways.rejected,
        disappearedAirports: 0,
        prunedAirports: 0,
        removedRunways: 0,
        sanity,
      };
    }

    log('\nWriting airports…');
    await upsertAirports(tx, airports.rows, identsWithRunways);

    log('Writing runways…');
    const airportIdByIdent = new Map(
      (await tx.select({ id: airport.id, ident: airport.ident }).from(airport)).map((row) => [
        row.ident,
        row.id,
      ]),
    );
    await upsertRunways(tx, runways.rows, airportIdByIdent);

    // Runways are kept in exact sync — see ImportOptions.prune for why airports
    // are not.
    const keptRunwayIds = runways.rows.map((r) => r.sourceId);
    const removedRunways = await removeMissing(tx, keptRunwayIds, 'runway');

    const importedSourceIds = new Set(airports.rows.map((a) => a.sourceId));
    const existing = await tx.select({ sourceId: airport.sourceId }).from(airport);
    const disappeared = existing.filter((row) => !importedSourceIds.has(row.sourceId));

    let prunedAirports = 0;
    if (prune && disappeared.length > 0) {
      prunedAirports = await removeMissing(tx, [...importedSourceIds], 'airport');
    }

    const rowCounts = {
      airports: airports.rows.length,
      runways: runways.rows.length,
      scheduledService: airports.rows.filter((a) => a.scheduledService && a.kind !== 'closed')
        .length,
      rejectedAirports: airports.rejected.length,
      rejectedRunways: runways.rejected.length,
    };

    await tx
      .insert(datasetVersion)
      .values({
        dataset: 'ourairports',
        version: dataset.version,
        sourceUrl: 'https://davidmegginson.github.io/ourairports-data',
        checksum: dataset.checksum,
        rowCounts: JSON.stringify(rowCounts),
      })
      .onConflictDoNothing();

    return {
      skipped: false,
      checksum: dataset.checksum,
      version: dataset.version,
      airportsImported: airports.rows.length,
      runwaysImported: runways.rows.length,
      airportsWithoutRunwayData: withoutRunwayData.length,
      scheduledServiceWithoutRunwayData: scheduledWithoutRunwayData.length,
      rejectedAirports: airports.rejected,
      rejectedRunways: runways.rejected,
      disappearedAirports: disappeared.length,
      prunedAirports,
      removedRunways,
      sanity,
    };
  });
}

// --------------------------------------------------------------- writers ----

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function upsertAirports(
  tx: Tx,
  rows: readonly NormalisedAirport[],
  identsWithRunways: ReadonlySet<string>,
): Promise<void> {
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await tx
      .insert(airport)
      .values(
        batch.map((a) => ({
          sourceId: a.sourceId,
          ident: a.ident,
          icaoCode: a.icaoCode,
          iataCode: a.iataCode,
          name: a.name,
          municipality: a.municipality,
          isoCountry: a.isoCountry,
          isoRegion: a.isoRegion,
          continent: a.continent,
          kind: a.kind,
          latitude: a.latitude,
          longitude: a.longitude,
          elevationFt: a.elevationFt,
          scheduledService: a.scheduledService,
          hasRunwayData: identsWithRunways.has(a.ident),
        })),
      )
      // On `source_id`, not `ident`: upstream corrects identifiers, and the row
      // id is the thing that actually identifies an airport across releases.
      .onConflictDoUpdate({
        target: airport.sourceId,
        set: {
          ident: sql`excluded.ident`,
          icaoCode: sql`excluded.icao_code`,
          iataCode: sql`excluded.iata_code`,
          name: sql`excluded.name`,
          municipality: sql`excluded.municipality`,
          isoCountry: sql`excluded.iso_country`,
          isoRegion: sql`excluded.iso_region`,
          continent: sql`excluded.continent`,
          kind: sql`excluded.kind`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          elevationFt: sql`excluded.elevation_ft`,
          scheduledService: sql`excluded.scheduled_service`,
          hasRunwayData: sql`excluded.has_runway_data`,
          updatedAt: sql`now()`,
        },
      });
  }
}

async function upsertRunways(
  tx: Tx,
  rows: readonly NormalisedRunway[],
  airportIdByIdent: ReadonlyMap<string, string>,
): Promise<void> {
  for (const batch of chunk(rows, BATCH_SIZE)) {
    const values = batch
      .map((r) => {
        const airportId = airportIdByIdent.get(r.airportIdent);
        return airportId === undefined
          ? null
          : {
              sourceId: r.sourceId,
              airportId,
              identifier: r.identifier,
              lengthFt: r.lengthFt,
              widthFt: r.widthFt,
              surfaceRaw: r.surfaceRaw,
              surface: r.surface,
              lighted: r.lighted,
              closed: r.closed,
            };
      })
      .filter((value) => value !== null);

    if (values.length === 0) continue;

    await tx
      .insert(runway)
      .values(values)
      .onConflictDoUpdate({
        target: runway.sourceId,
        set: {
          airportId: sql`excluded.airport_id`,
          identifier: sql`excluded.identifier`,
          lengthFt: sql`excluded.length_ft`,
          widthFt: sql`excluded.width_ft`,
          surfaceRaw: sql`excluded.surface_raw`,
          surface: sql`excluded.surface`,
          lighted: sql`excluded.lighted`,
          closed: sql`excluded.closed`,
        },
      });
  }
}

/**
 * Deletes rows whose `source_id` is not in the kept set.
 *
 * `NOT IN (…86,000 values)` would bind one parameter per value and blow the
 * statement limit, so the ids to delete are worked out in memory first and then
 * deleted in batches.
 */
async function removeMissing(
  tx: Tx,
  keptSourceIds: number[],
  table: 'airport' | 'runway',
): Promise<number> {
  const target = table === 'airport' ? airport : runway;
  const kept = new Set(keptSourceIds);

  const existing = await tx.select({ id: target.id, sourceId: target.sourceId }).from(target);
  const doomed = existing.filter((row) => !kept.has(row.sourceId)).map((row) => row.id);
  if (doomed.length === 0) return 0;

  for (const batch of chunk(doomed, BATCH_SIZE)) {
    await tx.delete(target).where(inArray(target.id, batch));
  }
  return doomed.length;
}

/** Convenience for the CLI: how a result reads in the log. */
export function formatImportResult(result: ImportResult): string {
  if (result.skipped) return 'Nothing imported — this dataset checksum was already recorded.';

  const lines = [
    `Imported ${formatCount(result.airportsImported)} airports and ${formatCount(result.runwaysImported)} runways.`,
    `  dataset version   ${result.version}`,
    `  checksum          ${result.checksum}`,
    `  no runway data    ${formatCount(result.airportsWithoutRunwayData)} airports ` +
      `(${String(result.scheduledServiceWithoutRunwayData)} of them with scheduled service)`,
  ];

  if (result.rejectedAirports.length > 0) {
    lines.push(`  rejected airports ${String(result.rejectedAirports.length)}`);
    for (const row of result.rejectedAirports.slice(0, 10))
      lines.push(`      ${row.key}: ${row.reason}`);
    if (result.rejectedAirports.length > 10)
      lines.push(`      … and ${String(result.rejectedAirports.length - 10)} more`);
  }
  if (result.rejectedRunways.length > 0) {
    lines.push(`  rejected runways  ${String(result.rejectedRunways.length)}`);
    for (const row of result.rejectedRunways.slice(0, 10))
      lines.push(`      ${row.key}: ${row.reason}`);
    if (result.rejectedRunways.length > 10)
      lines.push(`      … and ${String(result.rejectedRunways.length - 10)} more`);
  }
  if (result.removedRunways > 0)
    lines.push(`  removed runways   ${String(result.removedRunways)} (gone upstream)`);
  if (result.disappearedAirports > 0) {
    lines.push(
      result.prunedAirports > 0
        ? `  pruned airports   ${String(result.prunedAirports)} (gone upstream, --prune given)`
        : `  gone upstream     ${String(result.disappearedAirports)} airports kept — re-run with --prune to delete`,
    );
  }

  return lines.join('\n');
}
