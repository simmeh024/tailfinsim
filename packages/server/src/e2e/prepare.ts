import { resolve } from 'node:path';

import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { FLAGSHIP_CONFIG, type WorldConfig } from '@tailfin/shared';

import { BOOTSTRAP_ACTOR, grantAdmin } from '../admin/grants';
import { createDatabase } from '../db/client';
import { player, world } from '../db/schema';
import { assertDisposableDatabaseUrl } from '../test-support/database-safety';
import { createWorld, openWorld, resetWorld } from '../world/lifecycle';

/** The only database this harness selects without an explicit override. */
export const DEFAULT_E2E_DATABASE_URL =
  'postgres://tailfin:tailfin_dev@127.0.0.1:5432/tailfin_e2e_test';

export const E2E_FIXTURES = {
  worldName: 'E2E Fixture World',
  // The admin-browser journey creates this staging world through the real
  // console. Preparation removes only this exact disposable world before the
  // next run, so the journey can prove a creation rather than rediscovering an
  // old row. Its append-only audit history is intentionally retained.
  createdWorldName: 'E2E Admin Created World',
  player: {
    id: '00000000-0000-4000-8000-000000000201',
    displayName: 'E2E Player',
  },
  admin: {
    id: '00000000-0000-4000-8000-000000000202',
    displayName: 'E2E Administrator',
  },
  // Logout revokes a server-side session. Keep that destructive browser journey
  // on a dedicated identity so it cannot invalidate the shared player state
  // while Playwright is running another player spec in parallel.
  logoutPlayer: {
    id: '00000000-0000-4000-8000-000000000203',
    displayName: 'E2E Sign-out Player',
  },
} as const;

const e2eWorldConfig: WorldConfig = {
  ...FLAGSHIP_CONFIG,
  name: E2E_FIXTURES.worldName,
};

export function e2eDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL ?? DEFAULT_E2E_DATABASE_URL;
  // This is deliberately the server suite's guard, not a copied suffix check.
  assertDisposableDatabaseUrl(url);
  return url;
}

export async function prepareE2eDatabase(): Promise<void> {
  const databaseUrl = e2eDatabaseUrl();
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;

  const database = createDatabase();
  try {
    await migrate(database.db, {
      migrationsFolder: resolve(import.meta.dirname, '../../drizzle'),
    });

    await database.db.delete(world).where(eq(world.name, E2E_FIXTURES.createdWorldName));

    const seeded = await createWorld(database.db, e2eWorldConfig);
    await resetWorld(database.db, seeded.world.id);
    await openWorld(database.db, seeded.world.id);

    // `admin_audit` is append-only by trigger. Delete only the disposable
    // identities; their old audit facts remain as harmless E2E history.
    await database.db
      .delete(player)
      .where(
        inArray(player.id, [
          E2E_FIXTURES.player.id,
          E2E_FIXTURES.admin.id,
          E2E_FIXTURES.logoutPlayer.id,
        ]),
      );

    await database.db
      .insert(player)
      .values([E2E_FIXTURES.player, E2E_FIXTURES.admin, E2E_FIXTURES.logoutPlayer]);
    await grantAdmin(database.db, E2E_FIXTURES.admin.id, BOOTSTRAP_ACTOR);

    const fixtureWorld = await database.db
      .select({ id: world.id, status: world.status })
      .from(world)
      .where(eq(world.name, E2E_FIXTURES.worldName))
      .limit(1);
    if (fixtureWorld[0]?.status !== 'open') {
      throw new Error('E2E fixture world was not opened after reset.');
    }
  } finally {
    await database.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

if (import.meta.main) await prepareE2eDatabase();
