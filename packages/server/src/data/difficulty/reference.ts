import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, type CsvRow } from '../csv';

/**
 * The committed list of known-difficult airports (M9-02, §10.2).
 *
 * See `data/reference/airport-difficulty.csv` for why it exists and what a
 * rating means. This is only the loader.
 *
 * Keyed on **ICAO**, unlike the tier lists' IATA. Every operational reference
 * in this schema keys on `airport.icao_code`, and several of the fields on this
 * list have no IATA code at all.
 */

/**
 * Finds `packages/server/data/reference`, whichever layout we are running in.
 *
 * Walks up rather than counting `..` hops, for the reason `classify/reference.ts`
 * records: from source this file is three levels below the package root, and
 * esbuild inlines it into a `dist/` bundle one level below. A fixed count is
 * right in exactly one of the two, and the wrong one fails only on the server.
 */
function findReferenceDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = resolve(dir, 'data', 'reference');
    if (existsSync(resolve(candidate, 'airport-difficulty.csv'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not find data/reference — expected it under packages/server. ' +
      'It is committed data, so a missing directory means an incomplete checkout.',
  );
}

/** Why an airport is on the list. Recorded so a rating can explain itself. */
export type DifficultyReason = 'terrain' | 'slope' | 'steep_approach';
const REASONS: readonly string[] = ['terrain', 'slope', 'steep_approach'];

export interface SeededDifficulty {
  rating: number;
  reason: DifficultyReason;
  note: string;
}

function readReferenceCsv(name: string): CsvRow[] {
  const text = readFileSync(resolve(findReferenceDir(), name), 'utf8');
  const body = text
    .split('\n')
    .filter((line) => !line.startsWith('#') && line.trim() !== '')
    .join('\n');
  return parseCsv(body);
}

/**
 * Load the list, refusing anything it cannot use.
 *
 * Throws rather than skipping a bad row, for the reason the tier loader does: a
 * silently dropped airport is a rating that quietly reverts to its geometry,
 * and nobody would notice until a route stopped paying what it used to.
 */
export function loadDifficultyReference(): Map<string, SeededDifficulty> {
  const seeded = new Map<string, SeededDifficulty>();
  for (const row of readReferenceCsv('airport-difficulty.csv')) {
    const icao = (row.icao ?? '').trim().toUpperCase();
    if (icao === '') continue;
    if (!/^[A-Z0-9]{4}$/.test(icao)) {
      throw new Error(`airport-difficulty.csv: ${JSON.stringify(icao)} is not an ICAO code`);
    }
    if (seeded.has(icao)) {
      // A duplicate is a merge accident, and keeping either one silently would
      // make a rating depend on file order.
      throw new Error(`airport-difficulty.csv: ${icao} listed twice`);
    }

    const rating = Number.parseFloat((row.rating ?? '').trim());
    if (!Number.isFinite(rating) || rating <= 0 || rating > 1) {
      throw new Error(
        `airport-difficulty.csv: ${icao} has unusable rating ${JSON.stringify(row.rating)} — ` +
          'expected a number above 0 and at most 1',
      );
    }

    const reason = (row.reason ?? '').trim();
    if (!REASONS.includes(reason)) {
      throw new Error(
        `airport-difficulty.csv: ${icao} has unusable reason ${JSON.stringify(reason)} — ` +
          `expected one of ${REASONS.join(', ')}`,
      );
    }

    seeded.set(icao, {
      rating,
      reason: reason as DifficultyReason,
      note: (row.note ?? '').trim(),
    });
  }
  return seeded;
}
