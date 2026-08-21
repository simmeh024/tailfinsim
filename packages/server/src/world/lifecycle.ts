import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { type WorldConfig } from '@tailfin/shared';
import { gameTime } from '@tailfin/sim';

import { type Database } from '../db/client';
import { airline, world, worldEvent, type WorldRow } from '../db/schema';
import { economyConfigVersionExists } from '../economy/loader';
import { ensureEconomyConfigSeeded } from '../economy/seed';

import { assertUsableConfig } from './config';

/**
 * Creating, exporting and resetting a world (M1-09, §22.2, ADR-0005).
 */

export interface CreateWorldResult {
  world: WorldRow;
  created: boolean;
}

/**
 * Creates a world from config, or returns the existing one of that name.
 *
 * Idempotent by name, so the seed can be run repeatedly without a guard around
 * it — which matters because it *will* be, every time a test environment is
 * rebuilt. `created` says which happened, so a caller that cares can tell.
 *
 * `launch_date` is `now()` and is the only value not taken from the config. That
 * is the difference between the two: `epoch` is what the world *is*, and
 * `launch_date` is when this instance of it started running. A reset changes the
 * second and never the first.
 */
export async function createWorld(
  db: Database,
  config: WorldConfig,
  now: Date = new Date(),
): Promise<CreateWorldResult> {
  // A world cannot exist without an economy it can pin, so making sure the
  // shipped one is in the database is part of creating one — on a database that
  // has only just been migrated there is otherwise nothing to pin to. Insert
  // only, and memoised, so it can never overwrite a retune and costs one query
  // per process.
  await ensureEconomyConfigSeeded(db);
  await assertUsableConfig(config, now, (version) => economyConfigVersionExists(db, version));

  const inserted = await db
    .insert(world)
    .values({
      name: config.name,
      epoch: new Date(config.epoch),
      launchDate: now,
      // M2-08: the world's randomness. A uuid is 122 bits of it and is already
      // guaranteed unique here, so there is no reason to invent a second format.
      seed: randomUUID(),
      speedMultiplier: config.speedMultiplier.toFixed(2),
      aircraftCatalogueVersion: config.aircraftCatalogueVersion,
      economyConfigVersion: config.economyConfigVersion,
      playerCap: config.playerCap,
    })
    .onConflictDoNothing({ target: world.name })
    .returning();

  if (inserted[0]) return { world: inserted[0], created: true };

  const existing = await db.select().from(world).where(eq(world.name, config.name)).limit(1);
  if (!existing[0]) throw new Error(`World ${config.name} was neither created nor found`);
  return { world: existing[0], created: false };
}

/**
 * Exports a world back to the config it could be recreated from.
 *
 * The acceptance criterion is a round trip: create, export, recreate identically.
 * `launch_date` is deliberately **not** in the config — it is not part of what
 * the world is, and including it would make a recreated world claim to have
 * started running at a time it did not.
 */
