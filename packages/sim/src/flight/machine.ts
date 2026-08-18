import { type FlightDisruption, type FlightPhase } from '@tailfin/shared';

import { type FlightProfile } from './profile';
import { type LegProgress, legProgressAt } from './progress';
import {
  appendArrivalGround,
  appendReplannedLeg,
  buildTimeline,
  estimatedArrival,
  type FlightPlan,
  type PhaseWindow,
  type RouteLeg,
  shiftFrom,
  truncateAt,
} from './timeline';

/**
 * The flight state machine (M1-07, design doc §3.3).
 *
 * A pure reducer: `(state, command) → (state, effects)`. Nothing here reads a
 * clock, touches a database or schedules anything itself — the instant is always
 * a parameter and the effects are a description of what the caller should
 * schedule. That is CONTRIBUTING invariant 2, and it is what lets the whole
 * lifecycle be tested without a world running.
 *
 * ## Two notions of "what phase is it in"
 *
 * `state.phase` is the last **confirmed** transition — the one an event has
 * actually drained for, and therefore the one whose economics have been
 * resolved (§21: "economic resolution at flight events only").
 *
 * `phaseAt(state.timeline, t)` is where the aircraft **is**. It needs no event
 * to have fired, because the timeline already knows every boundary.
 *
 * They agree unless the event queue is behind, and when they disagree the
 * difference is exactly the backlog M1-06's `queueDepth` reports. That is the
 * right way round: the map never freezes because a worker is busy, and revenue
 * is never booked twice because a worker ran early.
 *
 * ## Failure branches
 *
 * §3.3 lists five and says they are "reachable from the phases where they make
 * sense". Which phases those are is a judgement, so each one is stated here:
 *
 *   | branch              | reachable from                                  |
 *   | ------------------- | ----------------------------------------------- |
 *   | `delayed`           | any phase before the takeoff roll, and turnaround |
 *   | `cancelled`         | any phase before the takeoff roll                |
 *   | `returned_to_stand` | pushback and taxi-out                            |
 *   | `air_return`        | departure, climb and cruise                      |
 *   | `diverted`          | any airborne phase except landing                |
 *
 * Two of those readings are worth defending. The doc glosses returned-to-stand
 * as "pre-taxi"; taken literally that is boarding and pushback, but an aircraft
 * still at the stand has nothing to return to — a problem there is a delay or a
 * cancellation. The phases where returning to a stand is a real thing to do are
 * the ones where the aircraft has left it and has not yet flown, so that is the
 * set used. And air-return stops at cruise because after top of descent the
 * aircraft is committed to the destination area; turning round then is a
 * diversion that happens to name the origin, and `DIVERT` already expresses it.
 */

export interface FlightState {
  readonly plan: FlightPlan;
  /** Every phase boundary this flight will pass, as it currently stands. */
  readonly timeline: readonly PhaseWindow[];
  /** The airborne tracks flown. Empty until takeoff, and after a cancellation. */
  readonly legs: readonly RouteLeg[];
  /** Index into `timeline` of the last confirmed transition. */
  readonly index: number;
  /** `timeline[index].phase`, kept alongside so the server can persist it directly. */
  readonly phase: FlightPhase;
  readonly disruption: FlightDisruption | null;
  /** Where it will actually land. Changes on an air return or a diversion. */
  readonly arrivalIcao: string;
  /** Off-blocks. */
  readonly actualDeparture: Date | null;
  /** On-blocks. */
  readonly actualArrival: Date | null;
  /** Total minutes of delay applied, which survives a later disruption overwriting `disruption`. */
  readonly delayMinutes: number;
  /**
   * Bumped every time the timeline is rebuilt.
   *
   * Load-bearing rather than diagnostic. The event queue is idempotent by key
   * (M1-06), so rescheduling a flight's next transition after a diversion under
   * the *same* key would be silently ignored and the flight would stop moving.
   * The revision goes in the key, so a replan supersedes rather than collides.
   */
  readonly revision: number;
}

