import { eq } from 'drizzle-orm';

import type { FlightDisruption } from '@tailfin/shared';
import { handlingPriceFactor } from '@tailfin/sim';
import type { DisruptionRoll } from '@tailfin/sim';

import { lockDispatchAvailability, type DispatchAvailability } from '../aircraft/maintenance';
import { resolveDisruptionResponse } from '../automation/response';
import { readSetting } from '../automation/store';
import { raiseOperationsTask } from '../automation/tasks';
import { dispatchCrew, type DispatchDecision } from '../crew/dispatch';
import { flight } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { handlingArrangementFor, handlingPriceBalanceOf } from '../ground/contracts';
import { holdsRoleSeat } from '../office/authority';
import { scheduleEvent, type EventHandler } from '../sim/event-queue';

import { rollGroundDisruption } from './disruption';
import { arrivalKey } from './settle';

import type { Database } from '../db/client';

/**
 * `FLIGHT_DEPART` — the moment a flight is allowed to go, or is not (M5-02).
 *
 * ## Why this handler exists now, and did not before
 *
 * `schedule/store.ts` has queued `FLIGHT_DEPART` since M2, and nothing has ever
 * handled it: SCALE-05 parked those events as `unsupported` rather than losing
 * them, and `handlers.ts` said plainly that inventing a departure would be *"the
 * accidental decision ADR-0019's boundary exists to prevent"*.
 *
 * M5-02 is the decision, taken deliberately. Its fourth acceptance criterion
 * asks for crew legality to be *"a hard rule at departure"*, and a hard rule
 * needs a departure to be hard at. So this is a **dispatch gate**, not a
 * flight-operations model: it asks whether the aeroplane may push back, and if
 * it may, it releases it to the `FLIGHT_ARRIVE` handler that has existed since
 * M2-06.
 *
 * ## What it deliberately does not do
 *
 * No boarding, no pushback, no taxi, no phase ticking — §21 says flight state is
 * computed on read, and the phases between `scheduled` and `cruise` are
 * interpolation, not rows.
 *
 * ## The availability gate (IMPROVE-03)
 *
 * The first thing it asks, and the reason is a timing gap. `schedule/store.ts`
 * checks whether an aeroplane can fly when a rotation is **authored**, which is
 * the only moment it could — and a departure happens later. In between, the
 * maintenance sweep can ground the airframe or the player can book it into a
 * check, and nothing enforced the change: the queued `FLIGHT_DEPART` released
 * the flight, opened a duty period and scheduled an arrival, in an aircraft
 * sitting in a hangar.
 *
 * So the gate reads the airframe **under `FOR UPDATE`**, before the disruption
 * roll and long before dispatch. The lock is what makes it a gate rather than a
 * suggestion: `bookCheck` takes the same lock before it writes a status, so a
 * booking racing a dispatch waits instead of interleaving.
 *
 * Ahead of the roll as well as of dispatch, because an aeroplane that cannot fly
 * should not be rolled for a technical fault it will never get the chance to
 * suffer — and the roll commits a delay of its own, which would decide the
 * flight's fate before anything had asked whether it had one.
 *
 * `applyUnavailableAircraft` has the two outcomes and why they differ.
 *
 * ## The ground disruption roll (M5-05)
 *
 * M5-05 wires `rollDisruption` in for the ground half: before the crew are
 * committed, a flight faces a roll for whatever is likely to go wrong on the
 * stand — a technical fault from its maintenance condition, and (M5-06) the
 * reliability of the ramp handler it contracted at the origin
 * ({@link rollGroundDisruption}). It is
 * rolled *before* dispatch on purpose, so a cancellation cannot strand a duty
 * period, and *once* per flight (only while `disruption` is null), so a delayed
 * flight retried at its new time is not rolled against the same stream again.
 *
 * The rest is the whole crew half: legality, the duty period, and the three
 * outcomes §9.2 names.
 *
 * ## Replay safety
 *
 * A flight that has already departed, been cancelled or been settled is left
 * exactly as it is. The queue can deliver an event twice — after a restart, a
 * retry, or two workers racing — and the second delivery must not open a second
 * duty period against the same aeroplane. The partial unique index on
 * `crew_duty_period` would refuse that anyway; this refuses it earlier and more
 * legibly.
 */

