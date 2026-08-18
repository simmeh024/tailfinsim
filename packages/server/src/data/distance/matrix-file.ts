import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DistanceMatrix, packedLength, type DistanceMatrixData } from '@tailfin/sim';

/**
 * The on-disk distance matrix (M1-04).
 *
 * Two files rather than one: a `.bin` of raw Float32 and a `.json` index map.
 * Splitting them means the 38 MB payload can be read straight into a
 * `Float32Array` with no parsing at all, and the small human-readable part stays
 * greppable — a single packed file with an embedded header would be faster to
 * write and much worse to debug.
 *
 * The file is **generated, not committed**: it is 38 MB and derived entirely from
 * the airport table, so a copy in git would be large and would go stale the
 * moment an import ran.
 */

export const MATRIX_BIN = 'distance-matrix.bin';
export const MATRIX_INDEX = 'distance-matrix-index.json';

export interface MatrixIndexFile {
  /** Airport identifiers in matrix order. */
  idents: string[];
  /** When it was built, so a stale matrix is visible rather than merely wrong. */
  builtAt: string;
  /** Guards against loading a matrix built from a different airport set. */
  entries: number;
}

/**
 * Where the generated matrix lives.
 *
 * Resolved by walking up for `package.json`, not by counting `..` hops — the
 * lesson from M1-02, where esbuild inlined a loader into `dist/` at a different
 * depth than its source and the fixed hop count worked in tests and failed on
 * the server.
 */
export function findGeneratedDir(startDir: string): string {
  let dir = startDir;
  for (let hop = 0; hop < 6; hop += 1) {
    if (existsSync(resolve(dir, 'package.json'))) return resolve(dir, 'data', 'generated');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find the package root above ${startDir}`);
}

export function writeMatrix(dir: string, data: DistanceMatrixData): { bytes: number } {
  mkdirSync(dir, { recursive: true });

  const index: MatrixIndexFile = {
    idents: [...data.idents],
    builtAt: new Date().toISOString(),
    entries: data.distances.length,
  };

  writeFileSync(resolve(dir, MATRIX_INDEX), `${JSON.stringify(index)}\n`);
  // `Buffer.from` over the underlying ArrayBuffer copies no data.
  const bytes = Buffer.from(
    data.distances.buffer,
    data.distances.byteOffset,
    data.distances.byteLength,
  );
  writeFileSync(resolve(dir, MATRIX_BIN), bytes);

  return { bytes: bytes.length };
}

/**
 * Loads the matrix, or returns null if it has not been built.
 *
 * Null rather than a throw: nothing depends on the matrix yet, and a server that
 * refused to boot without a generated artefact would make the first deploy after
 * this change fail for a feature nobody is using.
 */
export function readMatrix(dir: string): DistanceMatrix | null {
  const binPath = resolve(dir, MATRIX_BIN);
  const indexPath = resolve(dir, MATRIX_INDEX);
  if (!existsSync(binPath) || !existsSync(indexPath)) return null;

  const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as MatrixIndexFile).idents)
  ) {
    throw new Error(`${MATRIX_INDEX} is not a matrix index`);
  }
  const index = parsed as MatrixIndexFile;

  const raw = readFileSync(binPath);
  if (raw.byteLength % 4 !== 0) {
    throw new Error(
      `${MATRIX_BIN} is ${String(raw.byteLength)} bytes, not a whole number of floats`,
    );
  }

  const expected = packedLength(index.idents.length);
  const actual = raw.byteLength / 4;
  if (actual !== expected) {
    // The dangerous failure: a matrix built from one airport set read against
    // another. Every lookup would return a plausible wrong number, silently.
    throw new Error(
      `Distance matrix holds ${String(actual)} entries but its index names ` +
        `${String(index.idents.length)} airports, which needs ${String(expected)}. Rebuild it.`,
    );
  }

  // Copied rather than viewed: `readFileSync` may hand back a Buffer that is a
  // window into a larger pooled allocation, and a Float32Array view over that
  // would read neighbouring memory.
  const distances = new Float32Array(actual);
  for (let i = 0; i < actual; i += 1) distances[i] = raw.readFloatLE(i * 4);

  return new DistanceMatrix({ idents: index.idents, distances });
}