export type FlightCommand =
  | { type: 'ADVANCE'; at: Date }
  | { type: 'DELAY'; at: Date; minutes: number }
  | { type: 'CANCEL'; at: Date }
  | { type: 'RETURN_TO_STAND'; at: Date }
  | { type: 'AIR_RETURN'; at: Date }
  | { type: 'DIVERT'; at: Date; toIcao: string; distanceNm: number };

export type FlightEffect =
  /** Pending wakeups scheduled under this revision or earlier no longer describe the flight. */
  | { kind: 'supersede'; throughRevision: number }
  /** Wake the flight at `at`; it will then be in `phase`. `key` is unique per flight. */
  | { kind: 'advance'; at: Date; phase: FlightPhase; key: string };

export type FlightTransition =
  | { ok: true; state: FlightState; effects: FlightEffect[] }
  | { ok: false; reason: string; state: FlightState };

const PRE_TAKEOFF = new Set<FlightPhase>(['scheduled', 'boarding', 'pushback', 'taxi_out']);
const OFF_STAND_PRE_TAKEOFF = new Set<FlightPhase>(['pushback', 'taxi_out']);
const DELAYABLE = new Set<FlightPhase>([...PRE_TAKEOFF, 'turnaround']);
const AIR_RETURNABLE = new Set<FlightPhase>(['departure', 'climb', 'cruise']);
const DIVERTABLE = new Set<FlightPhase>(['departure', 'climb', 'cruise', 'descent', 'approach']);

/** The first state: scheduled, on time, nothing flown. */
export function planFlight(plan: FlightPlan, profile: FlightProfile): FlightState {
  const { windows, leg } = buildTimeline(plan, profile);
  return {
    plan,
    timeline: windows,
    // The leg is known from the start — the aircraft has not flown it yet, and
    // `legProgressAt` returns null until its `startedAt` passes.
    legs: [leg],
    index: 0,
    phase: 'scheduled',
    disruption: null,
    arrivalIcao: plan.destinationIcao,
    actualDeparture: null,
    actualArrival: null,
    delayMinutes: 0,
    revision: 0,
  };
}

/** The wakeup that moves the flight to its next phase, or null once it is idle. */
export function nextAdvance(state: FlightState): FlightEffect | null {
  const next = state.timeline[state.index + 1];
  if (!next) return null;
  return {
    kind: 'advance',
    at: next.from,
    phase: next.phase,
    key: `advance:r${String(state.revision)}:w${String(state.index + 1)}`,
  };
}

/** A flight that has reached `idle` has nothing left to do. */
export function isTerminal(state: FlightState): boolean {
  return state.index >= state.timeline.length - 1;
}

/** On-blocks, predicted or actual. Null for a flight that never arrives. */
export function estimatedArrivalOf(state: FlightState): Date | null {
  return estimatedArrival(state.timeline);
}

function fail(state: FlightState, reason: string): FlightTransition {
  return { ok: false, reason, state };
}

function succeed(state: FlightState, effects: FlightEffect[]): FlightTransition {
  return { ok: true, state, effects };
}

/** Rebuilds the derived fields that must never disagree with the timeline. */
function settle(
  state: FlightState,
  next: Omit<FlightState, 'phase'> & { phase?: FlightPhase },
): FlightState {
  const window = next.timeline[next.index];
  if (!window) throw new Error(`Flight state index ${String(next.index)} is off its timeline`);
  return { ...state, ...next, phase: window.phase };
}

export function reduce(
  state: FlightState,
  command: FlightCommand,
  profile: FlightProfile,
): FlightTransition {
  switch (command.type) {
    case 'ADVANCE':
      return advance(state, command.at);
    case 'DELAY':
      return delay(state, command.at, command.minutes);
    case 'CANCEL':
      return cancel(state, command.at);
    case 'RETURN_TO_STAND':
      return returnToStand(state, command.at, profile);
    case 'AIR_RETURN':
      return airReturn(state, command.at, profile);
    case 'DIVERT':
      return divert(state, command.at, command.toIcao, command.distanceNm, profile);
  }
}

