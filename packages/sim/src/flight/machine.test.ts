import { describe, expect, it } from 'vitest';

import { type FlightPhase } from '@tailfin/shared';

import {
  type FlightCommand,
  type FlightEffect,
  type FlightState,
  type FlightTransition,
  estimatedArrivalOf,
  isTerminal,
  nextAdvance,
  planFlight,
  reduce,
} from './machine';
import { DEFAULT_FLIGHT_PROFILE, DEFAULT_TURNAROUND_MINUTES, type FlightProfile } from './profile';
import { addMinutes, type FlightPlan, phaseAt, type PhaseWindow } from './timeline';

/**
 * The flight state machine, transition by transition.
 *
 * M1-07's first acceptance criterion is that **every** transition is covered
 * including all five failure branches, so the nominal ladder is walked one rung
 * at a time rather than in a single loop, and each failure branch gets both the
 * phases it is allowed from and the phases it is refused from.
 */

const PROFILE: FlightProfile = DEFAULT_FLIGHT_PROFILE;
const CREATED = new Date('2024-10-20T06:00:00.000Z');
const OFF_BLOCKS = new Date('2024-10-20T08:00:00.000Z');

function longHaul(overrides: Partial<FlightPlan> = {}): FlightPlan {
  return {
    originIcao: 'EHAM',
    destinationIcao: 'KJFK',
    distanceNm: 3157,
    cruiseSpeedKt: 480,
    createdAt: CREATED,
    scheduledDeparture: OFF_BLOCKS,
    turnaroundMinutes: DEFAULT_TURNAROUND_MINUTES,
    ...overrides,
  };
}

const NOMINAL_ORDER: FlightPhase[] = [
  'scheduled',
  'boarding',
  'pushback',
  'taxi_out',
  'departure',
  'climb',
  'cruise',
  'descent',
  'approach',
  'landing',
  'taxi_in',
  'turnaround',
  'idle',
];

function ok(result: FlightTransition): { state: FlightState; effects: FlightEffect[] } {
  if (!result.ok) throw new Error(`expected the command to be accepted, but: ${result.reason}`);
  return { state: result.state, effects: result.effects };
}

function refused(result: FlightTransition): string {
  if (result.ok) throw new Error('expected the command to be refused, but it was accepted');
  return result.reason;
}

function windowOf(state: FlightState): PhaseWindow {
  const window = state.timeline[state.index];
  if (!window) throw new Error('a flight state always sits on a window');
  return window;
}

/** An instant comfortably inside the phase the flight is confirmed to be in. */
function midway(state: FlightState): Date {
  const window = windowOf(state);
  if (!window.to) return addMinutes(window.from, 10);
  return new Date((window.from.getTime() + window.to.getTime()) / 2);
}

/** Advances, on time, until the flight is confirmed in `phase`. */
function runTo(state: FlightState, phase: FlightPhase): FlightState {
  let current = state;
  while (current.phase !== phase) {
    const next = current.timeline[current.index + 1];
    if (!next) throw new Error(`the flight reached ${current.phase} without passing ${phase}`);
    current = ok(reduce(current, { type: 'ADVANCE', at: next.from }, PROFILE)).state;
  }
  return current;
}

function advanceOnce(state: FlightState): FlightTransition {
  const next = state.timeline[state.index + 1];
  if (!next) throw new Error('the flight has nothing left to advance to');
  return reduce(state, { type: 'ADVANCE', at: next.from }, PROFILE);
}

describe('planFlight', () => {
  it('starts scheduled, on time, with nothing flown', () => {
    const state = planFlight(longHaul(), PROFILE);
    expect(state.phase).toBe('scheduled');
    expect(state.disruption).toBeNull();
    expect(state.delayMinutes).toBe(0);
    expect(state.actualDeparture).toBeNull();
    expect(state.actualArrival).toBeNull();
    expect(state.arrivalIcao).toBe('KJFK');
    expect(state.revision).toBe(0);
    expect(isTerminal(state)).toBe(false);
  });

  it('offers the first wakeup, at the moment boarding starts', () => {
    const state = planFlight(longHaul(), PROFILE);
    const wakeup = nextAdvance(state);
    expect(wakeup).toEqual({
      kind: 'advance',
      at: addMinutes(OFF_BLOCKS, -PROFILE.boardingMinutes),
      phase: 'boarding',
      key: 'advance:r0:w1',
    });
  });
});

