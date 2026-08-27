import { and, eq, gte, sql } from 'drizzle-orm';

import {
  EXECUTIVE_FLOOR_REVENUE_GATE_MINOR,
  EXECUTIVE_FLOOR_UNLOCK_COST_MINOR,
  nextExecutiveOffice,
  type ExecutiveFloorState,
} from '@tailfin/shared';
import { gameTime, type WorldClock } from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { airline, executiveFloor, flightResult, world } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * The executive floor: opening it, opening its offices, and the two gates on the
 * first of those (§9.1 follow-up).
 *
 * A discretionary purchase, so — like {@link purchaseExpansion} and unlike a
 * salary — it **refuses when the cash is not there** rather than pushing the
 * airline negative. The floor has a second gate the offices do not: a trailing
 * monthly **gross revenue** floor, so the executive suite is reachable only by an
 * airline that is genuinely earning, not merely one that has banked a windfall.
 *
 * Every charge is an AIR-06 movement, idempotent by `(cause, reference)`: the
 * floor once (`executive_floor:<airline>`), each office once by its index
 * (`executive_office:<airline>:<index>`). The unique row and the `FOR UPDATE`
 * lock on the airline together stop two clicks buying the same thing twice.
 */

/** The trailing window for the revenue gate — a game month, in game time. */
const REVENUE_WINDOW_MS = 30 * 86_400_000;

/** This world's current game time, for the trailing-revenue window. */
async function worldGameNow(db: Database, worldId: string): Promise<Date> {
  const [row] = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!row) throw new Error(`world ${worldId} vanished while reading the executive floor`);
  const clock: WorldClock = {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
  return gameTime(clock, new Date());
}

/**
 * An airline's gross flight revenue over the last game month.
 *
 * The sum of `flight_result.revenue_minor` for settled flights in the trailing
 * window — what the airline *earned*, before costs. `sum` of a `bigint` comes
 * back from the driver as a string (the CLAUDE.md trap), so it is coerced, not
 * trusted to be a number.
 */
export async function monthlyGrossRevenueMinor(
  db: Database,
  airlineId: string,
  gameNow: Date,
): Promise<number> {
  const since = new Date(gameNow.getTime() - REVENUE_WINDOW_MS);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${flightResult.revenueMinor}), 0)` })
    .from(flightResult)
    .where(and(eq(flightResult.airlineId, airlineId), gte(flightResult.settledAt, since)));
  return Number(row?.total ?? 0);
}

/** Read the executive floor's state for one airline. */
export async function readExecutiveFloor(
  db: Database,
  own: ResolvedPlayerAirline,
  gameNow?: Date,
): Promise<ExecutiveFloorState> {
  const now = gameNow ?? (await worldGameNow(db, own.worldId));
  const [row] = await db
    .select({ officesUnlocked: executiveFloor.officesUnlocked })
    .from(executiveFloor)
    .where(eq(executiveFloor.airlineId, own.id))
    .limit(1);

  const unlocked = row !== undefined;
  const officesUnlocked = row?.officesUnlocked ?? 0;
  const monthlyRevenueMinor = await monthlyGrossRevenueMinor(db, own.id, now);

  return {
    unlocked,
    officesUnlocked,
    unlockCostMinor: EXECUTIVE_FLOOR_UNLOCK_COST_MINOR,
    revenueGateMinor: EXECUTIVE_FLOOR_REVENUE_GATE_MINOR,
    monthlyRevenueMinor,
    nextOffice: unlocked ? nextExecutiveOffice(officesUnlocked) : null,
  };
}

type FloorFailCode = 'already_unlocked' | 'revenue_too_low' | 'insufficient_funds';

export type UnlockFloorResult =
  { ok: true; state: ExecutiveFloorState } | { ok: false; code: FloorFailCode };

/** Open the executive floor, if the airline clears both gates and can pay. */
export async function unlockExecutiveFloor(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<UnlockFloorResult> {
  const gameNow = await worldGameNow(db, own.worldId);
  const monthlyRevenueMinor = await monthlyGrossRevenueMinor(db, own.id, gameNow);

  const outcome = await db.transaction(async (tx): Promise<FloorFailCode | null> => {
    const [locked] = await tx
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, own.id))
      .limit(1)
      .for('update');
    if (!locked) return 'insufficient_funds';

    const [existing] = await tx
      .select({ id: executiveFloor.id })
      .from(executiveFloor)
      .where(eq(executiveFloor.airlineId, own.id))
      .limit(1);
    if (existing) return 'already_unlocked';

    // Revenue first, then cash: "you have not earned it yet" is a different, and
    // more useful, message than "you cannot afford it".
    if (monthlyRevenueMinor < EXECUTIVE_FLOOR_REVENUE_GATE_MINOR) return 'revenue_too_low';
    if (locked.cashMinor < EXECUTIVE_FLOOR_UNLOCK_COST_MINOR) return 'insufficient_funds';

    await moveAirlineCash(tx, {
      airlineId: own.id,
      amountMinor: -EXECUTIVE_FLOOR_UNLOCK_COST_MINOR,
      cause: 'executive_floor',
      reference: `executive_floor:${own.id}`,
      occurredAt: new Date(),
    });
    await tx
      .insert(executiveFloor)
      .values({ worldId: own.worldId, airlineId: own.id, officesUnlocked: 0 });
    return null;
  });

  if (outcome !== null) return { ok: false, code: outcome };
  return { ok: true, state: await readExecutiveFloor(db, own, gameNow) };
}

type OfficeFailCode = 'floor_locked' | 'maxed' | 'insufficient_funds';

export type UnlockOfficeResult =
  { ok: true; state: ExecutiveFloorState } | { ok: false; code: OfficeFailCode };

/** Open the next executive office in sequence, if the airline can pay. */
export async function unlockExecutiveOffice(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<UnlockOfficeResult> {
  const outcome = await db.transaction(async (tx): Promise<OfficeFailCode | null> => {
    const [locked] = await tx
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, own.id))
      .limit(1)
      .for('update');
    if (!locked) return 'insufficient_funds';

    const [floor] = await tx
      .select({ officesUnlocked: executiveFloor.officesUnlocked })
      .from(executiveFloor)
      .where(eq(executiveFloor.airlineId, own.id))
      .limit(1);
    if (!floor) return 'floor_locked';

    const next = nextExecutiveOffice(floor.officesUnlocked);
    if (next === null) return 'maxed';
    if (locked.cashMinor < next.costMinor) return 'insufficient_funds';

    await moveAirlineCash(tx, {
      airlineId: own.id,
      amountMinor: -next.costMinor,
      cause: 'executive_office',
      reference: `executive_office:${own.id}:${String(next.index)}`,
      occurredAt: new Date(),
    });
    await tx
      .update(executiveFloor)
      .set({ officesUnlocked: floor.officesUnlocked + 1 })
      .where(eq(executiveFloor.airlineId, own.id));
    return null;
  });

  if (outcome !== null) return { ok: false, code: outcome };
  return { ok: true, state: await readExecutiveFloor(db, own) };
}
