import { eq } from 'drizzle-orm';

import { dispatchCrew, type DispatchDecision } from '../crew/dispatch';
import { flight } from '../db/schema';
import { scheduleEvent, type EventHandler } from '../sim/event-queue';

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
 * interpolation, not rows. No weather roll and no technical roll either: M2-08
 * built `rollDisruption` and nothing wires it here, because a departure gate
 * that also decides the weather is two mechanisms in one place and the second
 * one belongs with the world's weather, not with its crew.
 *
 * What it does do is the whole crew half: legality, the duty period, and the
 * three outcomes §9.2 names.
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
    await db
      .update(flight)
      .set({
        // `cruise` rather than a phase walk: §21 computes the rest on read.
        phase: 'cruise',
        actualDeparture: at,
        estimatedArrival: arriveAt,
        crewDutyPeriodId: decision.dutyPeriodId,
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
