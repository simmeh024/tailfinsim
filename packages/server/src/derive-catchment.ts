import { resolve } from 'node:path';

import { applyCatchment, formatCatchmentResult } from './data/catchment/apply';
import { fetchCatchmentSources } from './data/catchment/sources';
import { createDatabase } from './db/client';

/**
 * `node dist/derive-catchment.js` — attaches the demand inputs (M1-03).
 *
 * M1-03 requires the derivation to be "committed and re-runnable". This is it.
 * Run it after `import-airports` and `classify-airports`: catchment is split
 * between an airport and its neighbours by tier weight, so the tiers have to
 * exist first. The script says so rather than producing a silently equal split.
 *
 *   --offline    read the sources from the cache instead of downloading
 *   --cache DIR  where to cache them (default: ./.cache/catchment)
 */

function parseArgs(argv: readonly string[]) {
  const args = { offline: false, cacheDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') args.offline = true;
    else if (arg === '--cache') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--cache needs a directory');
      args.cacheDir = next;
      i += 1;
    } else throw new Error(`unknown option: ${arg}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cacheDir =
    args.cacheDir === '' ? resolve(process.cwd(), '.cache', 'catchment') : args.cacheDir;

  const db = createDatabase();
  try {
    process.stdout.write(
      `Fetching GeoNames and World Bank sources${args.offline ? ' (offline)' : ''}…\n`,
    );
    const sources = await fetchCatchmentSources({ cacheDir, offline: args.offline });

    const result = await applyCatchment(db.db, sources);
    process.stdout.write(`\n${formatCatchmentResult(result)}\n`);
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `\nCatchment derivation failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
