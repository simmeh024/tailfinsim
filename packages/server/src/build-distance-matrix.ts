import { isNotNull } from 'drizzle-orm';

import { buildDistanceMatrix, DistanceMatrix, type MatrixPoint } from '@tailfin/sim';

import { findGeneratedDir, writeMatrix } from './data/distance/matrix-file';
import { createDatabase } from './db/client';
import { airport } from './db/schema';

/**
 * `node dist/build-distance-matrix.js` — packs the great-circle matrix (M1-04).
 *
 * Run after `import-airports` and `classify-airports`: the matrix covers the
 * scheduled-service subset, which is the set that has a tier.
 *
 * Checks its own acceptance criteria on the way out — build time, packed size
 * and the three sectors App. B.4 quotes — and exits non-zero if any of them
 * misses, because a matrix that is quietly wrong is worse than no matrix.
 */

const SPOT_CHECKS: { a: string; b: string; nm: number }[] = [
  { a: 'EHAM', b: 'EGLL', nm: 199 },
  { a: 'EHAM', b: 'KJFK', nm: 3157 },
  { a: 'EGLL', b: 'RJAA', nm: 5179 },
];

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_BUILD_MS = 60_000;

async function main(): Promise<void> {
  const db = createDatabase();
  try {
    const rows = await db.db
      .select({
        ident: airport.ident,
        latitude: airport.latitude,
        longitude: airport.longitude,
      })
      .from(airport)
      .where(isNotNull(airport.tier))
      // Ordered so the matrix is byte-identical between runs on the same data.
      // Without it Postgres may return rows in any order and the packed file
      // would differ every build for no reason.
      .orderBy(airport.ident);

    if (rows.length === 0) {
      throw new Error('No airports have a tier — run classify-airports first.');
    }

    const points: MatrixPoint[] = rows.map((row) => ({
      ident: row.ident,
      latitude: row.latitude,
      longitude: row.longitude,
    }));

    process.stdout.write(`Building a ${String(points.length)}-airport matrix…\n`);
    const started = Date.now();
    const data = buildDistanceMatrix(points);
    const elapsed = Date.now() - started;

    const dir = findGeneratedDir(process.cwd());
    const { bytes } = writeMatrix(dir, data);

    const matrix = new DistanceMatrix(data);
    const failures: string[] = [];

    process.stdout.write('\nAcceptance criteria:\n');
    const pass = (ok: boolean): string => (ok ? 'ok  ' : 'FAIL');

    const timeOk = elapsed < MAX_BUILD_MS;
    process.stdout.write(
      `  ${pass(timeOk)} builds in under 60s          ${String((elapsed / 1000).toFixed(2))}s\n`,
    );
    if (!timeOk) failures.push('build time');

    const sizeOk = bytes < MAX_BYTES;
    process.stdout.write(
      `  ${pass(sizeOk)} packed under 40MB           ${String((bytes / 1024 / 1024).toFixed(1))} MB\n`,
    );
    if (!sizeOk) failures.push('packed size');

    for (const check of SPOT_CHECKS) {
      const actual = matrix.distanceNm(check.a, check.b);
      if (actual === null) {
        process.stdout.write(`  FAIL ${check.a}-${check.b} not in the matrix\n`);
        failures.push(`${check.a}-${check.b}`);
        continue;
      }
      const drift = Math.abs(actual - check.nm) / check.nm;
      const ok = drift <= 0.01;
      process.stdout.write(
        `  ${pass(ok)} ${check.a}-${check.b} ~${String(check.nm)}nm      ` +
          `${String(actual.toFixed(1))} nm (${String((drift * 100).toFixed(2))}% out)\n`,
      );
      if (!ok) failures.push(`${check.a}-${check.b}`);
    }

    process.stdout.write(`\nWrote ${dir}\n`);

    if (failures.length > 0) {
      process.stderr.write(`\nFailed: ${failures.join(', ')}\n`);
      process.exit(3);
    }
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `\nMatrix build failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
