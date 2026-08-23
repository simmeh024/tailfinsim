/**
 * The world clock, as a player sees it (§22.2, ADR-0005).
 *
 * ## Why the server sends the time rather than the ingredients
 *
 * `epoch`, `launchDate` and `speedMultiplier` are enough to compute in-game time,
 * and handing all three to the browser would let it run the clock alone. It is
 * still the wrong shape. §21 makes the server authoritative, and a client whose
 * machine clock is wrong would then disagree with the server about **what day it
 * is** — which is not cosmetic, because the aircraft catalogue is gated on the
 * world's own date (§7.2b) and a fleet page would list types the world will not
 * sell.
 *
 * So the response carries `serverTime` alongside `inGameTime`. The client
 * measures its own skew once and interpolates from there, rather than trusting
 * `Date.now()` to mean the same thing on both machines.
 *
 * ## Why it is not derived from the airline payload
 *
 * The obvious alternative is to add the clock to `GET /api/airlines/me`. That
 * couples a value which changes continuously to one that changes when the player
 * edits something, so either the airline is refetched on a timer or the clock
 * goes stale — and the airline projection is comparatively expensive. A separate,
 * tiny endpoint can be polled at whatever rate the drift budget needs.
 */

import { eq } from 'drizzle-orm';

import type { WorldClock } from '@tailfin/shared';
import { gameTime, type WorldClock as SimWorldClock } from '@tailfin/sim';

import { world } from '../db/schema';

import type { Database } from '../db/client';

/** The world row's own columns, in the shape `@tailfin/sim` wants. */
function clockOf(row: { epoch: Date; launchDate: Date; speedMultiplier: string }): SimWorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    // `numeric` arrives as a string; the sim refuses a non-finite multiplier.
    speedMultiplier: Number(row.speedMultiplier),
  };
}

export type ReadWorldClockResult = { kind: 'read'; clock: WorldClock } | { kind: 'not-found' };

/**
 * Read one world's clock at `at`.
 *
 * `not-found` covers a world id that does not exist. Callers reach this with an
 * id resolved from the session's own airline, so ADR-0020's concealment rules
 * are already satisfied upstream — there is no id here a player could have
 * guessed.
 */
export async function readWorldClock(
  db: Database,
  worldId: string,
  at: Date,
): Promise<ReadWorldClockResult> {
  const rows = await db
    .select({
      id: world.id,
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);

  const row = rows[0];
  if (!row) return { kind: 'not-found' };

  const clock = clockOf(row);
  return {
    kind: 'read',
    clock: {
      worldId: row.id,
      serverTime: at.toISOString(),
      inGameTime: gameTime(clock, at).toISOString(),
      speedMultiplier: clock.speedMultiplier,
    },
  };
}
