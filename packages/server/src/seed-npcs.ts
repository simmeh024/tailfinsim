import { eq } from 'drizzle-orm';

import { createDatabase } from './db/client';
import { world } from './db/schema';
import { seedNpcCarriers } from './npc/seed';

/**
 * `node dist/seed-npcs.js <worldId>` — populate a world with incumbents (M3-12).
 *
 * A one-off job for the same reason `demand:generate` is: it writes a lot of
 * rows once, from data that has to be there first, and a world creation that
 * blocked on it would time out. The order matters and is not guessable, so it
 * is stated here and in CONTRIBUTING's table:
 *
 *     data:airports → data:classify → data:catchment → data:distances
 *       → world:seed → demand:generate → npc:seed
 *
 * `demand:generate` in particular is a hard prerequisite: NPCs choose their
 * networks from `demand_pool`, and a world with no pools gets no carriers and a
 * message saying so rather than sixty airlines flying nowhere.
 *
 * Idempotent: a world that already has NPC carriers is left alone. Running it
 * twice does not double the world's competition — which matters, because
 * nothing here can be deleted back.
 */

function usage(): never {
  process.stderr.write(
    [
      'Usage: pnpm npc:seed <worldId>',
      '',
      '  Seeds NPC carriers and their opening networks into one world.',
      '  Requires the world to have demand pools already — run `pnpm demand:generate` first.',
      '',
      '  --list   print the worlds in this database and exit',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const db = createDatabase();
  try {
    if (args[0] === '--list') {
      const worlds = await db.db
        .select({ id: world.id, name: world.name, status: world.status })
        .from(world);
      for (const row of worlds) out(`${row.id}  ${row.status.padEnd(8)} ${row.name}`);
      return;
    }

    const worldId = args[0];
    if (worldId === undefined || worldId.startsWith('-')) usage();

    const exists = await db.db
      .select({ id: world.id, name: world.name })
      .from(world)
      .where(eq(world.id, worldId))
      .limit(1);

    const target = exists[0];
    if (!target) {
      process.stderr.write(`No world ${worldId}. Try --list.\n`);
      process.exit(1);
    }

    out(`Seeding NPC carriers into "${target.name}"`);
    const result = await seedNpcCarriers(db.db, worldId, out);

    if (result.alreadySeeded) {
      out('  already seeded — nothing to do');
      return;
    }

    out('');
    out(
      `  ${String(result.created)} carriers across ${String(result.countries.length)} countries, ` +
        `${String(result.routesOpened)} routes opened`,
    );
  } finally {
    await db.close();
  }
}

await main();