function advance(state: FlightState, at: Date): FlightTransition {
  const next = state.timeline[state.index + 1];
  if (!next) return fail(state, `The flight is already ${state.phase} and has nothing left to do`);
  if (at.getTime() < next.from.getTime()) {
    return fail(
      state,
      `Not due to enter ${next.phase} until ${next.from.toISOString()}, asked at ${at.toISOString()}`,
    );
  }

  // The boundary instant, not `at`. A drain running late means the queue is
  // behind, not that the aircraft pushed back late, and recording queue lag as
  // an operational time would corrupt every punctuality figure downstream.
  const settled = settle(state, {
    ...state,
    index: state.index + 1,
    actualDeparture: next.phase === 'pushback' ? next.from : state.actualDeparture,
    actualArrival: next.phase === 'turnaround' ? next.from : state.actualArrival,
  });

  const wakeup = nextAdvance(settled);
  return succeed(settled, wakeup ? [wakeup] : []);
}

function delay(state: FlightState, at: Date, minutes: number): FlightTransition {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return fail(state, `A delay must be a positive number of minutes, got ${String(minutes)}`);
  }
  if (!DELAYABLE.has(state.phase)) {
    return fail(
      state,
      `Cannot delay a flight in ${state.phase}: once it is rolling, its arrival is set by the ` +
        'air rather than by a decision. Use DIVERT or AIR_RETURN.',
    );
  }

  const timeline = shiftFrom(state.timeline, at, minutes);
  const settled = settle(state, {
    ...state,
    timeline,
    // A leg that has not started yet moves with the flight; one already flown
    // stays where it happened.
    legs: state.legs.map((leg) =>
      leg.startedAt.getTime() >= at.getTime()
        ? {
            ...leg,
            startedAt: new Date(leg.startedAt.getTime() + minutes * 60_000),
            endsAt: new Date(leg.endsAt.getTime() + minutes * 60_000),
          }
        : leg,
    ),
    delayMinutes: state.delayMinutes + minutes,
    // Only claimed when nothing worse has happened. `delayMinutes` carries the
    // fact regardless, so a flight that was delayed and then diverted still
    // reports both.
    disruption: state.disruption ?? 'delayed',
    revision: state.revision + 1,
  });

  return replanned(state, settled);
}

function cancel(state: FlightState, at: Date): FlightTransition {
  if (!PRE_TAKEOFF.has(state.phase)) {
    return fail(
      state,
      `Cannot cancel a flight in ${state.phase}: §3.3 allows it pre-departure only`,
    );
  }

  const timeline = truncateAt(state.timeline, at);
  const index = timeline.length - 1;
  timeline.push({ phase: 'idle', from: at, to: null });

  const settled = settle(state, {
    ...state,
    timeline,
    // It never got airborne, so there is no track to draw it on.
    legs: [],
    index: index + 1,
    // The aircraft is on a stand at the origin. Leaving `arrivalIcao` pointing
    // at a destination it never left for would put it on the wrong side of the
    // world on the map, and in the wrong place for its next rotation.
    arrivalIcao: state.plan.originIcao,
    disruption: 'cancelled',
    revision: state.revision + 1,
  });

  return replanned(state, settled);
}

function returnToStand(state: FlightState, at: Date, profile: FlightProfile): FlightTransition {
  if (!OFF_STAND_PRE_TAKEOFF.has(state.phase)) {
    return fail(
      state,
      `Cannot return a flight in ${state.phase} to stand: it is either still on one or already flying`,
    );
  }

  const timeline = truncateAt(state.timeline, at);
  const index = timeline.length - 1;
  // Taxiing back and being serviced again is exactly the arrival tail, so it is
  // the same code — the aircraft is on a stand needing a turnaround either way.
  appendArrivalGround(timeline, at, state.plan.turnaroundMinutes, profile);

  const settled = settle(state, {
    ...state,
    timeline,
    legs: [],
    index,
    // Back where it started, for the same reason a cancellation is.
    arrivalIcao: state.plan.originIcao,
    disruption: 'returned_to_stand',
    revision: state.revision + 1,
  });

  return replanned(state, settled);
}

