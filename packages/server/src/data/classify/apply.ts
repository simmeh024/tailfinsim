import { eq, sql } from 'drizzle-orm';

import { type Database } from '../../db/client';
import { airport, runway } from '../../db/schema';

import { loadReferenceLists } from './reference';
import { classifyAirport, type AirportTier, type ClassifiableAirport } from './tier';

/**
 * Running the classifier over the whole airport table (M1-02).
 *
 * One transaction, like the import: a half-classified world would leave some
 * airports with a stale tier and no way to tell which.
 */

const BATCH_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** App. B.3's counts, and the tolerance the acceptance criterion allows. */
export const B3_TARGETS: Record<AirportTier, number> = {
  flagship: 25,
  large: 120,
  medium: 500,
  small: 1_200,
  regional: 2_200,
};
export const B3_TOLERANCE = 0.2;

export interface DistributionCheck {
  tier: AirportTier;
  actual: number;
  target: number;
  min: number;
  max: number;
  passed: boolean;
}

export function checkDistribution(counts: Record<AirportTier, number>): DistributionCheck[] {
  return (Object.keys(B3_TARGETS) as AirportTier[]).map((tier) => {
    const target = B3_TARGETS[tier];
    const min = Math.floor(target * (1 - B3_TOLERANCE));
    const max = Math.ceil(target * (1 + B3_TOLERANCE));
    const actual = counts[tier];
    return { tier, actual, target, min, max, passed: actual >= min && actual <= max };
  });
}

export interface ClassifyResult {
  classified: number;
  counts: Record<AirportTier, number>;
  untiered: number;
  distribution: DistributionCheck[];
  /** Named airports App. B.3 requires in the flagship tier, and whether they are. */
  namedFlagships: { iata: string; tier: AirportTier | null }[];
}

/** B.3 names these as flagship; the acceptance criterion turns that into a test. */
export const B3_NAMED_FLAGSHIPS = [
  'LHR',
  'JFK',
  'DXB',
  'HND',
  'NRT',
  'CDG',
  'SIN',
  'LAX',
  'HKG',
  'AMS',
  'FRA',
];

export async function classifyAirports(
  db: Database,
  options: { log?: (line: string) => void } = {},
): Promise<ClassifyResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const reference = loadReferenceLists();

  log(
    `Reference: ${String(reference.tiers.size)} seeded tiers, ` +
      `${String(reference.slotLevels.size)} slot overrides`,
  );

  return db.transaction(async (tx) => {
    // One pass over every airport with its runway summary. 86,000 rows of five
    // small columns is a few MB — cheaper than 86,000 round trips.
    const rows = await tx
      .select({
        id: airport.id,
        ident: airport.ident,
        iataCode: airport.iataCode,
        isoCountry: airport.isoCountry,
        kind: sql<string>`${airport.kind}::text`,
        scheduledService: airport.scheduledService,
        longestRunwayFt: sql<
          number | null
        >`max(${runway.lengthFt}) filter (where not ${runway.closed})`,
        openRunways: sql<number>`count(${runway.id}) filter (where not ${runway.closed})::int`,
      })
      .from(airport)
      .leftJoin(runway, eq(runway.airportId, airport.id))
      .groupBy(
        airport.id,
        airport.ident,
        airport.iataCode,
        airport.isoCountry,
        airport.kind,
        airport.scheduledService,
      );

    log(`Classifying ${String(rows.length)} airports…`);

    const counts: Record<AirportTier, number> = {
      flagship: 0,
      large: 0,
      medium: 0,
      small: 0,
      regional: 0,
    };
    let untiered = 0;

    const updates = rows.map((row) => {
      const input: ClassifiableAirport = {
        ident: row.ident,
        iataCode: row.iataCode,
        isoCountry: row.isoCountry,
        kind: row.kind,
        scheduledService: row.scheduledService,
        longestRunwayFt: row.longestRunwayFt,
        openRunways: row.openRunways,
      };
      const result = classifyAirport(input, reference);
      if (result.tier === null) untiered += 1;
      else counts[result.tier] += 1;
      return { id: row.id, iataCode: row.iataCode, ...result };
    });

    // Updated with a single statement per batch rather than one per airport:
    // 86,000 UPDATEs inside one transaction is minutes, a batched VALUES join is
    // seconds.
    for (const batch of chunk(updates, BATCH_SIZE)) {
      const values = sql.join(
        batch.map(
          (u) =>
            sql`(${u.id}::uuid, ${u.tier}::airport_tier, ${u.slotLevel}::integer, ${JSON.stringify(u.basis)}::text)`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        update ${airport} as a
        set tier = v.tier, slot_level = v.slot_level, tier_basis = v.tier_basis, classified_at = now()
        from (values ${values}) as v(id, tier, slot_level, tier_basis)
        where a.id = v.id
      `);
    }

    const byIata = new Map(
      updates.filter((u) => u.iataCode !== null).map((u) => [u.iataCode, u.tier]),
    );
    const namedFlagships = B3_NAMED_FLAGSHIPS.map((iata) => ({
      iata,
      tier: byIata.get(iata) ?? null,
    }));

    return {
      classified: updates.length,
      counts,
      untiered,
      distribution: checkDistribution(counts),
      namedFlagships,
    };
  });
}

export function formatClassifyResult(result: ClassifyResult): string {
  const lines = [
    `Classified ${result.classified.toLocaleString('en-US')} airports ` +
      `(${result.untiered.toLocaleString('en-US')} untiered — no scheduled service).`,
    '',
    'Distribution against App. B.3:',
  ];

  for (const d of result.distribution) {
    lines.push(
      `  ${d.passed ? 'ok  ' : 'FAIL'} ${d.tier.padEnd(9)} ${String(d.actual).padStart(6)}   ` +
        `target ${String(d.target)} (${String(d.min)}–${String(d.max)})`,
    );
  }

  const missing = result.namedFlagships.filter((f) => f.tier !== 'flagship');
  lines.push('');
  lines.push(
    missing.length === 0
      ? `  ok   all ${String(result.namedFlagships.length)} airports B.3 names as flagship are flagship`
      : `  FAIL named-but-not-flagship: ${missing.map((f) => `${f.iata}=${String(f.tier)}`).join(', ')}`,
  );

  return lines.join('\n');
}