export async function exportWorldConfig(db: Database, worldId: string): Promise<WorldConfig> {
  const rows = await db.select().from(world).where(eq(world.id, worldId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`No world ${worldId}`);

  return {
    name: row.name,
    epoch: row.epoch.toISOString(),
    speedMultiplier: Number(row.speedMultiplier),
    aircraftCatalogueVersion: row.aircraftCatalogueVersion,
    economyConfigVersion: row.economyConfigVersion,
    playerCap: row.playerCap,
  };
}

export interface ResetResult {
  worldId: string;
  /** In-game date immediately after the reset. Equals the epoch, by construction. */
  gameDate: Date;
  eventsCleared: number;
  airlinesCleared: number;
}

/**
 * A full reset: rewind the clock and clear what the rewind invalidates.
 *
 * ## The clock half is trivial
 *
 * `launch_date = now()`, `epoch` untouched. `gameTime` then returns the epoch by
 * definition rather than by recalculation (ADR-0005). One column.
 *
 * ## The rest is the actual decision
 *
 * A reset that rewinds the calendar and leaves the world's contents alone is not
 * a reset — it is a world where flights were scheduled for dates that are now two
 * years in the future, and airlines hold cash they earned in a timeline that no
 * longer happened. So:
 *
 *   - **Pending events are deleted.** Their `fire_at` is a game-time instant on a
 *     timeline that no longer exists. Rescheduling them onto the new one would be
 *     guessing at intent.
 *   - **Airlines are deleted**, and with them the players' presence in this world.
 *     Player *accounts* survive — they are global, not per world — so signing in
 *     again works and simply finds no airline. §22.10's anonymise-not-delete rule
 *     is about GDPR erasure of a person, not about wiping a test world, and
 *     `airline.player_id` is `ON DELETE RESTRICT` precisely so this has to be
 *     deliberate rather than a side effect.
 *   - **Airports, runways and catchment are untouched.** They are global reference
 *     data (M1-01), not world state — re-importing 86,000 airports to rewind a
 *     clock would be absurd.
 *
 * This is destructive and irreversible. The caller is responsible for the
 * confirmation; this function assumes the decision has been taken.
 */
export async function resetWorld(
  db: Database,
  worldId: string,
  now: Date = new Date(),
): Promise<ResetResult> {
  return db.transaction(async (tx) => resetWorldWithin(tx, worldId, now));
}

/**
 * The reset itself, on a transaction the caller already has.
 *
 * Split out for M1A-04: the console has to write an audit row in the *same*
 * transaction as the reset, and nesting `db.transaction` inside one would rely
 * on savepoint semantics to get a guarantee that should not depend on them. The
 * seed script keeps calling `resetWorld` above and gets its own transaction.
 *
 * Locks the world row `FOR UPDATE` before reading anything from it, so two
 * resets — or a reset and a speed change — cannot interleave.
 */
export async function resetWorldWithin(
  tx: Database,
  worldId: string,
  now: Date = new Date(),
): Promise<ResetResult> {
  {
    const rows = await tx.select().from(world).where(eq(world.id, worldId)).limit(1).for('update');
    const row = rows[0];
    if (!row) throw new Error(`No world ${worldId}`);

    const events = await tx
      .delete(worldEvent)
      .where(eq(worldEvent.worldId, worldId))
      .returning({ id: worldEvent.id });

    const airlines = await tx
      .delete(airline)
      .where(eq(airline.worldId, worldId))
      .returning({ id: airline.id });

    // A new seed as well as a new clock. ADR-0005's reset is a new world in an
    // old shell, and it should not replay the last one's weather.
    await tx
      .update(world)
      .set({ launchDate: now, status: 'staging', seed: randomUUID() })
      .where(eq(world.id, worldId));

    // Read back rather than trusting the arithmetic: the point of the reset is
    // that the in-game date *is* the epoch afterwards, so prove it from the row.
    const after = await tx.select().from(world).where(eq(world.id, worldId)).limit(1);
    const updated = after[0]!;

    return {
      worldId,
      gameDate: gameTime(
        {
          epoch: updated.epoch,
          launchDate: updated.launchDate,
          speedMultiplier: Number(updated.speedMultiplier),
        },
        now,
      ),
      eventsCleared: events.length,
      airlinesCleared: airlines.length,
    };
  }
}

/** The world's current in-game date, read from the row. */
export async function currentGameDate(
  db: Database,
  worldId: string,
  now: Date = new Date(),
): Promise<Date> {
  const rows = await db.select().from(world).where(eq(world.id, worldId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`No world ${worldId}`);
  return gameTime(
    { epoch: row.epoch, launchDate: row.launchDate, speedMultiplier: Number(row.speedMultiplier) },
    now,
  );
}

/** Opens a staging world for play. */
export async function openWorld(db: Database, worldId: string): Promise<void> {
  await db
    .update(world)
    .set({ status: 'open' })
    .where(sql`${world.id} = ${worldId} AND ${world.status} = 'staging'`);
}