export type DepartureOutcome =
  | { status: 'departed'; dutyPeriodId: string; marginMinutes: number; usedReserve: boolean }
  | { status: 'delayed'; untilAt: Date; reason: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'already-handled' }
  | { status: 'not-found' };

export interface DepartureDeps {
  /** Overridable so the tests can drive a decision without a crew base. */
  dispatch?: typeof dispatchCrew;
  /** Overridable so the tests can force, or silence, the ground disruption roll. */
  disruption?: typeof rollGroundDisruption;
  /**
   * Whether the aeroplane may push back (IMPROVE-03).
   *
   * Overridable so a test can pose a grounding without a fleet, and so the
   * concurrency test can interleave a booking deliberately. Production always
   * uses {@link lockDispatchAvailability}, which is the locking read.
   */
  availability?: typeof lockDispatchAvailability;
}

/**
 * A departure attempt, at the instant the queue says it is due.
 *
 * `at` is **game time** — the event's `fire_at`. A delayed flight is retried by
 * scheduling a second `FLIGHT_DEPART`, so `at` is when this attempt happens and
 * not necessarily when the flight was meant to leave; the difference between the
 * two is exactly the delay the player sees.
 */
export async function departFlight(
  db: Database,
  flightId: string,
  at: Date,
  deps: DepartureDeps = {},
): Promise<DepartureOutcome> {
  const rows = await db
    .select({
      id: flight.id,
      worldId: flight.worldId,
      airlineId: flight.airlineId,
      airframeId: flight.airframeId,
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      phase: flight.phase,
      disruption: flight.disruption,
      scheduledDeparture: flight.scheduledDeparture,
      estimatedArrival: flight.estimatedArrival,
      actualDeparture: flight.actualDeparture,
    })
    .from(flight)
    .where(eq(flight.id, flightId))
    .limit(1);

  const row = rows[0];
  if (!row) return { status: 'not-found' };
  if (row.actualDeparture !== null || row.disruption === 'cancelled' || row.phase !== 'scheduled') {
    return { status: 'already-handled' };
  }

  /*
   * Can this aeroplane actually go? (IMPROVE-03)
   *
   * First, and before anything is committed. `schedule/store.ts` checks
   * availability when a rotation is *authored*, which is the only moment it
   * could check — and a departure happens later, by which time the maintenance
   * sweep may have grounded the aeroplane or the player may have booked it into
   * a check. Nothing enforced the change, so a queued flight could leave in an
   * aircraft that was in a hangar.
   *
   * Ahead of the disruption roll as well as of dispatch. An aeroplane that
   * cannot fly should not be rolled for a technical fault it will never get the
   * chance to suffer, and the roll commits a delay of its own — so rolling first
   * would decide the flight's fate before asking whether it had one.
   *
   * The read takes `FOR UPDATE` on the airframe, which is what makes this a gate
   * rather than a suggestion: `bookCheck` locks the same row before it changes
   * the status, so a booking racing a dispatch waits for it instead of
   * interleaving with it.
   */
  const availability = await (deps.availability ?? lockDispatchAvailability)(
    db,
    row.worldId,
    row.airframeId,
  );
  if (!availability.available) {
    return applyUnavailableAircraft(db, row, at, availability);
  }

  /*
   * The ground disruption roll, before any crew are committed and only once — a
   * flight already carrying a disruption (a crew delay, or a disruption from a
   * previous attempt) has had its roll and is not rolled again.
   */
  if (row.disruption === null) {
    const rollDisruptionFn = deps.disruption ?? rollGroundDisruption;
    const disruption = await rollDisruptionFn(db, {
      flightId: row.id,
      worldId: row.worldId,
      airframeId: row.airframeId,
      airlineId: row.airlineId,
      originIcao: row.originIcao,
    });
    if (disruption !== null) {
      return applyGroundDisruption(db, row, at, disruption);
    }
  }

  /*
   * Block time is the *planned* span, carried forward from the schedule. A
   * delayed departure lands late by exactly its delay: the aeroplane does not
   * fly faster to make it up, and pretending otherwise would quietly erase the
   * propagation that makes a tight rotation fail in the first place.
   */
  const blockMs = row.estimatedArrival.getTime() - row.scheduledDeparture.getTime();
  const arriveAt = new Date(at.getTime() + blockMs);

  const dispatch = deps.dispatch ?? dispatchCrew;
  const decision = await dispatch(db, {
    worldId: row.worldId,
    airlineId: row.airlineId,
    airframeId: row.airframeId,
    flightId: row.id,
    originIcao: row.originIcao,
    destinationIcao: row.destinationIcao,
    departAt: at,
    arriveAt,
  });

  return applyDecision(db, row, at, arriveAt, decision);
}