describe('the nominal ladder', () => {
  it('walks every transition of §3.3 in order', () => {
    let state = planFlight(longHaul(), PROFILE);
    const seen: FlightPhase[] = [state.phase];

    // One rung at a time, each asserted, so a missing or reordered transition
    // names itself rather than showing up as a wrong final phase.
    for (const expected of NOMINAL_ORDER.slice(1)) {
      const { state: next } = ok(advanceOnce(state));
      expect(next.phase).toBe(expected);
      seen.push(next.phase);
      state = next;
    }

    expect(seen).toEqual(NOMINAL_ORDER);
    expect(isTerminal(state)).toBe(true);
    expect(state.disruption).toBeNull();
    expect(state.revision).toBe(0);
  });

  it('emits exactly one wakeup per transition, and none at the end', () => {
    let state = planFlight(longHaul(), PROFILE);
    for (let i = 0; i < NOMINAL_ORDER.length - 2; i += 1) {
      const { state: next, effects } = ok(advanceOnce(state));
      expect(effects).toHaveLength(1);
      expect(effects[0]?.kind).toBe('advance');
      state = next;
    }

    // The last rung is onto `idle`, which is where a flight stops.
    const { state: idle, effects } = ok(advanceOnce(state));
    expect(idle.phase).toBe('idle');
    expect(effects).toEqual([]);
    expect(nextAdvance(idle)).toBeNull();
  });

  it('records off-blocks at pushback and on-blocks at the turnaround', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'turnaround');
    expect(state.actualDeparture?.toISOString()).toBe(OFF_BLOCKS.toISOString());
    expect(state.actualArrival?.toISOString()).toBe(estimatedArrivalOf(state)?.toISOString());
  });

  it('records the boundary instant, not the instant the event drained', () => {
    // A backlogged queue means the worker is behind, not that the aircraft
    // pushed back late. Recording `at` would turn queue lag into a punctuality
    // figure, and every downstream statistic would inherit it.
    const state = runTo(planFlight(longHaul(), PROFILE), 'boarding');

    const pushback = state.timeline[state.index + 1];
    expect(pushback?.phase).toBe('pushback');
    const late = addMinutes(pushback?.from ?? OFF_BLOCKS, 9);
    const { state: after } = ok(reduce(state, { type: 'ADVANCE', at: late }, PROFILE));
    expect(after.actualDeparture?.toISOString()).toBe(pushback?.from.toISOString());
  });

  it('refuses to advance before the next phase is due', () => {
    const state = planFlight(longHaul(), PROFILE);
    const next = state.timeline[1];
    const reason = refused(
      reduce(state, { type: 'ADVANCE', at: addMinutes(next?.from ?? CREATED, -1) }, PROFILE),
    );
    expect(reason).toMatch(/Not due to enter boarding/);
  });

  it('refuses to advance a flight that is already idle', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'idle');
    expect(refused(reduce(state, { type: 'ADVANCE', at: midway(state) }, PROFILE))).toMatch(
      /nothing left to do/,
    );
  });

  it('walks the same ladder on a sector too short to reach cruise', () => {
    let state = planFlight(longHaul({ distanceNm: 100, cruiseSpeedKt: 450 }), PROFILE);
    const seen: FlightPhase[] = [state.phase];
    while (!isTerminal(state)) {
      state = ok(advanceOnce(state)).state;
      seen.push(state.phase);
    }
    expect(seen).toEqual(NOMINAL_ORDER);
  });
});

