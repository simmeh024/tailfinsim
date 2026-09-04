import { and, asc, eq, gte, sql } from 'drizzle-orm';

import {
  EXECUTIVE_FLOOR_REVENUE_GATE_MINOR,
  EXECUTIVE_FLOOR_UNLOCK_COST_MINOR,
  executiveCandidate,
  nextExecutiveOffice,
  type ExecutiveFloorState,
  type ExecutiveHire,
} from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { airline, executiveFloor, executiveHire, flightResult } from '../db/schema';
import { worldGameNow } from '../world/game-now';

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

/** The C-Suite an airline currently employs, oldest hire first, as the wire shape. */
export async function readExecutiveHires(
  db: Database,
  airlineId: string,
): Promise<ExecutiveHire[]> {
  const rows = await db
    .select({
      candidateId: executiveHire.candidateId,
      candidateName: executiveHire.candidateName,
      monthlySalaryMinor: executiveHire.monthlySalaryMinor,
      officeIndex: executiveHire.officeIndex,
      hiredAt: executiveHire.hiredAt,
    })
    .from(executiveHire)
    .where(eq(executiveHire.airlineId, airlineId))
    .orderBy(asc(executiveHire.hiredAt));
  return rows.map((row) => ({
    candidateId: row.candidateId,
    candidateName: row.candidateName,
    monthlySalaryMinor: row.monthlySalaryMinor,
    officeIndex: row.officeIndex,
    hiredAt: row.hiredAt.toISOString(),
  }));
}

/** Read the executive floor's state for one airline. */
export async function readExecutiveFloor(
  db: Database,
  own: ResolvedPlayerAirline,
  gameNow?: Date,
): Promise<ExecutiveFloorState> {
  const now = gameNow ?? (await worldGameNow(db, own.worldId));
  const [[row], hires, monthlyRevenueMinor] = await Promise.all([
    db
      .select({ officesUnlocked: executiveFloor.officesUnlocked })
      .from(executiveFloor)
      .where(eq(executiveFloor.airlineId, own.id))
      .limit(1),
    readExecutiveHires(db, own.id),
    monthlyGrossRevenueMinor(db, own.id, now),
  ]);

  const unlocked = row !== undefined;
  const officesUnlocked = row?.officesUnlocked ?? 0;

  return {
    unlocked,
    officesUnlocked,
    unlockCostMinor: EXECUTIVE_FLOOR_UNLOCK_COST_MINOR,
    revenueGateMinor: EXECUTIVE_FLOOR_REVENUE_GATE_MINOR,
    monthlyRevenueMinor,
    nextOffice: unlocked ? nextExecutiveOffice(officesUnlocked) : null,
    hires,
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
      occurredAt: gameNow,
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
  // Read before the transaction, like the floor above: one clock read outside a
  // lock is cheaper than holding the airline row while another query runs.
  const gameNow = await worldGameNow(db, own.worldId);

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
      occurredAt: gameNow,
    });
    await tx
      .update(executiveFloor)
      .set({ officesUnlocked: floor.officesUnlocked + 1 })
      .where(eq(executiveFloor.airlineId, own.id));
    return null;
  });

  if (outcome !== null) return { ok: false, code: outcome };
  return { ok: true, state: await readExecutiveFloor(db, own, gameNow) };
}

type HireExecFailCode =
  'floor_locked' | 'unknown_candidate' | 'already_hired' | 'no_free_office' | 'office_occupied';

export type HireExecutiveResult =
  { ok: true; state: ExecutiveFloorState } | { ok: false; code: HireExecFailCode };

/**
 * Hire a C-Suite candidate into a free executive office (Phase 2).
 *
 * An office is generic — any candidate fits any office — so a hire simply consumes
 * one of the opened offices, and an airline may employ as many executives as it
 * has opened. The candidate's **name and salary come from the shared catalogue by
 * id**, never the request, and are snapshotted onto the row so a later retune
 * cannot re-bill a standing executive. The `FOR UPDATE` lock on the floor row
 * serialises concurrent hires so the capacity check cannot be raced past, and the
 * `(airline_id, candidate_id)` unique index keeps a person from being hired twice.
 */
export async function hireExecutive(
  db: Database,
  own: ResolvedPlayerAirline,
  candidateId: string,
  officeIndex?: number,
): Promise<HireExecutiveResult> {
  const candidate = executiveCandidate(candidateId);
  if (candidate === undefined) return { ok: false, code: 'unknown_candidate' };

  const gameNow = await worldGameNow(db, own.worldId);

  const outcome = await db.transaction(async (tx): Promise<HireExecFailCode | null> => {
    const [floor] = await tx
      .select({ officesUnlocked: executiveFloor.officesUnlocked })
      .from(executiveFloor)
      .where(eq(executiveFloor.airlineId, own.id))
      .limit(1)
      .for('update');
    if (!floor) return 'floor_locked';

    const held = await tx
      .select({ candidateId: executiveHire.candidateId, officeIndex: executiveHire.officeIndex })
      .from(executiveHire)
      .where(eq(executiveHire.airlineId, own.id));
    if (held.some((row) => row.candidateId === candidateId)) return 'already_hired';
    if (held.length >= floor.officesUnlocked) return 'no_free_office';

    // Place them in the office the player picked, or the lowest free one. Offices
    // are generic, so this is only which room they appear in; occupancy is the
    // constraint, not identity.
    const occupied = new Set(
      held.map((row) => row.officeIndex).filter((i): i is number => i !== null),
    );
    let target: number;
    if (officeIndex !== undefined) {
      if (officeIndex >= floor.officesUnlocked) return 'no_free_office';
      if (occupied.has(officeIndex)) return 'office_occupied';
      target = officeIndex;
    } else {
      let free = 0;
      while (occupied.has(free)) free += 1;
      target = free;
    }

    // Game time, like the office hires beside it: the salary snapshotted here is
    // per game month, and the column's `defaultNow()` is a wall-clock fallback
    // that should never be the value that lands (TIME-02).
    await tx.insert(executiveHire).values({
      worldId: own.worldId,
      airlineId: own.id,
      candidateId,
      candidateName: candidate.name,
      monthlySalaryMinor: candidate.monthlySalaryMinor,
      officeIndex: target,
      hiredAt: gameNow,
    });
    return null;
  });

  if (outcome !== null) return { ok: false, code: outcome };
  return { ok: true, state: await readExecutiveFloor(db, own, gameNow) };
}

/** Let a C-Suite member go. Idempotent: dismissing someone not employed is a no-op. */
export async function dismissExecutive(
  db: Database,
  own: ResolvedPlayerAirline,
  candidateId: string,
): Promise<{ dismissed: boolean }> {
  const removed = await db
    .delete(executiveHire)
    .where(and(eq(executiveHire.airlineId, own.id), eq(executiveHire.candidateId, candidateId)))
    .returning({ id: executiveHire.id });
  return { dismissed: removed.length > 0 };
}
