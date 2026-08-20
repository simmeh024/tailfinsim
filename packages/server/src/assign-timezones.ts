import { resolve } from 'node:path';

import { fetchGeoNamesCities } from './data/catchment/sources';
import { applyTimezones, formatTimezoneResult } from './data/timezone/apply';
import { createDatabase } from './db/client';

/**
 * `node dist/assign-timezones.js` — gives every airport a timezone (M3-04a).
 *
 * Run it after `import-airports`. It does **not** need tiers or catchment: a
 * timezone is a fact about where a place is rather than about whether anyone
 * flies there, so this covers every airport in the table and can run at any
 * point after the import.
 *
 * It shares the catchment cache directory on purpose. Both this and
 * `derive-catchment` read GeoNames `cities15000`, so pointing them at the same
 * `--cache` downloads it once.
 *
 *   --offline    read the dump from the cache instead of downloading
 *   --cache DIR  where to cache it (default: ./.cache/catchment)
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
    process.stdout.write(`Fetching the GeoNames city dump${args.offline ? ' (offline)' : ''}…\n`);
    const cities = await fetchGeoNamesCities({ cacheDir, offline: args.offline });
    process.stdout.write(`${String(cities.length)} cities read\n`);

    const result = await applyTimezones(db.db, cities);
    process.stdout.write(`\n${formatTimezoneResult(result)}\n`);
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `\nTimezone assignment failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
