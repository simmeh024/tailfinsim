import { describe, expect, it } from 'vitest';

import type { AirportFees } from '@tailfin/shared';

import { computeBlockTime } from '../flight/block';
import { computeFuelBurn } from '../flight/fuel';
import { DEFAULT_FLIGHT_PROFILE } from '../flight/profile';

import {
  checkFare,
  FARE_FLOOR_RATIO,
  fareFloor,
  type FareFloorInputs,
  routeVariableCostPerSeatMinor,
} from './fare-floor';
import { DEFAULT_FUEL_MARKET, computeFuelCost } from './fuel-price';
import { DEFAULT_SETTLEMENT, settleFlight } from './settlement';

/**
 * The price floor (M3-09, App. A.10).
 *
 * A.10's guard against *"price to zero and dominate"*. The tests that matter
 * are not the arithmetic — it is `settleFlight`'s arithmetic — but that the
 * floor is drawn against the **same** settlement a real flight gets, and that a
 * refusal says what the limit was.
 */

const FEES: AirportFees = {
  landingPerTonne: 900,
  paxFee: 1_200,
  parkingPerHour: 4_000,
  gateLeaseAnnual: 12_000_000,
};

/** An ATR 72 on a short European sector, matching §13.4's worked example. */
const AMS_LHR: FareFloorInputs = {
  distanceNm: 200,
  aircraft: {
    cruiseSpeedKt: 275,
    cruiseBurnTPerNm: 0.0037,
    maxTakeoffWeightT: 23,
    seatsByCabin: { economy: 70 },
  },
  market: DEFAULT_FUEL_MARKET,
  originStation: { icao: 'EHAM', regionFactor: 1, intoPlaneFeePerTonne: 4_000 },
  originFees: FEES,
  destinationFees: FEES,
};

describe('the floor is the settlement’s own cost, not a second model', () => {
  it('matches what settleFlight would charge the same sector', () => {
    // The property that stops the floor drifting from the bill. A second cost
    // formula would agree today and disagree the first time a rate is retuned,
    // and a floor that disagrees with settlement either blocks profitable fares
    // or permits unprofitable ones.
    const cost = routeVariableCostPerSeatMinor(AMS_LHR);

    const block = computeBlockTime(200, 275, DEFAULT_FLIGHT_PROFILE);
    const burn = computeFuelBurn(block, { cruiseBurnTPerNm: 0.0037 });
    const settled = settleFlight({
      kind: 'scheduled',
      load: { economy: { seats: 70, passengers: 70, revenue: 0 } },
      cargoKg: 0,
      block,
      fuelCost: computeFuelCost(burn.tonnes, DEFAULT_FUEL_MARKET, AMS_LHR.originStation),
      aircraft: { maxTakeoffWeightT: 23 },
      originFees: FEES,
      destinationFees: FEES,
    });

    expect(cost.sectorCostMinor).toBe(settled.costMinor);
    expect(cost.perSeatMinor).toBeCloseTo(settled.costMinor / 70, 9);
  });

  it('produces a plausible short-haul figure', () => {
    // A smell test rather than a calibration: §13.4's ATR sector runs to a few
    // thousand euro, so a per-seat cost should land in tens of euro.
    const cost = routeVariableCostPerSeatMinor(AMS_LHR);

    expect(cost.perSeatMinor).toBeGreaterThan(1_000);
    expect(cost.perSeatMinor).toBeLessThan(20_000);
  });

  it('costs more per seat on a longer sector', () => {
    const near = routeVariableCostPerSeatMinor(AMS_LHR);
    const far = routeVariableCostPerSeatMinor({ ...AMS_LHR, distanceNm: 900 });

    expect(far.perSeatMinor).toBeGreaterThan(near.perSeatMinor);
  });

  it('costs less per seat in a denser cabin', () => {
    // The mechanic behind gauge: the same sector spread over more seats.
    const dense = routeVariableCostPerSeatMinor({
      ...AMS_LHR,
      aircraft: { ...AMS_LHR.aircraft, seatsByCabin: { economy: 140 } },
    });
    const sparse = routeVariableCostPerSeatMinor(AMS_LHR);

    expect(dense.perSeatMinor).toBeLessThan(sparse.perSeatMinor);
  });

  it('counts every cabin’s seats', () => {
    const twoClass = routeVariableCostPerSeatMinor({
      ...AMS_LHR,
      aircraft: {
        ...AMS_LHR.aircraft,
        seatsByCabin: { business: 12, economy: 58 },
      },
    });

    expect(twoClass.seats).toBe(70);
  });

  it('refuses a route with no seats rather than dividing by zero', () => {
    expect(() =>
      routeVariableCostPerSeatMinor({
        ...AMS_LHR,
        aircraft: { ...AMS_LHR.aircraft, seatsByCabin: {} },
      }),
    ).toThrow(/no seats/);
  });

  it('reads the settlement config, so a retune moves the floor with the bill', () => {
    const expensive = routeVariableCostPerSeatMinor(AMS_LHR, {
      ...DEFAULT_SETTLEMENT,
      crewCostPerBlockHourMinor: DEFAULT_SETTLEMENT.crewCostPerBlockHourMinor * 4,
    });

    expect(expensive.perSeatMinor).toBeGreaterThan(
      routeVariableCostPerSeatMinor(AMS_LHR).perSeatMinor,
    );
  });
});