describe('failure branch: delayed', () => {
  it('is allowed in every phase before the takeoff roll, and in the turnaround', () => {
    for (const phase of ['scheduled', 'boarding', 'pushback', 'taxi_out', 'turnaround'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      const { state: delayed } = ok(
        reduce(state, { type: 'DELAY', at: midway(state), minutes: 20 }, PROFILE),
      );
      expect(delayed.disruption).toBe('delayed');
      expect(delayed.delayMinutes).toBe(20);
    }
  });

  it('is refused once the aircraft is rolling', () => {
    for (const phase of ['departure', 'climb', 'cruise', 'descent', 'landing'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      expect(
        refused(reduce(state, { type: 'DELAY', at: midway(state), minutes: 20 }, PROFILE)),
      ).toMatch(/Use DIVERT or AIR_RETURN/);
    }
  });

  it('pushes off-blocks and arrival back by the delay', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'boarding');
    const arrivalBefore = estimatedArrivalOf(state);
    const { state: delayed } = ok(
      reduce(state, { type: 'DELAY', at: midway(state), minutes: 45 }, PROFILE),
    );

    const pushback = delayed.timeline.find((w) => w.phase === 'pushback');
    expect(pushback?.from.getTime()).toBe(OFF_BLOCKS.getTime() + 45 * 60_000);
    expect(estimatedArrivalOf(delayed)?.getTime()).toBe(
      (arrivalBefore?.getTime() ?? 0) + 45 * 60_000,
    );
  });

  it('moves the airborne leg with the flight when it has not taken off yet', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'boarding');
    const before = state.legs[0];
    const { state: delayed } = ok(
      reduce(state, { type: 'DELAY', at: midway(state), minutes: 45 }, PROFILE),
    );
    expect(delayed.legs[0]?.startedAt.getTime()).toBe(
      (before?.startedAt.getTime() ?? 0) + 45 * 60_000,
    );
  });

  it('leaves a leg already flown exactly where it happened', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'turnaround');
    const before = state.legs[0];
    const { state: delayed } = ok(
      reduce(state, { type: 'DELAY', at: midway(state), minutes: 30 }, PROFILE),
    );
    expect(delayed.legs[0]?.startedAt.getTime()).toBe(before?.startedAt.getTime());
    expect(delayed.legs[0]?.endsAt.getTime()).toBe(before?.endsAt.getTime());
  });

  it('accumulates repeated delays', () => {
    let state = runTo(planFlight(longHaul(), PROFILE), 'boarding');
    for (const minutes of [10, 15, 5]) {
      state = ok(reduce(state, { type: 'DELAY', at: midway(state), minutes }, PROFILE)).state;
    }
    expect(state.delayMinutes).toBe(30);
  });

  it('refuses a delay of zero or less', () => {
    const state = planFlight(longHaul(), PROFILE);
    expect(refused(reduce(state, { type: 'DELAY', at: CREATED, minutes: 0 }, PROFILE))).toMatch(
      /positive number of minutes/,
    );
    expect(refused(reduce(state, { type: 'DELAY', at: CREATED, minutes: -5 }, PROFILE))).toMatch(
      /positive number of minutes/,
    );
  });

  it('keeps the minutes on record when something worse happens afterwards', () => {
    // `disruption` holds one value, so a later diversion overwrites `delayed`.
    // The delay itself is a cost and a reputation hit (§8.4, §15) either way, so
    // it survives in its own field.
    let state = runTo(planFlight(longHaul(), PROFILE), 'boarding');
    state = ok(reduce(state, { type: 'DELAY', at: midway(state), minutes: 40 }, PROFILE)).state;
    state = runTo(state, 'cruise');
    state = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'CYYZ', distanceNm: 300 },
        PROFILE,
      ),
    ).state;

    expect(state.disruption).toBe('diverted');
    expect(state.delayMinutes).toBe(40);
  });
});

describe('failure branch: cancelled', () => {
  it('is allowed from every phase before the takeoff roll', () => {
    for (const phase of ['scheduled', 'boarding', 'pushback', 'taxi_out'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      const at = midway(state);
      const { state: cancelled } = ok(reduce(state, { type: 'CANCEL', at }, PROFILE));

      expect(cancelled.disruption).toBe('cancelled');
      expect(cancelled.phase).toBe('idle');
      expect(isTerminal(cancelled)).toBe(true);
      expect(phaseAt(cancelled.timeline, at)).toBe('idle');
    }
  });

  it('is refused from the takeoff roll onwards', () => {
    for (const phase of ['departure', 'climb', 'cruise', 'approach', 'taxi_in'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      expect(refused(reduce(state, { type: 'CANCEL', at: midway(state) }, PROFILE))).toMatch(
        /pre-departure only/,
      );
    }
  });

  it('leaves no airborne leg, because the aircraft never flew', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'boarding');
    const { state: cancelled } = ok(reduce(state, { type: 'CANCEL', at: midway(state) }, PROFILE));
    expect(cancelled.legs).toEqual([]);
    expect(estimatedArrivalOf(cancelled)).toBeNull();
  });

  it('keeps what already happened and cuts the rest at the moment it was cancelled', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'boarding');
    const at = midway(state);
    const { state: cancelled } = ok(reduce(state, { type: 'CANCEL', at }, PROFILE));

    expect(cancelled.timeline.map((w) => w.phase)).toEqual(['scheduled', 'boarding', 'idle']);
    expect(cancelled.timeline[1]?.to?.getTime()).toBe(at.getTime());
  });
});

