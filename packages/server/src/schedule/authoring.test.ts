import { describe, expect, it } from 'vitest';

import { computeBlockTime, DEFAULT_FLIGHT_PROFILE, DEFAULT_TURNAROUND_MINUTES } from '@tailfin/sim';

import { placeLegs } from './authoring';

/**
 * Placing authored legs into a rotation (M2-03, §8.2).
 *
 * The pure half of the schedule API: given routes and local departure times, work
 * out each leg's absolute minute from the cycle anchor and its computed block and
 * turnaround. `validateRotation` (proved in `sim`) has the final say on legality;
 * this only has to produce the monotonic, non-overlapping placement it judges.
 */
describe('placeLegs', () => {
  const shortHopNm = 220; // ~40 min block for the reference narrowbody.

  function resolved(routeId: string, o: string, d: string, nm: number, minuteLocal: number) {
    return {
      routeId,
      originIcao: o,
      destinationIcao: d,
      greatCircleNm: nm,
      departureMinuteLocal: minuteLocal,
    };
  }

  it('anchors the first leg at its own local departure minute', () => {
    const [leg] = placeLegs([resolved('r1', 'EGLL', 'LEBL', 620, 480)]);
    expect(leg?.departureMinute).toBe(480);
    expect(leg?.originIcao).toBe('EGLL');
    expect(leg?.destinationIcao).toBe('LEBL');
  });

  it('computes block from the distance and turnaround from the reference type', () => {
    const [leg] = placeLegs([resolved('r1', 'EGLL', 'LEBL', 620, 480)]);
    // Whole minutes — the leg's block is an integer column (see placeLegs).
    const expectedBlock = Math.round(
      computeBlockTime(620, 447, DEFAULT_FLIGHT_PROFILE).blockMinutes,
    );
    expect(leg?.blockMinutes).toBe(expectedBlock);
    expect(Number.isInteger(leg?.blockMinutes)).toBe(true);
    expect(leg?.turnaroundMinutes).toBe(DEFAULT_TURNAROUND_MINUTES);
  });

  it('places a later leg after the previous one lands and turns, same day', () => {
    const legs = placeLegs([
      resolved('r1', 'EGLL', 'LEBL', shortHopNm, 480), // 08:00 out
      resolved('r2', 'LEBL', 'EGLL', shortHopNm, 700), // 11:40 local — comfortably later
    ]);
    const first = legs[0];
    const second = legs[1];
    expect(second?.departureMinute).toBe(700);
    // It cannot depart before the aircraft is back on the ground and turned.
    expect(second?.departureMinute).toBeGreaterThanOrEqual(
      (first?.departureMinute ?? 0) + (first?.blockMinutes ?? 0) + (first?.turnaroundMinutes ?? 0),
    );
  });

  it('rolls a leg to the next day when its local time cannot follow the previous one', () => {
    // Leg 2's local minute (06:00) is earlier in the day than leg 1's departure
    // (23:00), so it must belong to the following cycle, not this one.
    const legs = placeLegs([
      resolved('r1', 'EGLL', 'LEBL', shortHopNm, 1380), // 23:00
      resolved('r2', 'LEBL', 'EGLL', shortHopNm, 360), // 06:00 next day
    ]);
    expect(legs[1]?.departureMinute).toBe(360 + 1440);
  });

  it('keeps departures strictly increasing across a three-leg rotation', () => {
    const legs = placeLegs([
      resolved('r1', 'EGLL', 'LEBL', shortHopNm, 360),
      resolved('r2', 'LEBL', 'LFPG', shortHopNm, 300),
      resolved('r3', 'LFPG', 'EGLL', shortHopNm, 300),
    ]);
    const minutes = legs.map((l) => l.departureMinute);
    for (let i = 1; i < minutes.length; i += 1) {
      expect(minutes[i]).toBeGreaterThan(minutes[i - 1]!);
    }
  });
});
