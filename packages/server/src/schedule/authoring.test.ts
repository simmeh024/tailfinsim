import { describe, expect, it } from 'vitest';

import type { AircraftSpec } from '@tailfin/shared';
import {
  computeBlockTime,
  DEFAULT_FLIGHT_PROFILE,
  DEFAULT_SETTLEMENT,
  DEFAULT_TURNAROUND_MINUTES,
  DEFAULT_FUEL_MARKET,
} from '@tailfin/sim';

import {
  REFERENCE_AIRFRAME,
  REFERENCE_FEES,
  REFERENCE_HANDLING_PRICE_FACTOR,
  REFERENCE_STATION,
} from '../network/economics';

import { airframeCapability, estimateCost, placeLegs } from './authoring';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { RouteEconomics } from '../network/fares';

/**
 * Placing resolved legs into a rotation (M2-03, §8.2).
 *
 * The pure half of the schedule API: given routes and local departure times, work
 * out each leg's absolute minute from the cycle anchor and its computed block and
 * turnaround. `validateRotation` (proved in `sim`) has the final say on legality;
 * this only has to produce the monotonic, non-overlapping placement it judges.
 */
describe('placeLegs', () => {
  const CRUISE_KT = 447;
  const shortHopNm = 220; // ~40 min block for the reference narrowbody.

  function resolved(o: string, d: string, nm: number, minuteLocal: number | null) {
    return {
      routeId: `${o}-${d}`,
      originIcao: o,
      destinationIcao: d,
      greatCircleNm: nm,
      departureMinuteLocal: minuteLocal,
      opened: false,
    };
  }

  it('anchors the first leg at its own local departure minute', () => {
    const [leg] = placeLegs([resolved('EGLL', 'LEBL', 620, 480)], CRUISE_KT);
    expect(leg?.departureMinute).toBe(480);
    expect(leg?.originIcao).toBe('EGLL');
    expect(leg?.destinationIcao).toBe('LEBL');
  });

  it('computes block from the distance and turnaround from the reference type', () => {
    const [leg] = placeLegs([resolved('EGLL', 'LEBL', 620, 480)], CRUISE_KT);
    // Whole minutes — the leg's block is an integer column (see placeLegs).
    const expectedBlock = Math.round(
      computeBlockTime(620, CRUISE_KT, DEFAULT_FLIGHT_PROFILE).blockMinutes,
    );
    expect(leg?.blockMinutes).toBe(expectedBlock);
    expect(Number.isInteger(leg?.blockMinutes)).toBe(true);
    expect(leg?.turnaroundMinutes).toBe(DEFAULT_TURNAROUND_MINUTES);
  });

  it('places a later leg after the previous one lands and turns, same day', () => {
    const legs = placeLegs(
      [
        resolved('EGLL', 'LEBL', shortHopNm, 480), // 08:00 out
        resolved('LEBL', 'EGLL', shortHopNm, 700), // 11:40 local — comfortably later
      ],
      CRUISE_KT,
    );
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
    const legs = placeLegs(
      [
        resolved('EGLL', 'LEBL', shortHopNm, 1380), // 23:00
        resolved('LEBL', 'EGLL', shortHopNm, 360), // 06:00 next day
      ],
      CRUISE_KT,
    );
    expect(legs[1]?.departureMinute).toBe(360 + 1440);
  });

  it('places an auto-return leg (no chosen time) as soon as the aircraft has turned', () => {
    const legs = placeLegs(
      [
        resolved('EGLL', 'LEBL', shortHopNm, 480),
        resolved('LEBL', 'EGLL', shortHopNm, null), // auto-return — ASAP
      ],
      CRUISE_KT,
    );
    const first = legs[0]!;
    const ret = legs[1]!;
    expect(ret.departureMinute).toBe(
      first.departureMinute + first.blockMinutes + first.turnaroundMinutes,
    );
  });

  it('keeps departures strictly increasing across a three-leg rotation', () => {
    const legs = placeLegs(
      [
        resolved('EGLL', 'LEBL', shortHopNm, 360),
        resolved('LEBL', 'LFPG', shortHopNm, 300),
        resolved('LFPG', 'EGLL', shortHopNm, 300),
      ],
      CRUISE_KT,
    );
    const minutes = legs.map((l) => l.departureMinute);
    for (let i = 1; i < minutes.length; i += 1) {
      expect(minutes[i]).toBeGreaterThan(minutes[i - 1]!);
    }
  });

  // Local departure times (M3-04a): the chosen minute is local to the origin, so
  // it is converted to the absolute (UTC-anchor) minute the pipeline stores.
  it('converts a chosen local departure to absolute by the origin offset', () => {
    // 08:00 at UTC−5 is 13:00 UTC → absolute minute 780.
    const west = placeLegs(
      [resolved('KJFK', 'KBOS', shortHopNm, 480)],
      CRUISE_KT,
      new Map([['KJFK', -300]]),
    );
    expect(west[0]?.departureMinute).toBe(780);

    // 06:00 at UTC+9 is 21:00 UTC the day before → minute-of-day 1,260.
    const east = placeLegs(
      [resolved('RJTT', 'ROAH', shortHopNm, 360)],
      CRUISE_KT,
      new Map([['RJTT', 540]]),
    );
    expect(east[0]?.departureMinute).toBe(1_260);

    // No offset supplied → treated as UTC, unchanged (the default behaviour).
    const utc = placeLegs([resolved('EGLL', 'LEBL', shortHopNm, 480)], CRUISE_KT);
    expect(utc[0]?.departureMinute).toBe(480);
  });

  it('still chains a later leg after the previous one, in absolute minutes', () => {
    const legs = placeLegs(
      [
        resolved('KJFK', 'KBOS', shortHopNm, 480), // 08:00 local → 13:00 UTC (780)
        resolved('KBOS', 'KJFK', shortHopNm, null), // auto-return, ASAP
      ],
      CRUISE_KT,
      new Map([['KJFK', -300]]),
    );
    const first = legs[0]!;
    const ret = legs[1]!;
    expect(first.departureMinute).toBe(780);
    expect(ret.departureMinute).toBe(
      first.departureMinute + first.blockMinutes + first.turnaroundMinutes,
    );
  });
});

