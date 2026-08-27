/**
 * Parent-chain ownership resolution (SEC-08).
 *
 * An airline is a player in a particular world. A nested resource therefore
 * belongs to a caller only when its entire path to that airline resolves in the
 * caller's player-and-world namespace. Do this in one query from the leaf; do
 * not load a child and walk its parents in application code.
 *
 * `schedule_leg → schedule → airline` is the deliberately small worked
 * example. Future endpoints should add their own concrete resolver beside this
 * one, preserving the same shape rather than building a generic ACL framework.
 */

import { and, eq } from 'drizzle-orm';

import { Uuid } from '@tailfin/shared';

import { airline, schedule, scheduleLeg } from '../db/schema';

import type { Database } from '../db/client';

/** The two axes that make an airline belong to a player at a given instant. */
export interface NestedOwnershipScope {
  playerId: string;
  worldId: string;
}

/** The minimal fact a nested handler receives after ownership has resolved. */
export interface OwnedScheduleLeg {
  id: string;
  scheduleId: string;
  airlineId: string;
  worldId: string;
}

/**
 * Resolve a schedule leg only when the complete parent chain belongs to scope.
 *
 * Missing, foreign, wrong-world, malformed and broken-parent chains all return
 * `null`. Inner joins make a deleted or inconsistent parent a clean refusal,
 * not a later null dereference.
 */
export async function resolveOwnedScheduleLeg(
  db: Database,
  scope: NestedOwnershipScope,
  scheduleLegId: string,
): Promise<OwnedScheduleLeg | null> {
  if (!Uuid.safeParse(scheduleLegId).success) return null;

  const rows = await db
    .select({
      id: scheduleLeg.id,
      scheduleId: schedule.id,
      airlineId: airline.id,
      worldId: airline.worldId,
    })
    .from(scheduleLeg)
    .innerJoin(schedule, eq(scheduleLeg.scheduleId, schedule.id))
    .innerJoin(
      airline,
      and(eq(schedule.airlineId, airline.id), eq(schedule.worldId, airline.worldId)),
    )
    .where(
      and(
        eq(scheduleLeg.id, scheduleLegId),
        eq(airline.playerId, scope.playerId),
        eq(airline.worldId, scope.worldId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