describe('A.10’s sixty per cent', () => {
  const cost = routeVariableCostPerSeatMinor(AMS_LHR);

  it('uses the published ratio', () => {
    expect(FARE_FLOOR_RATIO).toBe(0.6);
    expect(fareFloor(cost).floorMinor).toBe(Math.ceil(cost.perSeatMinor * 0.6));
  });

  it('rounds up, because a floor must never round down', () => {
    // Rounded down, a fare could sit fractionally beneath the limit and pass —
    // the one direction a limit must not go.
    const floor = fareFloor({ ...cost, perSeatMinor: 1_000.5 }, 0.6);
    expect(floor.floorMinor).toBe(601);
    expect(checkFare(600, floor).ok).toBe(false);
  });

  it('leaves room for §13.4’s own worked example', () => {
    // The calibration that matters: the design doc sells this sector at €75,
    // and a floor that blocked its own published example would be wrong about
    // the game rather than about the fare. Measured at €54.60 against €91.00
    // of variable cost per seat.
    const floor = fareFloor(cost);

    expect(floor.floorMinor).toBeLessThan(7_500);
    expect(floor.floorMinor).toBeGreaterThan(3_000);
    expect(checkFare(7_500, floor).ok).toBe(true);
  });

  it('is a config number, not a constant in the code', () => {
    expect(fareFloor(cost, 0.9).floorMinor).toBeGreaterThan(fareFloor(cost, 0.6).floorMinor);
  });

  it('refuses a ratio that is not one', () => {
    expect(() => fareFloor(cost, 0)).toThrow(/must be positive/);
    expect(() => fareFloor(cost, -1)).toThrow(/must be positive/);
  });
});

describe('a rejection explains the floor — the first acceptance criterion', () => {
  const floor = fareFloor(routeVariableCostPerSeatMinor(AMS_LHR));

  it('says what the limit was, and by how much the fare missed it', () => {
    // A refusal that does not say what the limit was leaves the player guessing
    // at a number the server already knows — §14.1's dead-end number wearing a
    // different hat.
    const result = checkFare(1, floor);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');

    expect(result.floorMinor).toBe(floor.floorMinor);
    expect(result.shortfallMinor).toBe(floor.floorMinor - 1);
    expect(result.variableCostPerSeatMinor).toBeCloseTo(floor.variableCostPerSeatMinor, 9);
    expect(result.ratio).toBe(0.6);
  });

  it('returns the floor on acceptance too, so the UI can show the headroom', () => {
    const result = checkFare(floor.floorMinor * 3, floor);

    expect(result.ok).toBe(true);
    expect(result.floorMinor).toBe(floor.floorMinor);
  });

  it('accepts a fare exactly at the floor', () => {
    // A.10 blocks fares *below* the floor. Exactly at it is permitted, and the
    // boundary is worth pinning rather than left to an inequality nobody reads.
    expect(checkFare(floor.floorMinor, floor).ok).toBe(true);
    expect(checkFare(floor.floorMinor - 1, floor).ok).toBe(false);
  });

  it('blocks pricing to zero, which is the exploit it exists for', () => {
    expect(checkFare(0, floor).ok).toBe(false);
  });

  it('refuses a fare that is not a number of minor units', () => {
    expect(() => checkFare(-1, floor)).toThrow(/zero or more/);
    expect(() => checkFare(Number.NaN, floor)).toThrow(/zero or more/);
  });
});