describe('airframeCapability', () => {
  it('maps a spec to the reachability capability', () => {
    const spec = {
      rangeNm: 3_350,
      runwayRequirementM: 1_890,
      wingspanCode: 'C',
      cruiseSpeedKt: 447,
    } as unknown as AircraftSpec;
    expect(airframeCapability(spec)).toEqual({
      rangeNm: 3_350,
      takeoffRunM: 1_890,
      wingspanCode: 'C',
      etopsMinutes: null,
    });
  });
});

describe('estimateCost', () => {
  const own: ResolvedPlayerAirline = {
    id: '00000000-0000-4000-8000-000000000001',
    worldId: '00000000-0000-4000-8000-0000000000aa',
    status: 'active',
  };

  const economics: RouteEconomics = {
    aircraft: REFERENCE_AIRFRAME,
    market: DEFAULT_FUEL_MARKET,
    originStation: REFERENCE_STATION,
    handlingPriceFactor: REFERENCE_HANDLING_PRICE_FACTOR,
    originFees: REFERENCE_FEES,
    destinationFees: REFERENCE_FEES,
    segmentPools: { business: 0, leisure: 0, vfr: 0 },
    competitors: [],
    self: { reputation: 0.35, productScore: 0.6, frequency: 2 },
    settlement: DEFAULT_SETTLEMENT,
    fareFloorRatio: 0.6,
  };

  const leg = (o: string, d: string, nm: number, opened: boolean) => ({
    routeId: `${o}-${d}`,
    originIcao: o,
    destinationIcao: d,
    greatCircleNm: nm,
    departureMinuteLocal: 480,
    opened,
  });

  it('sums per-leg cost and distance and counts the routes it opened', async () => {
    const cost = await estimateCost(
      own,
      [leg('AMS', 'KEF', 800, false), leg('KEF', 'JFK', 2_000, true)],
      () => Promise.resolve(economics),
    );
    expect(cost.legs).toHaveLength(2);
    expect(cost.totalDistanceNm).toBe(2_800);
    expect(cost.routesOpened).toBe(1);
    // Each leg has a real, positive operating cost, and the total is their sum.
    expect(cost.legs.every((l) => l.variableCostMinor > 0)).toBe(true);
    expect(cost.totalVariableCostMinor).toBe(
      cost.legs.reduce((sum, l) => sum + l.variableCostMinor, 0),
    );
    // The longer leg costs more.
    expect(cost.legs[1]!.variableCostMinor).toBeGreaterThan(cost.legs[0]!.variableCostMinor);
  });
});
