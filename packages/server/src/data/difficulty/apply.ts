import { eq, sql } from 'drizzle-orm';

import { type Database } from '../../db/client';
import { airport, runway } from '../../db/schema';

import { rateAirport, type DifficultyRating } from './rating';
import { loadDifficultyReference } from './reference';

/**
 * Rating every airport's difficulty (M9-02, §10.2).
 *
 * One transaction and one pass, like the tier classifier it is modelled on: a
 * half-rated world would leave some airports paying XP on a stale number with
 * no way to tell which.
 *
 * Reproducible. It is a pure function of the airport and runway tables plus one
 * committed CSV, so running it twice gives the same answer — which is what
 * makes M9-02's third acceptance criterion (*"XP is deterministic given the
 * flight and its conditions"*) hold at the far end, since a rating is one of
 * those conditions.
 */

const BATCH_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface DifficultyResult {
  rated: number;
  /** Of those, how many the reference list decided. */
  fromReference: number;
  /** Reference entries that matched no airport in the table. */
  unmatched: string[];
  /** How the ratings came out, in bands, for a sanity read. */
  bands: { label: string; from: number; to: number; count: number }[];
  /** The hardest fields, for the operator to eyeball. */
  hardest: { icao: string; name: string; difficulty: number; source: string }[];
}

/** Bands for the distribution read. Not thresholds — nothing keys on them. */
const BANDS: readonly { label: string; from: number; to: number }[] = [
  { label: 'ordinary', from: 0, to: 0.15 },
  { label: 'demanding', from: 0.15, to: 0.45 },
  { label: 'hard', from: 0.45, to: 0.75 },
  { label: 'extreme', from: 0.75, to: 1.0001 },
];

export async function rateAirportDifficulty(
  db: Database,
  options: { log?: (line: string) => void } = {},
): Promise<DifficultyResult> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const seeded = loadDifficultyReference();
  log(`Reference: ${String(seeded.size)} seeded difficult airports`);

  return db.transaction(async (tx) => {
    /*
     * One pass with the runway summary joined, for the reason the classifier
     * does it this way: 86,000 rows of four small columns is a few megabytes,
     * and 86,000 round trips is not.
     *
     * `filter (where not closed)` — a closed runway is still geography but
     * cannot be landed on, so it must not make a field look longer than it is.
     */
    const rows = await tx
      .select({
        id: airport.id,
        icaoCode: airport.icaoCode,
        name: airport.name,
        elevationFt: airport.elevationFt,
        longestRunwayFt: sql<
          number | null
        >`max(${runway.lengthFt}) filter (where not ${runway.closed})`,
      })
      .from(airport)
      .leftJoin(runway, eq(runway.airportId, airport.id))
      .groupBy(airport.id, airport.icaoCode, airport.name, airport.elevationFt);

    log(`Rating ${String(rows.length)} airports…`);

    const matched = new Set<string>();
    const updates = rows.map((row) => {
      const icao = row.icaoCode;
      const entry = icao === null ? null : (seeded.get(icao) ?? null);
      if (entry !== null && icao !== null) matched.add(icao);

      const rating = rateAirport(
        { longestRunwayFt: row.longestRunwayFt, elevationFt: row.elevationFt },
        entry,
      );
      return { id: row.id, icao, name: row.name, rating };
    });

    for (const batch of chunk(updates, BATCH_SIZE)) {
      const values = sql.join(
        batch.map(
          (u) =>
            sql`(${u.id}::uuid, ${u.rating.difficulty}::double precision, ${JSON.stringify(basisOf(u.rating))}::text)`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        update ${airport} as a
        set difficulty = v.difficulty,
            difficulty_basis = v.difficulty_basis,
            difficulty_rated_at = now()
        from (values ${values}) as v(id, difficulty, difficulty_basis)
        where a.id = v.id
      `);
    }

    /*
     * A reference entry that matched nothing is reported rather than ignored.
     * A typo in an ICAO code is the one failure this file cannot detect any
     * other way — the rating simply never applies, and the airport goes on
     * paying flat XP while the CSV says otherwise.
     */
    const unmatched = [...seeded.keys()].filter((icao) => !matched.has(icao)).sort();

    const bands = BANDS.map((band) => ({
      ...band,
      count: updates.filter(
        (u) => u.rating.difficulty >= band.from && u.rating.difficulty < band.to,
      ).length,
    }));

    const hardest = updates
      .filter((u) => u.icao !== null)
      .sort((a, b) => b.rating.difficulty - a.rating.difficulty)
      .slice(0, 15)
      .map((u) => ({
        icao: u.icao ?? '????',
        name: u.name,
        difficulty: u.rating.difficulty,
        source: u.rating.source,
      }));

    return {
      rated: updates.length,
      fromReference: updates.filter((u) => u.rating.source === 'seeded').length,
      unmatched,
      bands,
      hardest,
    };
  });
}

/**
 * The audit trail, in the shape `tier_basis` established.
 *
 * The rule that fired *and* the numbers it fired on, so a surprising rating can
 * be explained without re-deriving it — and so changing a threshold produces a
 * visible diff rather than a silent reshuffle.
 */
function basisOf(rating: DifficultyRating): Record<string, unknown> {
  return {
    difficulty: rating.difficulty,
    source: rating.source,
    derived: rating.derived,
    seeded: rating.seeded,
    terms: { runway: rating.runwayTerm, elevation: rating.elevationTerm },
    reason: rating.reason,
  };
}

export function formatDifficultyResult(result: DifficultyResult): string {
  const lines = [
    `Rated ${result.rated.toLocaleString('en-US')} airports ` +
      `(${result.fromReference.toLocaleString('en-US')} decided by the reference list).`,
    '',
    'Distribution:',
  ];
  for (const band of result.bands) {
    lines.push(
      `  ${band.label.padEnd(10)} ${String(band.count).padStart(6)}   ` +
        `${band.from.toFixed(2)}–${Math.min(1, band.to).toFixed(2)}`,
    );
  }

  lines.push('', 'Hardest fields:');
  for (const row of result.hardest) {
    lines.push(
      `  ${row.difficulty.toFixed(2)}  ${row.icao}  ${row.name.slice(0, 46).padEnd(46)} ${row.source}`,
    );
  }

  lines.push('');
  lines.push(
    result.unmatched.length === 0
      ? `  ok   every reference entry matched an airport`
      : `  WARN reference entries matching no airport: ${result.unmatched.join(', ')}`,
  );

  return lines.join('\n');
}
