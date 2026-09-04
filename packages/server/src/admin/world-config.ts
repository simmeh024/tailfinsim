/**
 * A world's configuration, back out as JSON (M11-02, §22.2).
 *
 * §22.2's acceptance criterion is that *"a world can be exported and recreated
 * identically from its JSON"*. The cheapest way to be sure of that is to make
 * the export produce **exactly the body the create endpoint accepts** — the same
 * `WorldConfig` schema, no export-only wrapper, no extra fields — so the
 * round-trip is true by construction rather than by a mapping somebody has to
 * keep in step. `world-config-export.test.ts` closes the loop by parsing what
 * comes out with the schema that guards what goes in.
 *
 * What is deliberately **not** here: the world's identity and its clock — `id`,
 * `seed`, `launch_date`, `status`, `created_at`. Those are what makes a world
 * *that* world rather than another one with the same rules. Exporting them would
 * invite a "recreate" that silently resurrects a reset world's calendar; ADR-0005
 * is built on `launch_date` moving to now.
 */

import { eq } from 'drizzle-orm';

import { type WorldConfig } from '@tailfin/shared';

import { world } from '../db/schema';

import type { Database } from '../db/client';

/** One world's reproducible configuration, or null if there is no such world. */
export async function exportWorldConfig(
  db: Database,
  worldId: string,
): Promise<WorldConfig | null> {
  const [row] = await db
    .select({
      name: world.name,
      epoch: world.epoch,
      speedMultiplier: world.speedMultiplier,
      aircraftCatalogueVersion: world.aircraftCatalogueVersion,
      economyConfigVersion: world.economyConfigVersion,
      playerCap: world.playerCap,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!row) return null;

  return {
    name: row.name,
    epoch: row.epoch.toISOString(),
    // `numeric` comes back from the driver as a string — the trap CLAUDE.md
    // records — and `WorldConfig` wants a number, so it is parsed rather than cast.
    speedMultiplier: Number.parseFloat(row.speedMultiplier),
    aircraftCatalogueVersion: row.aircraftCatalogueVersion,
    economyConfigVersion: row.economyConfigVersion,
    playerCap: row.playerCap,
  };
}