interface FlightRow {
  id: string;
  worldId: string;
  airlineId: string;
  originIcao: string;
  scheduledDeparture: Date;
}

async function applyDecision(
  db: Database,
  row: FlightRow,
  at: Date,
  arriveAt: Date,
  decision: DispatchDecision,
): Promise<DepartureOutcome> {
  const delayMinutes = (at.getTime() - row.scheduledDeparture.getTime()) / 60_000;

  if (decision.status === 'go') {
    /*
     * Snapshot what the turn's handling costs, at the moment the turn happens
     * (M5-06, §9.3). The arrangement is mutable and the flight is not: resolving
     * it again at arrival billed the flight for whoever handles the station by
     * then, and made a replay of an old arrival produce a different figure.
     *
     * The same shape as the fuel curve, which the settlement already reads at
     * the stored departure instant rather than at the arrival.
     */
    const economy = await loadWorldEconomyConfig(db, row.worldId);
    const arrangement = await handlingArrangementFor(
      db,
      row.airlineId,
      row.originIcao,
      'ramp_baggage',
      economy,
    );

    await db
      .update(flight)
      .set({
        // `cruise` rather than a phase walk: §21 computes the rest on read.
        phase: 'cruise',
        actualDeparture: at,
        estimatedArrival: arriveAt,
        crewDutyPeriodId: decision.dutyPeriodId,
        handlingPriceFactor: handlingPriceFactor(arrangement, handlingPriceBalanceOf(economy)),
        // A flight that left late is a delayed flight even though it left: the
        // cause was set by whatever held it, and is not overwritten here.
        ...(delayMinutes > 0 ? { disruption: 'delayed' as const } : {}),
      })
      .where(eq(flight.id, row.id));

    await scheduleEvent(db, {
      worldId: row.worldId,
      type: 'FLIGHT_ARRIVE',
      fireAt: arriveAt,
      payload: { flightId: row.id },
      idempotencyKey: arrivalKey(row.id),
    });

    return {
      status: 'departed',
      dutyPeriodId: decision.dutyPeriodId,
      marginMinutes: decision.marginMinutes,
      usedReserve: decision.usedReserve,
    };
  }

  if (decision.status === 'delay') {
    await db
      .update(flight)
      .set({ disruption: 'delayed', disruptionCause: decision.cause })
      .where(eq(flight.id, row.id));

    /*
     * A second attempt, keyed by the instant it is due. `departureKey` is
     * already spent on the first one, and reusing it would make the retry a
     * silent no-op — the flight would sit `delayed` for ever with nothing
     * scheduled to look at it again.
     */
    await scheduleEvent(db, {
      worldId: row.worldId,
      type: 'FLIGHT_DEPART',
      fireAt: decision.untilAt,
      payload: { flightId: row.id },
      idempotencyKey: `flight:${row.id}:depart:${decision.untilAt.toISOString()}`,
    });

    return { status: 'delayed', untilAt: decision.untilAt, reason: decision.reason };
  }

  await db
    .update(flight)
    .set({
      // Where `machine.ts` puts a cancelled flight: it never left the stand.
      phase: 'idle',
      disruption: 'cancelled',
      disruptionCause: decision.cause === 'crew_timeout' ? 'crew_timeout' : null,
    })
    .where(eq(flight.id, row.id));

  return { status: 'cancelled', reason: decision.reason };
}

