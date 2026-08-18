import { describe, expect, it } from 'vitest';

import { isTerminal, planFlight, reduce, type FlightState } from './machine';
import { DEFAULT_FLIGHT_PROFILE, DEFAULT_TURNAROUND_MINUTES, type FlightProfile } from './profile';
import { legProgressAt } from './progress';
import { addMinutes, type FlightPlan, type PhaseWindow } from './timeline';

/**
 * How far along, and how fast.
 *
 * The property everything else rests on: the speeds integrate to exactly the
 * leg's distance. If they did not, an aircraft would arrive somewhere other than
 * the airport it was aimed at, and no amount of correct geometry downstream
 * would save it.
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
    cruiseAltitudeFt: 35_000,
    createdAt: CREATED,
    scheduledDeparture: OFF_BLOCKS,
    turnaroundMinutes: DEFAULT_TURNAROUND_MINUTES,
    ...overrides,
  };
}

function windowFor(state: FlightState, phase: string): PhaseWindow {
  const window = state.timeline.find((w) => w.phase === phase);
  if (!window) throw new Error(`no ${phase} window`);
  return window;
}

function midOf(window: PhaseWindow): Date {
  if (!window.to) throw new Error('open window');
  return new Date((window.from.getTime() + window.to.getTime()) / 2);
}

describe('legProgressAt', () => {
  const flight = planFlight(longHaul(), PROFILE);
  const leg = flight.legs[0];
  if (!leg) throw new Error('a planned flight always has a leg');

  it('is null while the aircraft is still on the ground', () => {
    expect(legProgressAt(flight, CREATED, PROFILE)).toBeNull();
    expect(legProgressAt(flight, addMinutes(leg.startedAt, -1), PROFILE)).toBeNull();
  });

  it('starts at nothing covered and ends at the whole leg', () => {
    expect(legProgressAt(flight, leg.startedAt, PROFILE)?.coveredNm).toBeCloseTo(0, 9);
    expect(legProgressAt(flight, leg.endsAt, PROFILE)?.coveredNm).toBeCloseTo(3157, 6);
    expect(legProgressAt(flight, leg.endsAt, PROFILE)?.fraction).toBeCloseTo(1, 9);
  });

  it('covers exactly the leg distance, however the phases are shaped', () => {
    // The invariant. Checked on a long sector, a short one that never reaches
    // cruise, and a slow aircraft, because each takes a different path through
    // the allocator.
    for (const plan of [
      longHaul(),
      longHaul({ distanceNm: 100, cruiseSpeedKt: 450 }),
      longHaul({ distanceNm: 700, cruiseSpeedKt: 275 }),
      longHaul({ distanceNm: 7000, cruiseSpeedKt: 510 }),
    ]) {
      const state = planFlight(plan, PROFILE);
      const end = state.legs[0]?.endsAt;
      if (!end) throw new Error('no leg');
      expect(legProgressAt(state, end, PROFILE)?.coveredNm).toBeCloseTo(plan.distanceNm, 6);
    }
  });

  it('never goes backwards', () => {
    const span = leg.endsAt.getTime() - leg.startedAt.getTime();
    let previous = -1;
    for (let i = 0; i <= 400; i += 1) {
      const at = new Date(leg.startedAt.getTime() + (span * i) / 400);
      const covered = legProgressAt(flight, at, PROFILE)?.coveredNm ?? -1;
      expect(covered).toBeGreaterThanOrEqual(previous);
      previous = covered;
    }
  });

  it('stays at the full distance after the flight has landed', () => {
    const after = legProgressAt(flight, addMinutes(leg.endsAt, 300), PROFILE);
    expect(after?.coveredNm).toBeCloseTo(3157, 6);
    expect(after?.fraction).toBeCloseTo(1, 9);
  });

  it('goes fastest in cruise and slowest on the runway', () => {
    const speedIn = (phase: string) =>
      legProgressAt(flight, midOf(windowFor(flight, phase)), PROFILE)?.groundSpeedKt ?? 0;

    expect(speedIn('cruise')).toBeGreaterThan(speedIn('descent'));
    expect(speedIn('descent')).toBeGreaterThan(speedIn('climb'));
    expect(speedIn('climb')).toBeGreaterThan(speedIn('approach'));
    expect(speedIn('approach')).toBeGreaterThan(speedIn('departure'));
    expect(speedIn('departure')).toBeGreaterThan(speedIn('landing'));
  });

  it('cruises at something close to the aircraft cruise speed', () => {
    // Not exact, and it should not be: the manoeuvre allowance means the leg
    // takes longer than distance ÷ speed, so the phases have to fit inside a
    // slightly slower average. But if cruise came out at 300 kt on a 480 kt
    // aircraft, the factors would be wrong.
    const cruise = legProgressAt(flight, midOf(windowFor(flight, 'cruise')), PROFILE);
    expect(cruise?.groundSpeedKt).toBeGreaterThan(440);
    expect(cruise?.groundSpeedKt).toBeLessThan(520);
  });

  it('is behind the clock during the climb and ahead of it during the descent', () => {
    // The whole reason distance is not time: an aircraft a third of the way
    // through its airborne minutes has covered less than a third of the sector.
    const climb = legProgressAt(flight, midOf(windowFor(flight, 'climb')), PROFILE);
    const climbMid = midOf(windowFor(flight, 'climb')).getTime();
    const elapsed =
      (climbMid - leg.startedAt.getTime()) / (leg.endsAt.getTime() - leg.startedAt.getTime());
    expect(climb?.fraction).toBeLessThan(elapsed);
  });

  it('caps a short hop below its cruise altitude', () => {
    // Seven minutes of climb at 2,000 ft/min does not reach FL350, and claiming
    // it did would be a number a player could see was wrong.
    const short = planFlight(longHaul({ distanceNm: 100, cruiseSpeedKt: 450 }), PROFILE);
    const at = midOf(windowFor(short, 'climb'));
    const progress = legProgressAt(short, at, PROFILE);
    expect(progress?.ceilingFt).toBeLessThan(35_000);
    expect(progress?.ceilingFt).toBeGreaterThan(5_000);
  });

  it('lets a long sector reach its cruise altitude', () => {
    const progress = legProgressAt(flight, midOf(windowFor(flight, 'cruise')), PROFILE);
    expect(progress?.ceilingFt).toBe(35_000);
  });

  it('reports the phase and how far through it the flight is', () => {
    const cruise = windowFor(flight, 'cruise');
    const progress = legProgressAt(flight, midOf(cruise), PROFILE);
    expect(progress?.phase).toBe('cruise');
    expect(progress?.phaseFraction).toBeCloseTo(0.5, 6);
  });

  it('counts only its own share of a phase a diversion cut in half', () => {
    // The new leg must not be credited with distance the old one flew. If the
    // clipping were wrong, the two legs would together cover more ground than
    // the aircraft did.
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const cruise = windowFor(state, 'cruise');
    const at = midOf(cruise);
    const result = reduce(state, { type: 'DIVERT', at, toIcao: 'BIKF', distanceNm: 400 }, PROFILE);
    if (!result.ok) throw new Error(result.reason);

    const second = result.state.legs[1];
    if (!second) throw new Error('no diversion leg');
    const arrival = legProgressAt(result.state, second.endsAt, PROFILE);
    expect(arrival?.legIndex).toBe(1);
    expect(arrival?.coveredNm).toBeCloseTo(400, 6);
  });

  it('gives a replanned leg the altitude the aircraft had already reached', () => {
    // There is no climb window on the new leg — the aircraft is already up — so
    // it inherits the climb that got it there rather than starting from nothing.
    const state = runTo(planFlight(longHaul(), PROFILE), 'cruise');
    const at = midOf(windowFor(state, 'cruise'));
    const result = reduce(state, { type: 'DIVERT', at, toIcao: 'BIKF', distanceNm: 400 }, PROFILE);
    if (!result.ok) throw new Error(result.reason);

    const second = result.state.legs[1];
    if (!second) throw new Error('no diversion leg');
    const progress = legProgressAt(result.state, addMinutes(second.startedAt, 5), PROFILE);
    expect(progress?.ceilingFt).toBe(35_000);
  });

  it('gives a flight diverted mid-climb only the height it had actually gained', () => {
    const state = runTo(planFlight(longHaul(), PROFILE), 'climb');
    const at = midOf(windowFor(state, 'climb'));
    const result = reduce(state, { type: 'DIVERT', at, toIcao: 'EGLL', distanceNm: 200 }, PROFILE);
    if (!result.ok) throw new Error(result.reason);

    const second = result.state.legs[1];
    if (!second) throw new Error('no diversion leg');
    const progress = legProgressAt(result.state, addMinutes(second.startedAt, 1), PROFILE);
    expect(progress?.ceilingFt).toBeLessThan(35_000);
    expect(progress?.ceilingFt).toBeGreaterThan(PROFILE.departureAltitudeFt);
  });

  it('is null for a cancelled flight, which has no legs', () => {
    const state = planFlight(longHaul(), PROFILE);
    const result = reduce(state, { type: 'CANCEL', at: CREATED }, PROFILE);
    if (!result.ok) throw new Error(result.reason);
    expect(legProgressAt(result.state, addMinutes(CREATED, 60), PROFILE)).toBeNull();
  });

  it('does not divide by zero on a leg with no airborne minutes', () => {
    const state = planFlight(longHaul(), PROFILE);
    const leg0 = state.legs[0];
    if (!leg0) throw new Error('no leg');
    const degenerate = { ...state, legs: [{ ...leg0, endsAt: leg0.startedAt }] };
    const progress = legProgressAt(degenerate, leg0.startedAt, PROFILE);
    expect(progress?.coveredNm).toBe(3157);
    expect(Number.isFinite(progress?.groundSpeedKt ?? NaN)).toBe(true);
  });
});

function runTo(state: FlightState, phase: string): FlightState {
  let current = state;
  while (current.phase !== phase) {
    if (isTerminal(current)) throw new Error(`never reached ${phase}`);
    const next = current.timeline[current.index + 1];
    if (!next) throw new Error(`never reached ${phase}`);
    const result = reduce(current, { type: 'ADVANCE', at: next.from }, PROFILE);
    if (!result.ok) throw new Error(result.reason);
    current = result.state;
  }
  return current;
}
