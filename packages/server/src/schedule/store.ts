/**
 * Schedules, on disk and in the queue (M2-03, §8.2).
 *
 * `@tailfin/sim` owns the rules — what a valid rotation is, which flights a
 * horizon contains, what an edit does to the ones already booked. This owns the
 * three things that are properties of the *database* rather than of the
 * arithmetic:
 *
 *   - **Nothing is written unless the rotation is valid.** A schedule that
 *     cannot repeat is refused before it exists, not discovered later by a
 *     worker with nowhere to report it.
 *   - **Rolling the horizon twice creates nothing twice.** Enforced by
 *     `flight`'s unique `(world_id, materialisation_key)` rather than by a check
 *     this code has to remember to do.
 *   - **An edit is one transaction, cancels before it creates.** A moved leg
 *     keeps its key, so inserting first would collide with the row being
 *     replaced.
 */

import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import {
  applyEdit,
  type Horizon,
  type MaterialisedFlight,
  materialiseRotation,
  type RepeatPattern,
  type Rotation,
  type RotationProblem,
  type SchedulingProblem,
  type ScheduledLeg,
  validateRotation,
} from '@tailfin/sim';

import { airframeUnavailability } from '../aircraft/maintenance';
import { crewIllegality } from '../crew/legality';
import { flight, schedule, scheduleLeg, worldEvent } from '../db/schema';
import { scheduleEvent } from '../sim/event-queue';

import type { Database } from '../db/client';

/** The `world_event` idempotency key for a flight's departure. */
export function departureKey(flightId: string): string {
  return `flight:${flightId}:depart`;
}

/**
 * A leg as a caller supplies it. Ids and ordering are the store's to assign.
 */
export interface LegInput {
  originIcao: string;
  destinationIcao: string;
  departureMinute: number;
  blockMinutes: number;
  turnaroundMinutes: number;
}

export interface ScheduleInput {
  worldId: string;
  airlineId: string;
  airframeId: string;
  legs: readonly LegInput[];
  repeat: RepeatPattern;
}

/**
 * What the rules that do not exist yet would have said.
 *
 * Slots are M7-05 and crew legality is M5, so `validateRotation` takes them as
 * inputs and this takes them from the caller. Permissive by default and
 * deliberately so: refusing every rotation for want of a slot system would make
 * the feature untestable, and silently passing a `false` through would make the
 * eventual wiring look like a regression.
 */
export interface RotationContext {
  /** Whether a slot is held for each leg, by index. Missing entries count as held. */
  slots?: readonly boolean[];
  /**
   * Crew legality, asserted by the caller.
   *
   * **Leave it undefined and the database decides** (M5-01): `createSchedule`
   * reads the airline's pools and refuses a rotation it has no complement for.
   * Setting it `true` asserts legality and skips that read, which is for callers
   * that have already answered the question — and for the tests of other
   * subsystems, which schedule flights for airlines that were never going to
   * have crew and are not about crew.
   *
   * Setting it `false` refuses in `validateRotation`, before any row is read.
   */
  crewLegal?: boolean;
}

export type SaveResult =
  | { ok: true; scheduleId: string }
  // `SchedulingProblem`, not `RotationProblem`: this can also refuse for a reason
  // only the database knows, such as an aeroplane in a check (M4-06).
  | { ok: false; problem: SchedulingProblem; detail: string };

function toRotation(
  id: string,
  legs: readonly LegInput[],
  repeat: RepeatPattern,
  context: RotationContext = {},
): Rotation {
  const scheduledLegs: ScheduledLeg[] = legs.map((leg, index) => ({
    originIcao: leg.originIcao,
    destinationIcao: leg.destinationIcao,
    departureMinute: leg.departureMinute,
    blockMinutes: leg.blockMinutes,
    turnaroundMinutes: leg.turnaroundMinutes,
    hasSlot: context.slots?.[index] ?? true,
  }));
  return { id, legs: scheduledLegs, repeat, crewLegal: context.crewLegal ?? true };
}

/**
 * Validate a rotation and write it, or refuse it and write nothing.
 *
 * The rotation is checked against a **placeholder id**, because the real one is
 * assigned by the insert and nothing in `validateRotation` looks at it. Checking
 * first means an invalid schedule never occupies a row, so there is no such
 * thing as a saved schedule that cannot run — which is the state a worker would
 * have no way to report.
 */
