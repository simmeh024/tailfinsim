import { eq } from 'drizzle-orm';

import { gameTime, type WorldClock } from '@tailfin/sim';

import { world } from '../db/schema';

import type { Database } from '../db/client';

/**
 * One world's current game time (TIME-02, [ADR-0026](../../../../docs/adr/0026-in-world-spans-are-game-time.md)).
 *
 * ## Why this exists when `currentGameDate` already does
 *
 * `world/lifecycle.ts` exports the same arithmetic, but reaching it from an HTTP
 * request path drags `createWorld` and `resetWorld` into that module graph — the
 * two most destructive functions in the server, imported by a route that wants a
 * date. Three columns and a `gameTime()` call is not worth that, and a module
 * whose entire surface is "read a clock" cannot grow a reset by accident.
 *
 * `lifecycle.ts` keeps its own copy for the seed CLI, where the wider import is
 * already paid for.
 *
 * ## Why not a parameter
 *
 * Every caller here is an HTTP mutation being dated as it happens, so there is no
 * earlier instant to thread through. `now` stays injectable for tests, which is
 * CONTRIBUTING invariant 2's requirement — the wall-clock read is at this
 * boundary and nowhere deeper.
 */
export async function worldGameNow(
  db: Database,
  worldId: string,
  now: Date = new Date(),
): Promise<Date> {
  const [row] = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!row) throw new Error(`No world ${worldId}`);

  const clock: WorldClock = {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
  return gameTime(clock, now);
}