describe('the handling a floor is drawn against (BUG-01)', () => {
  /**
   * M5-06 gave a handler grade a price and this function kept passing none, so
   * for one release A.10's floor was computed against standard-grade handling
   * for an airline the settlement was billing at 1.35x for walk-up or 0.15x for
   * its own people. The floor's whole job is to refuse a fare below variable
   * cost; a floor drawn against a cost the flight will not be billed cannot.
   */
  it('reads as the standard grade when it is handed nothing', () => {
    expect(routeVariableCostPerSeatMinor({ ...AMS_LHR, handlingPriceFactor: 1 })).toEqual(
      routeVariableCostPerSeatMinor(AMS_LHR),
    );
  });

  it('rises with a dearer handler and falls with a cheaper one', () => {
    // The shipped spread, end to end: a self-handled turn against a premium one.
    const premium = routeVariableCostPerSeatMinor({ ...AMS_LHR, handlingPriceFactor: 1.5 });
    const walkUp = routeVariableCostPerSeatMinor({ ...AMS_LHR, handlingPriceFactor: 1.35 });
    const standard = routeVariableCostPerSeatMinor(AMS_LHR);
    const budget = routeVariableCostPerSeatMinor({ ...AMS_LHR, handlingPriceFactor: 0.7 });
    const mine = routeVariableCostPerSeatMinor({ ...AMS_LHR, handlingPriceFactor: 0.15 });

    expect(mine.perSeatMinor).toBeLessThan(budget.perSeatMinor);
    expect(budget.perSeatMinor).toBeLessThan(standard.perSeatMinor);
    expect(standard.perSeatMinor).toBeLessThan(walkUp.perSeatMinor);
    expect(walkUp.perSeatMinor).toBeLessThan(premium.perSeatMinor);
  });

  it('moves the floor itself, not merely the cost figure', () => {
    // The bug as a player meets it: on walk-up the floor must be higher than the
    // same route on a standard contract, or it permits fares below what the
    // flight will actually cost them.
    const onWalkUp = fareFloor(
      routeVariableCostPerSeatMinor({ ...AMS_LHR, handlingPriceFactor: 1.35 }),
    );
    const onStandard = fareFloor(routeVariableCostPerSeatMinor(AMS_LHR));
    expect(onWalkUp.floorMinor).toBeGreaterThan(onStandard.floorMinor);
  });

  it('moves by exactly the handling line settleFlight would bill', () => {
    // This module's header claims one cost model rather than two. Checked rather
    // than asserted: the gap between two floors must be exactly the gap between
    // the two handling lines, to the minor unit.
    const seats = 70;
    const base =
      DEFAULT_SETTLEMENT.groundHandlingPerTurnMinor +
      seats * DEFAULT_SETTLEMENT.groundHandlingPerSeatMinor;
    const expectedDelta = Math.round(base * 1.35) - Math.round(base * 1);

    const dearer = routeVariableCostPerSeatMinor({ ...AMS_LHR, handlingPriceFactor: 1.35 });
    const standard = routeVariableCostPerSeatMinor(AMS_LHR);
    expect(dearer.sectorCostMinor - standard.sectorCostMinor).toBe(expectedDelta);
  });
});