export async function createSchedule(
  db: Database,
  input: ScheduleInput,
  context: RotationContext = {},
): Promise<SaveResult> {
  const check = validateRotation(toRotation('pending', input.legs, input.repeat, context));
  if (!check.ok) return { ok: false, problem: check.problem, detail: check.detail };

  // The aeroplane has to be able to fly (M4-06, §7.3). Checked here rather than
  // in `validateRotation`, because availability is a row in the database and the
  // rotation rules are pure — but it is reported as a rotation problem, because
  // to the player that is exactly what it is: the schedule is unflyable for a
  // reason about the aircraft, like `not_positioned`.
  const unavailable = await airframeUnavailability(db, input.worldId, input.airframeId);
  if (unavailable !== null) {
    return {
      ok: false,
      problem: 'airframe_unavailable',
      detail:
        unavailable === 'in_check'
          ? 'That aircraft is in a maintenance check and cannot be scheduled until it returns to service.'
          : 'That aircraft is grounded for overdue maintenance. Book the check it is due and it will fly again.',
    };
  }

  /*
   * And the crew have to exist (M5-01, §9.2). Same shape as the check above and
   * for the same reason: the pools are rows, so this cannot live in
   * `validateRotation`, but to the player it is a rotation problem — the
   * schedule cannot run, for a reason about the crew.
   *
   * This is where `RotationContext.crewLegal` has been waiting since M2-07. A
   * caller may still assert it, which the tests that are not about crew use, but
   * the default is now the database's answer rather than a permissive `true`.
   */
  if (context.crewLegal === undefined) {
    const crewProblem = await crewIllegality(
      db,
      input.worldId,
      input.airlineId,
      input.airframeId,
      input.legs,
    );
    if (crewProblem !== null) {
      return { ok: false, problem: 'crew_illegal', detail: crewProblem };
    }
  }

  return db.transaction(async (tx): Promise<SaveResult> => {
    const [row] = await tx
      .insert(schedule)
      .values({
        worldId: input.worldId,
        airlineId: input.airlineId,
        airframeId: input.airframeId,
        repeatKind: input.repeat.kind,
        // `daily` stores no days at all. The check constraint enforces the pair.
        repeatDays: input.repeat.kind === 'weekdays' ? [...input.repeat.days] : null,
      })
      .returning({ id: schedule.id });

    if (row === undefined) throw new Error('Insert returned no schedule');

    await tx.insert(scheduleLeg).values(
      input.legs.map((leg, index) => ({
        scheduleId: row.id,
        legIndex: index,
        originIcao: leg.originIcao,
        destinationIcao: leg.destinationIcao,
        departureMinute: leg.departureMinute,
        blockMinutes: leg.blockMinutes,
        turnaroundMinutes: leg.turnaroundMinutes,
      })),
    );

    return { ok: true, scheduleId: row.id };
  });
}

interface LoadedSchedule {
  worldId: string;
  airlineId: string;
  airframeId: string;
  active: boolean;
  rotation: Rotation;
}

/** Read a schedule and its legs back into the shape `@tailfin/sim` works in. */
export async function loadSchedule(
  db: Database,
  scheduleId: string,
  context: RotationContext = {},
): Promise<LoadedSchedule | null> {
  const [header] = await db.select().from(schedule).where(eq(schedule.id, scheduleId)).limit(1);
  if (header === undefined) return null;

  const legs = await db
    .select()
    .from(scheduleLeg)
    .where(eq(scheduleLeg.scheduleId, scheduleId))
    .orderBy(scheduleLeg.legIndex);

  const repeat: RepeatPattern =
    header.repeatKind === 'daily'
      ? { kind: 'daily' }
      : // The check constraint guarantees the array is present and in range for
        // `weekdays`, but the column is nullable for `daily`, so the type is not.
        {
          kind: 'weekdays',
          days: (header.repeatDays ?? []).map((d) => d as 1 | 2 | 3 | 4 | 5 | 6 | 7),
        };

  return {
    worldId: header.worldId,
    airlineId: header.airlineId,
    airframeId: header.airframeId,
    active: header.active,
    rotation: toRotation(header.id, legs, repeat, context),
  };
}

export interface MaterialiseResult {
  /** Flights written. Zero on a second roll of the same window, which is the point. */
  created: number;
  /** Flights the horizon contained that were already on the books. */
  alreadyPresent: number;
}

