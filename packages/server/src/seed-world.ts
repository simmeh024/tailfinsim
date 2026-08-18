import { eq } from 'drizzle-orm';

import { FLAGSHIP_CONFIG, WorldConfig } from '@tailfin/shared';

import { createDatabase } from './db/client';
import { world } from './db/schema';
import {
  createWorld,
  currentGameDate,
  exportWorldConfig,
  openWorld,
  resetWorld,
} from './world/lifecycle';

/**
 * `node dist/seed-world.js` — creates the flagship world (M1-09).
 *
 * Idempotent: run it as often as you like, it creates the world once. That
 * matters because it is the command a fresh environment runs, and a fresh
 * environment happens more than once.
 *
 *   --reset       FULL RESET. Rewinds the clock to the epoch and deletes the
 *                 world's airlines and pending events. Irreversible.
 *   --open        move the world from staging to open
 *   --export      print the world's config as JSON and exit
 *   --config FILE create from a config file instead of the flagship default
 */

function parseArgs(argv: readonly string[]) {
  const args = { reset: false, open: false, export: false, configPath: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--reset') args.reset = true;
    else if (arg === '--open') args.open = true;
    else if (arg === '--export') args.export = true;
    else if (arg === '--config') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--config needs a file');
      args.configPath = next;
      i += 1;
    } else throw new Error(`unknown option: ${arg}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = (line: string): void => {
    process.stdout.write(`${line}
`);
  };

  let config = FLAGSHIP_CONFIG;
  if (args.configPath !== '') {
    const { readFileSync } = await import('node:fs');
    config = WorldConfig.parse(JSON.parse(readFileSync(args.configPath, 'utf8')));
  }

  const db = createDatabase();
  try {
    if (args.export) {
      const rows = await db.db
        .select({ id: world.id })
        .from(world)
        .where(eq(world.name, config.name));
      if (!rows[0]) throw new Error(`No world named ${config.name}`);
      out(JSON.stringify(await exportWorldConfig(db.db, rows[0].id), null, 2));
      return;
    }

    const { world: created, created: isNew } = await createWorld(db.db, config);
    out(`${isNew ? 'Created' : 'Found'} world "${created.name}" (${created.id})`);
    out(`  epoch            ${created.epoch.toISOString()}`);
    out(`  speed            ${created.speedMultiplier}x`);
    out(`  status           ${created.status}`);

    if (args.reset) {
      out('\nFULL RESET — clearing airlines and pending events, rewinding the clock…');
      const result = await resetWorld(db.db, created.id);
      out(`  airlines cleared ${String(result.airlinesCleared)}`);
      out(`  events cleared   ${String(result.eventsCleared)}`);
      out(`  in-game date     ${result.gameDate.toISOString()}`);
      if (result.gameDate.getTime() !== created.epoch.getTime()) {
        // The one invariant the whole reset exists to produce. Checked rather
        // than assumed, because "it should be the epoch" is exactly the kind of
        // thing that is quietly wrong for months.
        throw new Error(
          `Reset did not return the calendar to the epoch: got ${result.gameDate.toISOString()}, ` +
            `expected ${created.epoch.toISOString()}`,
        );
      }
      out('  verified: in-game date is the epoch');
    }

    if (args.open) {
      await openWorld(db.db, created.id);
      out('\nWorld opened for play.');
    }

    out(`\nIn-game date now ${(await currentGameDate(db.db, created.id)).toISOString()}`);
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `\nWorld seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