function airReturn(state: FlightState, at: Date, profile: FlightProfile): FlightTransition {
  if (!AIR_RETURNABLE.has(state.phase)) {
    return fail(
      state,
      `Cannot air-return a flight in ${state.phase}: past top of descent it is committed to the ` +
        'destination area, and turning back is a diversion that names the origin',
    );
  }
  if (state.legs.length !== 1) {
    return fail(
      state,
      'This flight has already been replanned once, so it is no longer over its original track. ' +
        'Use DIVERT and name the airport.',
    );
  }

  const progress = legProgressAt(state, at, profile);
  if (!progress) return fail(state, `The flight is not airborne at ${at.toISOString()}`);

  // Back to where it started is exactly as far as it has come — the distance
  // actually covered, not the fraction of the time that has passed. An aircraft
  // twenty minutes into a climb is nowhere near twenty minutes' worth of cruise
  // from home, and `coveredNm` is the same number the map has been drawing.
  const distanceBack = progress.coveredNm;
  return replan(state, at, state.plan.originIcao, distanceBack, 'air_return', progress, profile);
}

function divert(
  state: FlightState,
  at: Date,
  toIcao: string,
  distanceNm: number,
  profile: FlightProfile,
): FlightTransition {
  if (!DIVERTABLE.has(state.phase)) {
    return fail(
      state,
      `Cannot divert a flight in ${state.phase}: it is not airborne, or it is already on the runway`,
    );
  }
  if (toIcao === state.arrivalIcao) {
    return fail(state, `The flight is already going to ${toIcao}`);
  }
  if (!Number.isFinite(distanceNm) || distanceNm < 0) {
    return fail(state, `Diversion distance must be zero or more, got ${String(distanceNm)}`);
  }

  const progress = legProgressAt(state, at, profile);
  if (!progress) return fail(state, `The flight is not airborne at ${at.toISOString()}`);

  return replan(state, at, toIcao, distanceNm, 'diverted', progress, profile);
}

/**
 * The shared half of an air return and a diversion.
 *
 * Both cut the current leg where the aircraft is, record how far along its track
 * it got, and fly a fresh leg from there. The only difference is which airport
 * the new leg is aimed at and which disruption is recorded, which is why they
 * are one function.
 */
function replan(
  state: FlightState,
  at: Date,
  toIcao: string,
  distanceNm: number,
  disruption: FlightDisruption,
  progress: LegProgress,
  profile: FlightProfile,
): FlightTransition {
  const timeline = truncateAt(state.timeline, at);
  const index = timeline.length - 1;
  const touchdown = appendReplannedLeg(
    timeline,
    at,
    distanceNm,
    state.plan.cruiseSpeedKt,
    state.plan.turnaroundMinutes,
    profile,
  );

  const legs: RouteLeg[] = state.legs.map((leg) =>
    leg === progress.leg ? { ...leg, endsAt: at, flownFraction: progress.fraction } : leg,
  );
  legs.push({
    // Open water, not an airport. The previous leg's `flownFraction` says where.
    fromIcao: null,
    toIcao,
    distanceNm,
    startedAt: at,
    endsAt: touchdown,
    flownFraction: 1,
  });

  const settled = settle(state, {
    ...state,
    timeline,
    legs,
    index,
    arrivalIcao: toIcao,
    disruption,
    revision: state.revision + 1,
  });

  return replanned(state, settled);
}

/**
 * The effects every timeline rebuild produces.
 *
 * `supersede` first: whatever was scheduled under the old revision describes a
 * flight that no longer exists, and leaving it pending would fire an advance the
 * reducer then has to refuse.
 */
function replanned(before: FlightState, after: FlightState): FlightTransition {
  const effects: FlightEffect[] = [{ kind: 'supersede', throughRevision: before.revision }];
  const wakeup = nextAdvance(after);
  if (wakeup) effects.push(wakeup);
  return succeed(after, effects);
}