describe('failure branch: returned to stand', () => {
  it('is allowed once the aircraft has left the stand and before it flies', () => {
    for (const phase of ['pushback', 'taxi_out'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      const { state: back } = ok(
        reduce(state, { type: 'RETURN_TO_STAND', at: midway(state) }, PROFILE),
      );
      expect(back.disruption).toBe('returned_to_stand');
      expect(back.phase).toBe(phase);
    }
  });

  it('is refused while still on the stand, and once airborne', () => {
    for (const phase of ['scheduled', 'boarding', 'climb', 'cruise', 'landing'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      expect(
        refused(reduce(state, { type: 'RETURN_TO_STAND', at: midway(state) }, PROFILE)),
      ).toMatch(/still on one or already flying/);
    }
  });

  it('taxis back in, is serviced, and goes idle', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'taxi_out');
    const at = midway(state);
    const { state: back } = ok(reduce(state, { type: 'RETURN_TO_STAND', at }, PROFILE));

    expect(back.timeline.map((w) => w.phase)).toEqual([
      'scheduled',
      'boarding',
      'pushback',
      'taxi_out',
      'taxi_in',
      'turnaround',
      'idle',
    ]);

    let finished = back;
    while (!isTerminal(finished)) finished = ok(advanceOnce(finished)).state;
    expect(finished.phase).toBe('idle');
    expect(finished.disruption).toBe('returned_to_stand');
    expect(finished.legs).toEqual([]);
  });
});

describe('failure branch: air return', () => {
  it('is allowed from the takeoff roll through cruise', () => {
    for (const phase of ['departure', 'climb', 'cruise'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      const { state: returned } = ok(
        reduce(state, { type: 'AIR_RETURN', at: midway(state) }, PROFILE),
      );
      expect(returned.disruption).toBe('air_return');
      expect(returned.arrivalIcao).toBe('EHAM');
    }
  });

  it('is refused after top of descent, where a turn back is a diversion', () => {
    for (const phase of ['descent', 'approach', 'landing'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      expect(refused(reduce(state, { type: 'AIR_RETURN', at: midway(state) }, PROFILE))).toMatch(
        /committed to the destination area/,
      );
    }
  });

  it('is refused on the ground', () => {
    for (const phase of ['scheduled', 'taxi_out', 'taxi_in'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      expect(refused(reduce(state, { type: 'AIR_RETURN', at: midway(state) }, PROFILE))).toMatch(
        /Cannot air-return/,
      );
    }
  });

  it('flies back exactly as far as it has come', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const at = midway(state);
    const leg = state.legs[0];
    const flown =
      (at.getTime() - (leg?.startedAt.getTime() ?? 0)) /
      ((leg?.endsAt.getTime() ?? 1) - (leg?.startedAt.getTime() ?? 0));

    const { state: returned } = ok(reduce(state, { type: 'AIR_RETURN', at }, PROFILE));
    expect(returned.legs).toHaveLength(2);
    expect(returned.legs[0]?.flownFraction).toBeCloseTo(flown, 10);
    expect(returned.legs[0]?.endsAt.getTime()).toBe(at.getTime());
    expect(returned.legs[1]?.fromIcao).toBeNull();
    expect(returned.legs[1]?.toIcao).toBe('EHAM');
    expect(returned.legs[1]?.distanceNm).toBeCloseTo(3157 * flown, 6);
  });

  it('lands back at the origin, having gone through descent and approach', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    let flight = ok(reduce(state, { type: 'AIR_RETURN', at: midway(state) }, PROFILE)).state;
    const seen: FlightPhase[] = [flight.phase];
    while (!isTerminal(flight)) {
      flight = ok(advanceOnce(flight)).state;
      seen.push(flight.phase);
    }
    expect(seen).toEqual([
      'cruise',
      'descent',
      'approach',
      'landing',
      'taxi_in',
      'turnaround',
      'idle',
    ]);
    expect(flight.arrivalIcao).toBe('EHAM');
  });

  it('is refused once the flight has already been replanned', () => {
    // The aircraft is no longer over the track it departed along, so "as far as
    // it has come" no longer has an answer this package can compute.
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const diverted = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
        PROFILE,
      ),
    ).state;
    expect(
      refused(reduce(diverted, { type: 'AIR_RETURN', at: midway(diverted) }, PROFILE)),
    ).toMatch(/already been replanned/);
  });
});