/**
 * What happens to a flight whose aeroplane cannot fly (IMPROVE-03).
 *
 * Two shapes, because the two states mean different things about the future.
 *
 * **A check that ends at a known instant is worth waiting for.** The flight is
 * delayed to `checkCompletesAt` and a second `FLIGHT_DEPART` is scheduled for
 * then — the same retry mechanism a crew delay uses, keyed by the instant so it
 * is a distinct event. The worker's own maintenance sweep releases the airframe
 * at that time, so the retry finds it in service.
 *
 * **A grounding is not.** It has no end date: an airframe is grounded because it
 * is unairworthy, and it leaves that state only when the player books the check
 * that fixes it. Delaying to an instant that does not exist is how a flight gets
 * silently stranded, so this cancels.
 *
 * ## Why the retry cancels rather than delaying again
 *
 * A flight arriving here with a disruption already on it has been delayed once.
 * Delaying it again would reschedule to the same instant, which
 * `scheduleEvent`'s idempotency key refuses — leaving the flight `delayed` with
 * nothing queued to look at it, which is exactly the stranding the criterion
 * forbids. And production has no worker (OPS-12), so a check there never
 * completes at all: one delay, then a decision, is the only bounded shape.
 *
 * The cause is `technical` in every case, which is the existing vocabulary for
 * "the aeroplane", and the task kind is `disruption_review` — the one the
 * automation ladder already raises when a delay wants a human to look at it.
 * Inventing a third spelling for the same idea would leave the disruption
 * system with a vocabulary nobody can enumerate. The `detail` carries what is
 * specific: which state the aircraft is in, and until when.
 */
async function applyUnavailableAircraft(
  db: Database,
  row: FlightRow & { airframeId: string; disruption: FlightDisruption | null },
  at: Date,
  availability: Extract<DispatchAvailability, { available: false }>,
): Promise<DepartureOutcome> {
  const state = availability.status === 'in_check' ? 'in a maintenance check' : 'grounded';
  const firstAttempt = row.disruption === null;
  const waitUntil =
    availability.status === 'in_check' &&
    availability.checkCompletesAt !== null &&
    availability.checkCompletesAt.getTime() > at.getTime()
      ? availability.checkCompletesAt
      : null;

  if (firstAttempt && waitUntil !== null) {
    await db
      .update(flight)
      .set({ disruption: 'delayed', disruptionCause: 'technical' })
      .where(eq(flight.id, row.id));

    await scheduleEvent(db, {
      worldId: row.worldId,
      type: 'FLIGHT_DEPART',
      fireAt: waitUntil,
      payload: { flightId: row.id },
      idempotencyKey: `flight:${row.id}:depart:${waitUntil.toISOString()}`,
    });

    await raiseOperationsTask(db, {
      worldId: row.worldId,
      airlineId: row.airlineId,
      system: 'disruption',
      kind: 'disruption_review',
      subjectId: row.id,
      detail: `Held: the aircraft is ${state} until ${waitUntil.toISOString()}.`,
    });

    return {
      status: 'delayed',
      untilAt: waitUntil,
      reason: `The aircraft is ${state}; the departure waits for it to be released.`,
    };
  }

  await cancelFlight(db, row.id, 'technical');
  await raiseOperationsTask(db, {
    worldId: row.worldId,
    airlineId: row.airlineId,
    system: 'disruption',
    kind: 'disruption_review',
    subjectId: row.id,
    detail: `Cancelled: the aircraft is ${state} and could not be released in time.`,
  });

  return {
    status: 'cancelled',
    reason: `The aircraft is ${state}, so the flight could not depart.`,
  };
}

