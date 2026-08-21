import { eq, inArray } from 'drizzle-orm';

import { LIVE_AIRLINE_STATUSES } from '@tailfin/shared';
import { gameTime } from '@tailfin/sim';

import { type Database } from '../db/client';
import {
  airline,
  airlineStatusTransition,
  route,
  schedule,
  world,
  type AirlineRow,
  type AirlineStatus,
} from '../db/schema';

export { LIVE_AIRLINE_STATUSES };

export function liveAirlineWhere() {
  return inArray(airline.status, [...LIVE_AIRLINE_STATUSES]);
}

const NEXT_STATUS: Record<AirlineStatus, readonly AirlineStatus[]> = {
  active: ['restricted', 'ceased'],
  restricted: ['active', 'ceased'],
  // Cessation releases scarce codes, so reactivation would make identity
  // ambiguous when a later airline has already claimed one.
  ceased: [],
};

export interface TransitionAirlineStatusInput {
  to: AirlineStatus;
  /** Stable, human-readable cause retained with the lifecycle history. */
  reason: string;
}

export type TransitionAirlineStatusResult =
  | { kind: 'not-found' }
  | { kind: 'unchanged'; airline: AirlineRow }
  | {
      kind: 'transitioned';
      airline: AirlineRow;
      transitionId: string;
      instructionsDeactivated: { routes: number; schedules: number };
    };

function lifecycleReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new Error('Airline lifecycle reason must contain between 1 and 500 characters');
  }
  return reason;
}

/**
 * Transition an already-open transaction's airline row.
 *
 * Exported for account anonymisation so identity removal, cessation and the
 * preserved operational record commit together. Ordinary callers should use
 * `transitionAirlineStatus`, which supplies the transaction boundary.
 */
export async function transitionAirlineStatusInTransaction(
  tx: Database,
  airlineId: string,
  input: TransitionAirlineStatusInput,
  realNow: Date,
): Promise<TransitionAirlineStatusResult> {
  const rows = await tx
    .select({ row: airline, world })
    .from(airline)
    .innerJoin(world, eq(world.id, airline.worldId))
    .where(eq(airline.id, airlineId))
    .limit(1)
    .for('update');
  const current = rows[0];
  if (!current) return { kind: 'not-found' };
  if (current.row.status === input.to) return { kind: 'unchanged', airline: current.row };
  if (!NEXT_STATUS[current.row.status].includes(input.to)) {
    throw new Error(`Airline cannot transition from ${current.row.status} to ${input.to}`);
  }

  const occurredAt = gameTime(
    {
      epoch: current.world.epoch,
      launchDate: current.world.launchDate,
      speedMultiplier: Number(current.world.speedMultiplier),
    },
    realNow,
  );

  let routesDeactivated = 0;
  let schedulesDeactivated = 0;
  if (input.to === 'ceased') {
    const stoppedRoutes = await tx
      .update(route)
      .set({ active: false, updatedAt: realNow })
      .where(eq(route.airlineId, airlineId))
      .returning({ id: route.id });
    const stoppedSchedules = await tx
      .update(schedule)
      .set({ active: false, updatedAt: realNow })
      .where(eq(schedule.airlineId, airlineId))
      .returning({ id: schedule.id });
    routesDeactivated = stoppedRoutes.length;
    schedulesDeactivated = stoppedSchedules.length;
  }

  const changedRows = await tx
    .update(airline)
    .set({
      status: input.to,
      statusChangedAt: realNow,
      ceasedAt: input.to === 'ceased' ? realNow : null,
    })
    .where(eq(airline.id, airlineId))
    .returning();
  const changed = changedRows[0];
  if (!changed) throw new Error(`Airline ${airlineId} vanished during its lifecycle transition`);

  const events = await tx
    .insert(airlineStatusTransition)
    .values({
      airlineId,
      fromStatus: current.row.status,
      toStatus: input.to,
      reason: lifecycleReason(input.reason),
      occurredAt,
      recordedAt: realNow,
    })
    .returning({ id: airlineStatusTransition.id });
  const event = events[0];
  if (!event) throw new Error(`Airline ${airlineId} lifecycle transition was not recorded`);

  return {
    kind: 'transitioned',
    airline: changed,
    transitionId: event.id,
    instructionsDeactivated: { routes: routesDeactivated, schedules: schedulesDeactivated },
  };
}

/** Apply one authoritative, recorded airline lifecycle transition. */
export async function transitionAirlineStatus(
  db: Database,
  airlineId: string,
  input: TransitionAirlineStatusInput,
  realNow: Date = new Date(),
): Promise<TransitionAirlineStatusResult> {
  return db.transaction((tx) =>
    transitionAirlineStatusInTransaction(tx, airlineId, input, realNow),
  );
}