describe('failure branch: diverted', () => {
  it('is allowed from every airborne phase except the landing roll', () => {
    for (const phase of ['departure', 'climb', 'cruise', 'descent', 'approach'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      const { state: diverted } = ok(
        reduce(
          state,
          { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
          PROFILE,
        ),
      );
      expect(diverted.disruption).toBe('diverted');
      expect(diverted.arrivalIcao).toBe('BIKF');
    }
  });

  it('is refused on the runway and on the ground', () => {
    for (const phase of ['landing', 'taxi_in', 'boarding', 'turnaround'] as const) {
      const state = runTo(planFlight(longHaul(), PROFILE), phase);
      expect(
        refused(
          reduce(
            state,
            { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
            PROFILE,
          ),
        ),
      ).toMatch(/not airborne, or it is already on the runway/);
    }
  });

  it('is refused when it names the airport the flight is already going to', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    expect(
      refused(
        reduce(
          state,
          { type: 'DIVERT', at: midway(state), toIcao: 'KJFK', distanceNm: 100 },
          PROFILE,
        ),
      ),
    ).toMatch(/already going to KJFK/);
  });

  it('is refused with a nonsense distance', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    expect(
      refused(
        reduce(
          state,
          { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: -1 },
          PROFILE,
        ),
      ),
    ).toMatch(/zero or more/);
  });

  it('starts the new leg in open water, where the old one was cut', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const at = midway(state);
    const { state: diverted } = ok(
      reduce(state, { type: 'DIVERT', at, toIcao: 'BIKF', distanceNm: 400 }, PROFILE),
    );

    expect(diverted.legs).toHaveLength(2);
    expect(diverted.legs[0]?.toIcao).toBe('KJFK');
    expect(diverted.legs[0]?.flownFraction).toBeGreaterThan(0);
    expect(diverted.legs[0]?.flownFraction).toBeLessThan(1);
    expect(diverted.legs[1]?.fromIcao).toBeNull();
    expect(diverted.legs[1]?.distanceNm).toBe(400);
  });

  it('does not invent a phase change when it happens during cruise', () => {
    // Cutting cruise and starting a new cruise leg would otherwise produce two
    // consecutive cruise windows and an advance event that changes nothing.
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const { state: diverted } = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
        PROFILE,
      ),
    );
    const phases = diverted.timeline.map((w) => w.phase);
    expect(phases.filter((p) => p === 'cruise')).toHaveLength(1);
    expect(diverted.phase).toBe('cruise');
  });

  it('levels off again when it happens during descent', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'descent');
    const { state: diverted } = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
        PROFILE,
      ),
    );
    expect(diverted.timeline.map((w) => w.phase).slice(diverted.index)).toEqual([
      'descent',
      'cruise',
      'descent',
      'approach',
      'landing',
      'taxi_in',
      'turnaround',
      'idle',
    ]);
  });

  it('reaches the alternate and turns round there', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    let flight = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
        PROFILE,
      ),
    ).state;
    while (!isTerminal(flight)) flight = ok(advanceOnce(flight)).state;

    expect(flight.phase).toBe('idle');
    expect(flight.arrivalIcao).toBe('BIKF');
    expect(flight.actualArrival).not.toBeNull();
  });

  it('can be diverted again', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const once = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 600 },
        PROFILE,
      ),
    ).state;
    const twice = ok(
      reduce(once, { type: 'DIVERT', at: midway(once), toIcao: 'EINN', distanceNm: 300 }, PROFILE),
    ).state;

    expect(twice.legs).toHaveLength(3);
    expect(twice.arrivalIcao).toBe('EINN');
  });
});

