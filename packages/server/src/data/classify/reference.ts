import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, type CsvRow } from '../csv';

/**
 * The committed reference lists (M1-02).
 *
 * ## Why reference data at all
 *
 * Three of the five tiers are derived from runway geometry, which is a fair
 * proxy for "how big is this airfield". It is a poor proxy for "is this one of
 * the world's great hubs": a remote strip can be 13,000 ft long and see four
 * flights a week, while LGA is enormous in traffic and short in tarmac. Hub
 * status is a *traffic* fact and OurAirports carries no traffic figures, so the
 * top two tiers are seeded and the rest computed.
 *
 * The issue asks for "derived, reviewable data — not a hand-written list", and
 * in the same breath asks for Level 3 airports to be seeded "from a committed
 * reference list". Those are consistent: the *rule* must be uniform and
 * inspectable, the *inputs* may be sourced. What is ruled out is airport codes
 * scattered through the classifier.
 *
 * See the header of each CSV for its provenance and its known weaknesses.
 */

/**
 * Finds `packages/server/data/reference`, whichever layout we are running in.
 *
 * A fixed number of `..` hops does not work here. From source this file sits at
 * `src/data/classify/`, three levels below the package root — but esbuild inlines
 * it into `dist/classify-airports.js`, one level below. Counting hops is right in
 * exactly one of the two, and the wrong one fails only on the server.
 *
 * So walk up until the directory appears. Caught on the box, not in CI.
 */
function findReferenceDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = resolve(dir, 'data', 'reference');
    if (existsSync(resolve(candidate, 'airport-tiers.csv'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not find data/reference — expected it under packages/server. ' +
      'It is committed data, so a missing directory means an incomplete checkout.',
  );
}

const referenceDir = findReferenceDir();

export type SeededTier = 'flagship' | 'large';

export interface ReferenceLists {
  /** IATA code to seeded tier. */
  tiers: Map<string, SeededTier>;
  /** IATA code to slot level, overriding whatever the tier would imply. */
  slotLevels: Map<string, number>;
}

/**
 * Strips `#` comments and blank lines before parsing.
 *
 * The reference files carry their provenance in a comment header, which is the
 * whole point of them being reviewable — so the loader has to tolerate comments
 * that `parseCsv` knows nothing about.
 */
function readReferenceCsv(name: string): CsvRow[] {
  const text = readFileSync(resolve(referenceDir, name), 'utf8');
  const body = text
    .split('\n')
    .filter((line) => !line.startsWith('#') && line.trim() !== '')
    .join('\n');
  return parseCsv(body);
}

export function loadReferenceLists(): ReferenceLists {
  const tiers = new Map<string, SeededTier>();
  for (const row of readReferenceCsv('airport-tiers.csv')) {
    const iata = (row.iata ?? '').trim().toUpperCase();
    const tier = (row.tier ?? '').trim();
    if (iata === '') continue;
    if (tier !== 'flagship' && tier !== 'large') {
      throw new Error(`airport-tiers.csv: ${iata} has unusable tier ${JSON.stringify(tier)}`);
    }
    if (tiers.has(iata)) {
      // A duplicate is a merge accident, and silently keeping one of the two
      // would make the flagship count wrong in a way nobody would notice.
      throw new Error(`airport-tiers.csv: ${iata} listed twice`);
    }
    tiers.set(iata, tier);
  }

  const slotLevels = new Map<string, number>();
  for (const row of readReferenceCsv('slot-levels.csv')) {
    const iata = (row.iata ?? '').trim().toUpperCase();
    if (iata === '') continue;
    const level = Number.parseInt((row.level ?? '').trim(), 10);
    if (![1, 2, 3].includes(level)) {
      throw new Error(`slot-levels.csv: ${iata} has unusable level ${JSON.stringify(row.level)}`);
    }
    if (slotLevels.has(iata)) throw new Error(`slot-levels.csv: ${iata} listed twice`);
    slotLevels.set(iata, level);
  }

  return { tiers, slotLevels };
}