async function writeFlights(
  tx: Database,
  loaded: Pick<LoadedSchedule, 'worldId' | 'airlineId' | 'airframeId'>,
  scheduleId: string,
  flights: readonly MaterialisedFlight[],
): Promise<number> {
  if (flights.length === 0) return 0;

  const inserted = await tx
    .insert(flight)
    .values(
      flights.map((f) => ({
        worldId: loaded.worldId,
        airlineId: loaded.airlineId,
        scheduleId,
        airframeId: loaded.airframeId,
        originIcao: f.originIcao,
        destinationIcao: f.destinationIcao,
        scheduledDeparture: f.scheduledDeparture,
        estimatedArrival: f.scheduledArrival,
        materialisationKey: f.key,
      })),
    )
    // The idempotency guarantee, and it is the database's rather than this
    // function's: a second roll of the same window conflicts and writes nothing.
    .onConflictDoNothing({ target: [flight.worldId, flight.materialisationKey] })
    .returning({ id: flight.id, scheduledDeparture: flight.scheduledDeparture });

  for (const row of inserted) {
    await scheduleEvent(tx, {
      worldId: loaded.worldId,
      type: 'FLIGHT_DEPART',
      fireAt: row.scheduledDeparture,
      payload: { flightId: row.id },
      idempotencyKey: departureKey(row.id),
    });
  }

  return inserted.length;
}

/**
 * Roll this schedule's horizon forward, writing whatever is not already there.
 *
 * Safe to run on a timer, twice at once, or after a crash halfway through. One
 * transaction, so a failure leaves no flight without its departure event — the
 * pair that would otherwise produce an aeroplane nothing ever launches.
 */
export async function materialiseSchedule(
  db: Database,
  scheduleId: string,
  horizon: Horizon,
  context: RotationContext = {},
): Promise<MaterialiseResult> {
  const loaded = await loadSchedule(db, scheduleId, context);
  if (!loaded?.active) return { created: 0, alreadyPresent: 0 };

  const wanted = materialiseRotation(loaded.rotation, horizon);
  if (wanted.length === 0) return { created: 0, alreadyPresent: 0 };

  return db.transaction(async (tx) => {
    const created = await writeFlights(tx, loaded, scheduleId, wanted);
    return { created, alreadyPresent: wanted.length - created };
  });
}

export interface EditResult {
  cancelled: number;
  created: number;
  kept: number;
}

export type EditOutcome =
  ({ ok: true } & EditResult) | { ok: false; problem: RotationProblem; detail: string };

/**
 * Replace a schedule's legs, disturbing only future unflown flights.
 *
 * ## Why the order inside the transaction is not arbitrary
 *
 * A leg that merely moves keeps its materialisation key, because the key names a
 * slot in the schedule rather than a set of times — that is exactly what makes
 * the horizon roll idempotent. So the delete has to happen before the insert, or
 * the unique constraint rejects the row being replaced. Both in one transaction,
 * so there is no instant at which the flight does not exist.
 *
 * ## What counts as untouchable
 *
 * A flight that has already gone off-blocks. `actual_departure` is the record of
 * that, and it is read inside the transaction rather than trusted from a
 * caller's snapshot: between reading and writing, an aircraft may have left.
 */
