import { createDatabase } from './db/client';
import { world } from './db/schema';
import { clearDemandPools, generateDemandPools } from './demand/generate';

/**
 * `pnpm demand:generate <worldId> [--regenerate]` — App. A.2's step one (M3-01).
 *
 * Sizes every viable city pair for a world and stores it. Run once after a world
 * is created, and again whenever the gravity coefficients are retuned.
 *
 * A CLI rather than part of `createWorld`, for the reason in `demand/generate.ts`:
 * sizing 9.7 million pairs is fast, writing the survivors is not, and a world
 * creation that blocks for minutes is one that times out.
 *
 * `--regenerate` clears first. Without it a re-run is a no-op, which is the safe
 * default — changing `k` and re-running without clearing would leave a world
 * holding a mixture of two economies.
 */

const [worldId, ...flags] = process.argv.slice(2);
const regenerate = flags.includes('--regenerate');

if (worldId === undefined) {
  process.stderr.write('usage: demand:generate <worldId> [--regenerate]\n');
  process.exit(1);
}

const db = createDatabase();
const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

try {
  const worlds = await db.db.select({ id: world.id, name: world.name }).from(world);
  const target = worlds.find((w) => w.id === worldId);
  if (!target) {
    process.stderr.write(`No world ${worldId}. Known worlds:\n`);
    for (const w of worlds) process.stderr.write(`  ${w.id}  ${w.name}\n`);
    process.exit(1);
  }

  log(`Generating demand pools for ${target.name}`);

  if (regenerate) {
    const removed = await clearDemandPools(db.db, worldId);
    log(`  cleared ${removed.toLocaleString()} existing pools`);
  }

  const result = await generateDemandPools(db.db, worldId, { log });

  log('');
  log(`  airports          ${result.airports.toLocaleString()}`);
  log(`  pairs considered  ${result.pairsConsidered.toLocaleString()}`);
  log(`  pools written     ${result.poolsWritten.toLocaleString()}`);
  log(`  took              ${(result.elapsedMs / 1000).toFixed(1)}s`);

  // M3-01's budget. Reported rather than enforced: a run that overruns is worth
  // knowing about, and killing it after five minutes would leave the world with
  // half a demand model.
  if (result.elapsedMs > 5 * 60 * 1_000) {
    log('');
    log('  NOTE: over M3-01’s five-minute budget.');
  }
} finally {
  await db.close();
}
