import { resolve } from 'node:path';

import { fetchDataset } from './data/ourairports/fetch';
import {
  formatImportResult,
  importOurAirports,
  SanityCheckFailure,
} from './data/ourairports/import';
import { createDatabase } from './db/client';

/**
 * `node dist/import-airports.js` — loads the world's airports (M1-01).
 *
 * A separate entry point rather than something the server does at boot: this
 * takes a couple of minutes, touches ~86,000 rows, and is run deliberately when
 * the dataset moves. A server that imported on start would make every restart
 * slow and every deploy a data migration.
 *
 *   --force     re-import even if this exact dataset checksum is already recorded
 *   --prune     delete airports that have disappeared upstream (off by default)
 *   --offline   read the CSVs from the cache instead of downloading
 *   --cache DIR where to cache the downloads (default: ./.cache/ourairports)
 */

function parseArgs(argv: readonly string[]) {
  const args = { force: false, prune: false, offline: false, cacheDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') args.force = true;
    else if (arg === '--prune') args.prune = true;
    else if (arg === '--offline') args.offline = true;
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
    args.cacheDir === '' ? resolve(process.cwd(), '.cache', 'ourairports') : args.cacheDir;

  const db = createDatabase();
  try {
    process.stdout.write(`Fetching OurAirports${args.offline ? ' (offline, from cache)' : ''}…\n`);
    const dataset = await fetchDataset({ cacheDir, offline: args.offline });
    process.stdout.write(`  version ${dataset.version}\n  checksum ${dataset.checksum}\n\n`);

    const result = await importOurAirports(db.db, dataset, {
      force: args.force,
      prune: args.prune,
    });

    process.stdout.write(`\n${formatImportResult(result)}\n`);
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof SanityCheckFailure) {
    // Loud and specific: this is the case where the file downloaded fine and is
    // simply not the dataset we expect. Nothing was written.
    process.stderr.write(
      `\nImport refused — the dataset failed its sanity checks.\n${error.message}\n`,
    );
    process.stderr.write('Nothing was written. Check the source before overriding.\n');
    process.exit(2);
  }
  process.stderr.write(
    `\nImport failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