export async function replaceScheduleLegs(
  db: Database,
  scheduleId: string,
  legs: readonly LegInput[],
  repeat: RepeatPattern,
  effectiveFrom: Date,
  horizon: Horizon,
  context: RotationContext = {},
): Promise<EditOutcome> {
  const next = toRotation(scheduleId, legs, repeat, context);
  const check = validateRotation(next);
  if (!check.ok) return { ok: false, problem: check.problem, detail: check.detail };

  const loaded = await loadSchedule(db, scheduleId, context);
  if (loaded === null) throw new Error(`No schedule ${scheduleId}`);

  return db.transaction(async (tx): Promise<EditOutcome> => {
    // Locked for the duration: two concurrent edits to one schedule would
    // otherwise each plan against the other's starting state.
    await tx
      .select({ id: schedule.id })
      .from(schedule)
      .where(eq(schedule.id, scheduleId))
      .for('update');

    const rows = await tx
      .select({
        id: flight.id,
        key: flight.materialisationKey,
        originIcao: flight.originIcao,
        destinationIcao: flight.destinationIcao,
        scheduledDeparture: flight.scheduledDeparture,
        estimatedArrival: flight.estimatedArrival,
        actualDeparture: flight.actualDeparture,
      })
      .from(flight)
      .where(and(eq(flight.scheduleId, scheduleId), gte(flight.scheduledDeparture, horizon.from)));

    const byKey = new Map<string, string>();
    const departed = new Set<string>();
    const existing: MaterialisedFlight[] = [];

    for (const row of rows) {
      if (row.key === null) continue;
      byKey.set(row.key, row.id);
      if (row.actualDeparture !== null) departed.add(row.key);
      const [rotationId = '', cycleDate = '', legIndex = '0'] = row.key.split(':');
      existing.push({
        key: row.key,
        rotationId,
        cycleDate,
        legIndex: Number(legIndex),
        originIcao: row.originIcao,
        destinationIcao: row.destinationIcao,
        scheduledDeparture: row.scheduledDeparture,
        scheduledArrival: row.estimatedArrival,
      });
    }

    const plan = applyEdit({ existing, next, effectiveFrom, horizon, departed });

    // Cancel first — see the note above.
    const cancelIds = plan.cancel.flatMap((f) => {
      const id = byKey.get(f.key);
      return id === undefined ? [] : [id];
    });
    if (cancelIds.length > 0) {
      // Only `pending` events. A departure that already fired is history, and
      // deleting its row would make the queue's record disagree with the world.
      await tx.delete(worldEvent).where(
        and(
          eq(worldEvent.worldId, loaded.worldId),
          eq(worldEvent.status, 'pending'),
          inArray(
            worldEvent.idempotencyKey,
            cancelIds.map((id) => departureKey(id)),
          ),
        ),
      );
      await tx.delete(flight).where(inArray(flight.id, cancelIds));
    }

    await tx
      .delete(scheduleLeg)
      .where(eq(scheduleLeg.scheduleId, scheduleId))
      .returning({ id: scheduleLeg.id });
    await tx.insert(scheduleLeg).values(
      legs.map((leg, index) => ({
        scheduleId,
        legIndex: index,
        originIcao: leg.originIcao,
        destinationIcao: leg.destinationIcao,
        departureMinute: leg.departureMinute,
        blockMinutes: leg.blockMinutes,
        turnaroundMinutes: leg.turnaroundMinutes,
      })),
    );
    await tx
      .update(schedule)
      .set({
        repeatKind: repeat.kind,
        repeatDays: repeat.kind === 'weekdays' ? [...repeat.days] : null,
        updatedAt: sql`now()`,
      })
      .where(eq(schedule.id, scheduleId));

    const created = await writeFlights(tx, loaded, scheduleId, plan.create);
    return { ok: true, cancelled: cancelIds.length, created, kept: plan.keep.length };
  });
}

/**
 * Roll every active schedule in a world forward.
 *
 * The shape a worker calls. There is no worker yet — nothing in any environment
 * runs the simulation, and [OPS-08] decides where it should live — so this is
 * the seam that one plugs into rather than a loop started here. Wiring a timer
 * into the web process would prejudge that decision.
 */
export async function materialiseWorld(
  db: Database,
  worldId: string,
  horizon: Horizon,
  context: RotationContext = {},
): Promise<MaterialiseResult> {
  const schedules = await db
    .select({ id: schedule.id })
    .from(schedule)
    .where(and(eq(schedule.worldId, worldId), eq(schedule.active, true)));

  let created = 0;
  let alreadyPresent = 0;
  for (const row of schedules) {
    const result = await materialiseSchedule(db, row.id, horizon, context);
    created += result.created;
    alreadyPresent += result.alreadyPresent;
  }
  return { created, alreadyPresent };
}

/** Flights this schedule has on the books from `from` onwards, in departure order. */
export async function upcomingFlights(
  db: Database,
  scheduleId: string,
  from: Date,
): Promise<{ id: string; key: string | null; scheduledDeparture: Date; originIcao: string }[]> {
  return db
    .select({
      id: flight.id,
      key: flight.materialisationKey,
      scheduledDeparture: flight.scheduledDeparture,
      originIcao: flight.originIcao,
    })
    .from(flight)
    .where(and(eq(flight.scheduleId, scheduleId), gte(flight.scheduledDeparture, from)))
    .orderBy(flight.scheduledDeparture);
}

/** Flights that outlived the schedule that made them (`schedule_id` set to null). */
export async function orphanedFlights(db: Database, worldId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(flight)
    .where(and(eq(flight.worldId, worldId), isNull(flight.scheduleId)));
  return Number(row?.count ?? 0);
}