/**
 * Turn a ground disruption roll into a delay or a cancellation on the flight row.
 *
 * A delay reschedules a second `FLIGHT_DEPART` at the new time — keyed by that
 * time, like the crew delay, so the retry is a distinct event — and records the
 * cause, which stops the retry rolling again. A cancellation leaves the aeroplane
 * on the stand where `machine.ts` puts a cancelled flight. No crew were committed,
 * so there is no duty period to unwind.
 */
async function applyGroundDisruption(
  db: Database,
  row: FlightRow,
  at: Date,
  roll: DisruptionRoll,
): Promise<DepartureOutcome> {
  if (roll.outcome === 'delay') {
    // The automation ladder governs the *response* to a delay (ADR-0023): the
    // player's policy may cancel it to protect the rotation, or it waits for
    // them. The mechanical delay is already decided; this decides what to do
    // about it.
    const setting = await readSetting(db, row.airlineId, 'disruption');
    // Delegation needs the Ops Controller seat; only ask when it could matter.
    const hasController =
      setting.mode === 'delegated'
        ? await holdsRoleSeat(db, row.airlineId, 'ops-controller')
        : false;
    const response = resolveDisruptionResponse(setting, roll.delayMinutes, { hasController });

    if (response.action === 'cancel') {
      await cancelFlight(db, row.id, roll.cause);
      return {
        status: 'cancelled',
        reason: `Your disruption policy cancelled it — a ${roll.cause} fault would have delayed it ${String(roll.delayMinutes)} min.`,
      };
    }

    const untilAt = new Date(at.getTime() + roll.delayMinutes * 60_000);
    await db
      .update(flight)
      .set({ disruption: 'delayed', disruptionCause: roll.cause })
      .where(eq(flight.id, row.id));

    await scheduleEvent(db, {
      worldId: row.worldId,
      type: 'FLIGHT_DEPART',
      fireAt: untilAt,
      payload: { flightId: row.id },
      idempotencyKey: `flight:${row.id}:depart:${untilAt.toISOString()}`,
    });

    if (response.taskKind !== null) {
      await raiseOperationsTask(db, {
        worldId: row.worldId,
        airlineId: row.airlineId,
        system: 'disruption',
        kind: response.taskKind,
        subjectId: row.id,
        detail: `A ${roll.cause} fault delayed this flight ${String(roll.delayMinutes)} min.`,
      });
    }

    return { status: 'delayed', untilAt, reason: `A ${roll.cause} fault delayed the departure.` };
  }

  // A mechanical cancellation — the aeroplane broke — is not a decision the
  // policy can undo. It stands, and the disruption cost bills the passengers.
  await cancelFlight(db, row.id, roll.cause);
  return { status: 'cancelled', reason: `A ${roll.cause} fault cancelled the flight.` };
}

/** Ground a flight where `machine.ts` puts a cancelled one: it never left the stand. */
async function cancelFlight(
  db: Database,
  flightId: string,
  cause: DisruptionRoll['cause'],
): Promise<void> {
  await db
    .update(flight)
    .set({ phase: 'idle', disruption: 'cancelled', disruptionCause: cause })
    .where(eq(flight.id, flightId));
}

/**
 * The `FLIGHT_DEPART` handler, for the registry `drainDueEvents` takes.
 *
 * Note what is *not* an error here. A cancelled or delayed flight is a normal
 * outcome and the event is done; only a payload with no flight id, or one
 * pointing at a flight that does not exist, throws — those mean the queue and
 * the flight table disagree, which is worth failing loudly for.
 */
export function createFlightDepartHandler(deps: DepartureDeps = {}): EventHandler {
  return async (event, { payload, tx }) => {
    const flightId = payload.flightId;
    if (typeof flightId !== 'string') {
      throw new Error(`FLIGHT_DEPART ${event.id} has no flightId in its payload`);
    }

    const outcome = await departFlight(tx, flightId, event.fireAt, deps);
    if (outcome.status === 'not-found') {
      throw new Error(`FLIGHT_DEPART ${event.id} refers to unknown flight ${flightId}`);
    }
  };
}