describe('effects', () => {
  it('supersedes the old wakeup and issues a new one on every replan', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const { state: diverted, effects } = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
        PROFILE,
      ),
    );

    expect(effects[0]).toEqual({ kind: 'supersede', throughRevision: state.revision });
    expect(effects[1]?.kind).toBe('advance');
    expect(diverted.revision).toBe(state.revision + 1);
  });

  it('issues a key no earlier revision could have produced', () => {
    // The event queue is idempotent by key (M1-06). Reusing a key after a replan
    // would have the queue silently ignore the new wakeup, and the flight would
    // stop moving with nothing in the logs to say why.
    const keys: string[] = [];
    const collect = (effects: readonly FlightEffect[]) => {
      for (const effect of effects) {
        if (effect.kind === 'advance') keys.push(effect.key);
      }
    };

    let state = planFlight(longHaul(), PROFILE);
    const first = nextAdvance(state);
    if (first?.kind === 'advance') keys.push(first.key);

    // Fly it, divert it mid-cruise, fly the rest — the sequence that would
    // collide if the key were built from the phase or the window alone, since a
    // diversion revisits cruise, descent, approach and landing.
    while (state.phase !== 'cruise') {
      const result = ok(advanceOnce(state));
      collect(result.effects);
      state = result.state;
    }

    const diverted = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
        PROFILE,
      ),
    );
    collect(diverted.effects);
    state = diverted.state;

    while (!isTerminal(state)) {
      const result = ok(advanceOnce(state));
      collect(result.effects);
      state = result.state;
    }

    expect(keys.length).toBeGreaterThan(12);
    expect(new Set(keys).size).toBe(keys.length);
    // And the revision really is what separates them.
    expect(keys.some((key) => key.startsWith('advance:r1:'))).toBe(true);
  });

  it('supersedes only through the revision that was current before the change', () => {
    let state = runTo(planFlight(longHaul(), PROFILE), 'boarding');
    state = ok(reduce(state, { type: 'DELAY', at: midway(state), minutes: 10 }, PROFILE)).state;
    const { effects } = ok(
      reduce(state, { type: 'DELAY', at: midway(state), minutes: 10 }, PROFILE),
    );
    expect(effects[0]).toEqual({ kind: 'supersede', throughRevision: 1 });
  });
});

describe('purity and derivability', () => {
  it('never mutates the state it was given', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const snapshot = JSON.stringify(state);
    reduce(state, { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 }, PROFILE);
    reduce(state, { type: 'AIR_RETURN', at: midway(state) }, PROFILE);
    reduce(state, { type: 'ADVANCE', at: midway(state) }, PROFILE);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('gives the same result for the same commands, every time', () => {
    // CONTRIBUTING invariant 2. Nothing here reads a clock or a random source,
    // so a replay is bit-for-bit identical or the invariant is broken.
    const script: FlightCommand[] = [
      { type: 'DELAY', at: new Date('2024-10-20T07:40:00.000Z'), minutes: 25 },
    ];

    const run = () => {
      let state = runTo(planFlight(longHaul(), PROFILE), 'boarding');
      for (const command of script) state = ok(reduce(state, command, PROFILE)).state;
      state = runTo(state, 'cruise');
      state = ok(
        reduce(
          state,
          {
            type: 'DIVERT',
            at: new Date('2024-10-20T12:00:00.000Z'),
            toIcao: 'BIKF',
            distanceNm: 400,
          },
          PROFILE,
        ),
      ).state;
      return state;
    };

    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('answers where the aircraft is at any instant, from the state alone', () => {
    // The second M1-07 acceptance criterion. Nothing is stored per tick: the
    // whole flight is a set of boundaries, so an instant three hours ago and an
    // instant three hours ahead cost the same and agree with each other.
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const diverted = ok(
      reduce(
        state,
        { type: 'DIVERT', at: midway(state), toIcao: 'BIKF', distanceNm: 400 },
        PROFILE,
      ),
    ).state;

    const start = diverted.timeline[0]?.from.getTime() ?? 0;
    const instants = Array.from({ length: 500 }, (_, i) => new Date(start + i * 90_000));

    const forwards = instants.map((t) => phaseAt(diverted.timeline, t));
    const backwards = [...instants].reverse().map((t) => phaseAt(diverted.timeline, t));
    expect(backwards.reverse()).toEqual(forwards);

    // And it really does move: a flight that never leaves `scheduled` would pass
    // the equality above trivially.
    expect(new Set(forwards).size).toBeGreaterThan(5);
  });

  it('keeps the confirmed phase behind the timeline when the queue is late, never ahead', () => {
    // The map reads the timeline and never freezes; economics read `phase` and
    // are never resolved early. The gap between them is M1-06's queue depth.
    let state = planFlight(longHaul(), PROFILE);
    const airborne = state.timeline.find((w) => w.phase === 'cruise')?.from;
    expect(airborne).toBeDefined();
    if (!airborne) return;

    expect(phaseAt(state.timeline, airborne)).toBe('cruise');
    expect(state.phase).toBe('scheduled');

    state = runTo(state, 'cruise');
    expect(state.phase).toBe(phaseAt(state.timeline, airborne));
  });
});
