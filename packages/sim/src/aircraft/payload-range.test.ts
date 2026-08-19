import { describe, expect, it } from 'vitest';

import {
  type AirframeSpec,
  type CabinWeight,
  calibrateCruiseBurn,
  cabinWeightT,
  computePayloadRange,
  DEFAULT_PAYLOAD_RANGE,
  effectiveSpec,
  type OptionDelta,
  PAYLOAD_RANGE_LIMITS,
  type PayloadRangeLimit,
  payloadT,
  runwayLimitedTakeoffWeightT,
} from './payload-range';

/**
 * The payload/range trade (M2-02, App. C.3–C.4).
 *
 * Three things are worth protecting, and the third is the one that will rot:
 *
 *   1. The trade itself — a heavier cabin, or more passengers in it, costs range.
 *   2. **The binding limit is named.** A range with no reason attached tells a
 *      player nothing about what to buy, and every limit has to stay reachable.
 *   3. The calibration against App. C.4's A321neo, which is the only place the
 *      design doc puts real numbers on this. See the note above that block for
 *      why it is asserted with a tolerance rather than exactly.
 */

/**
 * A321neo, from the App. C.2 catalogue row: 200 seats one-class, 4,000 nm,
 * MTOW 97 t, 2,200 m of runway.
 *
 * Three numbers the catalogue does not carry had to be chosen, and they are
 * fixtures rather than facts: the **bare** empty weight, the fuel capacity and
 * the installed weight of a seat. They are set so that the published OEW of an
 * A321neo (~50.1 t) falls out of `46.0 t + a 200-seat cabin`, which is what ties
 * the fixture to reality. When M4 authors the real catalogue these move there.
 */
const BARE_EMPTY_T = 46.0;

const STANDARD_CABIN: CabinWeight = {
  seats: 200,
  // A standard economy seat, installed, with rails and its share of trim.
  seatWeightKg: 13,
  // Galleys, lavatories and IFE.
  fittingsWeightT: 1.5,
};

/** C.3's high-density exit configuration, taken at the top of its +12–22% band. */
const DENSE_CABIN: CabinWeight = { ...STANDARD_CABIN, seats: 244 };

/** The 200-seat load the catalogue's 4,000 nm is taken to be quoted at. */
const FULL_STANDARD = { passengers: 200, cargoT: 0 };

const A321NEO_BASE = {
  emptyWeightT: BARE_EMPTY_T,
  maxTakeoffWeightT: 97,
  fuelCapacityT: 26.4,
  takeoffRunAtMtowM: 2_200,
};

/**
 * Burn is solved for rather than typed, so the catalogue's 4,000 nm and the fuel
 * flow can never drift apart. It comes out at 6.6 kg/nm, which is the right
 * order for an A321neo at long-range cruise.
 */
const CRUISE_BURN = calibrateCruiseBurn(A321NEO_BASE, STANDARD_CABIN, [], FULL_STANDARD, 4_000);

const A321NEO: AirframeSpec = { ...A321NEO_BASE, cruiseBurnTPerNm: CRUISE_BURN };

/** C.3 options, with the deltas C.3 and C.4 state. */
const THREE_ACT: OptionDelta = {
  id: 'act-3',
  // "+1.5 to +2.5 t OEW" for one to three tanks; three tanks takes the top.
  oewDeltaT: 2.5,
  // Three A321 auxiliary centre tanks, ~2.4 t of fuel each.
  fuelCapacityDeltaT: 7.2,
};

/** The paper upgrade. C.4 puts the long-range build at 101 t. */
const MTOW_UPGRADE: OptionDelta = { id: 'mtow-101', mtowDeltaT: 4 };

/**
 * ETOPS 180 carries no weight or performance delta here on purpose. C.3 rule 1
 * says every option debits *at least one* axis, and this one debits money,
 * research and crew rating — none of which this module models.
 */
const ETOPS_180: OptionDelta = { id: 'etops-180' };

/** C.3's lightweight cabin package: −1.8 t OEW, comfort −0.10. */
const LIGHTWEIGHT_CABIN: OptionDelta = { id: 'lightweight-cabin', oewDeltaT: -1.8 };

describe('effective spec', () => {
  it('adds weights and multiplies factors', () => {
    const spec = effectiveSpec(A321NEO, STANDARD_CABIN, [
      { id: 'a', oewDeltaT: 2, mtowDeltaT: 4, fuelCapacityDeltaT: 7.2, burnFactor: 0.965 },
      { id: 'b', oewDeltaT: 2, burnFactor: 0.965 },
    ]);

    expect(spec.operatingEmptyWeightT).toBeCloseTo(50.1 + 4, 6);
    expect(spec.maxTakeoffWeightT).toBe(101);
    expect(spec.fuelCapacityT).toBeCloseTo(33.6, 6);
    // Compounding, not adding: 0.965² is 93.1% of the burn, not 93.0%.
    expect(spec.cruiseBurnTPerNm).toBeCloseTo(CRUISE_BURN * 0.965 * 0.965, 12);
  });

  it('reproduces the published OEW of an A321neo from bare weight plus a cabin', () => {
    expect(cabinWeightT(STANDARD_CABIN)).toBeCloseTo(4.1, 6);
    expect(effectiveSpec(A321NEO, STANDARD_CABIN, []).operatingEmptyWeightT).toBeCloseTo(50.1, 6);
  });

  it('refuses options that would leave nothing of the airframe', () => {
    expect(() =>
      effectiveSpec(A321NEO, STANDARD_CABIN, [{ id: 'silly', oewDeltaT: -100 }]),
    ).toThrow(/non-positive operating empty weight/);
  });

  it('refuses a spec with a zero or missing figure rather than dividing by it', () => {
    // A catalogue row with no fuel capacity or no burn would otherwise produce a
    // silent NaN or an infinite range, which is worse than a crash.
    expect(() => effectiveSpec({ ...A321NEO, fuelCapacityT: 0 }, STANDARD_CABIN, [])).toThrow(
      /Fuel capacity must be positive/,
    );
    expect(() => effectiveSpec({ ...A321NEO, cruiseBurnTPerNm: 0 }, STANDARD_CABIN, [])).toThrow(
      /Cruise burn must be positive/,
    );
    expect(() => effectiveSpec({ ...A321NEO, takeoffRunAtMtowM: 0 }, STANDARD_CABIN, [])).toThrow(
      /Takeoff run at MTOW must be positive/,
    );
    expect(() => effectiveSpec({ ...A321NEO, maxTakeoffWeightT: 0 }, STANDARD_CABIN, [])).toThrow(
      /Maximum takeoff weight must be positive/,
    );
  });
});

describe('payload', () => {
  it('is passengers, their bags, and freight', () => {
    // 100 kg a head under the default weights.
    expect(payloadT({ passengers: 200, cargoT: 0 })).toBeCloseTo(20, 6);
    expect(payloadT({ passengers: 200, cargoT: 3.5 })).toBeCloseTo(23.5, 6);
  });

  it('rejects impossible loads', () => {
    expect(() => payloadT({ passengers: -1, cargoT: 0 })).toThrow(/Passenger count/);
    expect(() => payloadT({ passengers: 100, cargoT: Number.NaN })).toThrow(/Cargo weight/);
  });
});

/**
 * ## Why App. C.4 is asserted with a tolerance
 *
 * C.4's range column does not reconcile under any single set of assumptions, and
 * that is worth stating rather than fitting around. Its three builds are quoted
 * at three different loads: the standard and long-range rows are brochure ranges
 * at a partial load — no 200-passenger A321 reaches 4,700 nm at 101 t MTOW, the
 * weights do not permit it — while the high-density row's 3,800 nm is only
 * meaningful as *its own* 244 passengers, since at any lighter load a dense cabin
 * is tank-limited and reaches exactly as far as a light one.
 *
 * So the table is read as what it is — an illustration of a trade, not a
 * worked calculation — and the model is checked against it two ways: the
 * **ordering and the binding limits exactly**, which is what C.4 actually
 * asserts, and the **magnitudes within 6%**. The residuals are 0 nm on the
 * standard build, +58 nm on long-range and −205 nm on high-density.
 */
describe('the App. C.4 A321neo, three ways', () => {
  /** C.4's own figures, for the tolerance check. */
  const PUBLISHED = { standard: 4_000, longRange: 4_700, highDensity: 3_800 };

  /**
   * The load each row is quoted at. The long-range build's thin-transatlantic
   * mission — C.4's "best for" is explicit that it gives up the belly freight —
   * is 170 passengers, and that is the load at which it reaches its 4,700 nm.
   */
  const standard = computePayloadRange(A321NEO, STANDARD_CABIN, [], FULL_STANDARD);
  const longRange = computePayloadRange(
    A321NEO,
    STANDARD_CABIN,
    [THREE_ACT, MTOW_UPGRADE, ETOPS_180],
    { passengers: 170, cargoT: 0 },
  );
  const highDensity = computePayloadRange(A321NEO, DENSE_CABIN, [LIGHTWEIGHT_CABIN], {
    passengers: 244,
    cargoT: 0,
  });

  it('orders the three builds the way C.4 does', () => {
    expect(longRange.rangeNm).toBeGreaterThan(standard.rangeNm);
    expect(standard.rangeNm).toBeGreaterThan(highDensity.rangeNm);
  });

  it('lands within 6% of C.4 on every build', () => {
    expect(standard.rangeNm).toBeCloseTo(PUBLISHED.standard, 6);
    expect(Math.abs(longRange.rangeNm - PUBLISHED.longRange) / PUBLISHED.longRange).toBeLessThan(
      0.06,
    );
    expect(
      Math.abs(highDensity.rangeNm - PUBLISHED.highDensity) / PUBLISHED.highDensity,
    ).toBeLessThan(0.06);
  });

  it('locks the arithmetic so a change to the model is visible', () => {
    expect(standard.rangeNm).toBeCloseTo(4_000, 3);
    expect(longRange.rangeNm).toBeCloseTo(4_757.58, 2);
    expect(highDensity.rangeNm).toBeCloseTo(3_595.15, 2);
  });

  it('names a different limit for each build, which is the point of the table', () => {
    // The standard build has 26.9 t of MTOW headroom and only 26.4 t of tank:
    // more MTOW would buy it nothing, which is why C.4's long-range build buys
    // tanks *and* MTOW rather than either alone.
    expect(standard.limit).toBe('fuel');
    expect(standard.allowances.fuel).toBeLessThan(standard.allowances.mtow);

    // With three auxiliary tanks aboard it is the paper limit that binds, and
    // 5.2 t of tank goes unused — C.4's "no belly freight" in another form.
    expect(longRange.limit).toBe('mtow');
    expect(longRange.fuelT).toBeCloseTo(31.4, 6);
    expect(longRange.allowances.fuel - longRange.fuelT).toBeCloseTo(2.2, 6);

    // 244 passengers weigh 4.4 t more than 200, and the lightweight cabin gives
    // only 1.2 t of that back, so the dense build runs into MTOW.
    expect(highDensity.limit).toBe('mtow');
  });

  it('gives the long-range build its C.4 MTOW of 101 t', () => {
    expect(longRange.maxTakeoffWeightT).toBe(101);
    expect(standard.maxTakeoffWeightT).toBe(97);
  });

  it('explains itself in a sentence naming the limit and the runner-up', () => {
    expect(standard.detail).toContain('limited by tank capacity');
    expect(longRange.detail).toContain('limited by maximum takeoff weight');
    expect(longRange.detail).toContain('tank capacity would have taken another 2.2 t');
  });
});

describe('the trade', () => {
  it('costs range to fill a denser cabin', () => {
    const light = computePayloadRange(A321NEO, STANDARD_CABIN, [], FULL_STANDARD);
    const dense = computePayloadRange(A321NEO, DENSE_CABIN, [], { passengers: 244, cargoT: 0 });

    expect(dense.rangeNm).toBeLessThan(light.rangeNm);
    // §6.4: seats ↑ → weight ↑ → range ↓. 44 more passengers cost ~680 nm.
    expect(light.rangeNm - dense.rangeNm).toBeGreaterThan(500);
  });

  it('costs range to fit a heavier cabin, holding the passengers fixed', () => {
    // The clean isolation: same airframe, same 244 passengers, and the only
    // difference is 1.8 t of cabin furnishing.
    const load = { passengers: 244, cargoT: 0 };
    const heavy = computePayloadRange(A321NEO, DENSE_CABIN, [], load);
    const light = computePayloadRange(A321NEO, DENSE_CABIN, [LIGHTWEIGHT_CABIN], load);

    expect(light.rangeNm - heavy.rangeNm).toBeCloseTo(1.8 / CRUISE_BURN, 6);
    expect(light.rangeNm - heavy.rangeNm).toBeGreaterThan(250);
  });

  it('costs range to carry freight, tonne for tonne with passengers', () => {
    const load = computePayloadRange(A321NEO, DENSE_CABIN, [], { passengers: 244, cargoT: 0 });
    const withCargo = computePayloadRange(A321NEO, DENSE_CABIN, [], {
      passengers: 244,
      cargoT: 2,
    });

    // §12.1's competition made arithmetic: belly freight and range come out of
    // the same MTOW.
    expect(load.rangeNm - withCargo.rangeNm).toBeCloseTo(2 / CRUISE_BURN, 6);
  });

  it('leaves range alone while the tanks are the limit', () => {
    // Below the MTOW crossover, taking weight out buys nothing — the aircraft
    // already carries all the fuel it can hold. A model that reported a gain
    // here would be selling the lightweight cabin on a false promise.
    const load = { passengers: 150, cargoT: 0 };
    const heavy = computePayloadRange(A321NEO, DENSE_CABIN, [], load);
    const light = computePayloadRange(A321NEO, DENSE_CABIN, [LIGHTWEIGHT_CABIN], load);

    expect(heavy.limit).toBe('fuel');
    expect(light.limit).toBe('fuel');
    expect(light.rangeNm).toBeCloseTo(heavy.rangeNm, 9);
  });
});

describe('the runway limit', () => {
  it('binds off a short field, and the takeoff run comes back equal to it', () => {
    const result = computePayloadRange(A321NEO, STANDARD_CABIN, [], FULL_STANDARD, 1_800);

    expect(result.limit).toBe('runway');
    // The inverse has to round-trip: if the runway is what stopped the fuel
    // load, the run required at the resulting weight is that runway exactly.
    expect(result.takeoffRunM).toBeCloseTo(1_800, 6);
    expect(result.rangeNm).toBeLessThan(3_000);
  });

  it('does not bind off a long one', () => {
    const result = computePayloadRange(A321NEO, STANDARD_CABIN, [], FULL_STANDARD, 4_000);

    expect(result.limit).toBe('fuel');
    expect(result.rangeNm).toBeCloseTo(4_000, 3);
  });

  it('cannot bind at all when no runway is given', () => {
    const result = computePayloadRange(A321NEO, STANDARD_CABIN, [], FULL_STANDARD, null);
    expect(result.allowances.runway).toBeNull();
    expect(result.limit).not.toBe('runway');
  });

  it('reports the weight a runway allows without clamping it to MTOW', () => {
    // Deliberate: a runway that would take 120 t under a 97 t aircraft should
    // say so, so the readout can show that the runway was not the problem.
    const spec = { maxTakeoffWeightT: 97, takeoffRunAtMtowM: 2_200 };
    expect(runwayLimitedTakeoffWeightT(spec, 2_200)).toBeCloseTo(97, 6);
    expect(runwayLimitedTakeoffWeightT(spec, 4_400)).toBeGreaterThan(97);
    expect(runwayLimitedTakeoffWeightT(spec, 1_100)).toBeCloseTo(97 / Math.SQRT2, 6);
  });

  it('feeds checkReachability a takeoff run at the planned weight, not at MTOW', () => {
    const result = computePayloadRange(A321NEO, STANDARD_CABIN, [], { passengers: 100, cargoT: 0 });
    expect(result.takeoffWeightT).toBeLessThan(97);
    expect(result.takeoffRunM).toBeLessThan(2_200);
  });
});

describe('the limit that bound it', () => {
  it('keeps every limit reachable', () => {
    const reached = new Set<PayloadRangeLimit>();
    reached.add(computePayloadRange(A321NEO, STANDARD_CABIN, [], FULL_STANDARD).limit);
    reached.add(
      computePayloadRange(A321NEO, DENSE_CABIN, [], { passengers: 244, cargoT: 0 }).limit,
    );
    reached.add(computePayloadRange(A321NEO, STANDARD_CABIN, [], FULL_STANDARD, 1_800).limit);

    expect([...reached].sort()).toEqual([...PAYLOAD_RANGE_LIMITS].sort());
  });

  it('stays quiet about a runner-up that is a rounding error away', () => {
    // 205 passengers put the zero-fuel weight at 70.6 t, which leaves exactly
    // the 26.4 t the tanks hold — the two limits tie, give or take a float. The
    // sentence must not offer "another 0.0 t" as though there were headroom.
    const tied = computePayloadRange(A321NEO, STANDARD_CABIN, [], {
      passengers: 205,
      cargoT: 0,
    });

    expect(tied.allowances.mtow).toBeCloseTo(tied.allowances.fuel, 6);
    expect(tied.detail).not.toContain('would have taken another');
    expect(tied.detail).toMatch(/limited by (tank capacity|maximum takeoff weight)\.$/);
  });

  it('says so plainly when the load alone is over the limit', () => {
    const result = computePayloadRange(A321NEO, STANDARD_CABIN, [], {
      passengers: 200,
      cargoT: 40,
    });

    expect(result.fuelT).toBe(0);
    expect(result.rangeNm).toBe(0);
    expect(result.limit).toBe('mtow');
    expect(result.allowances.mtow).toBeLessThan(0);
    expect(result.detail).toContain(
      'already over maximum takeoff weight before any fuel is loaded',
    );
  });

  it('reports the weights that produced the answer', () => {
    const result = computePayloadRange(A321NEO, STANDARD_CABIN, [], FULL_STANDARD);

    expect(result.operatingEmptyWeightT).toBeCloseTo(50.1, 6);
    expect(result.payloadT).toBeCloseTo(20, 6);
    expect(result.zeroFuelWeightT).toBeCloseTo(70.1, 6);
    expect(result.takeoffWeightT).toBeCloseTo(result.zeroFuelWeightT + result.fuelT, 9);
    expect(result.takeoffWeightT).toBeLessThanOrEqual(result.maxTakeoffWeightT);
  });
});

describe('calibration', () => {
  it('round-trips a published range', () => {
    const burn = calibrateCruiseBurn(A321NEO_BASE, STANDARD_CABIN, [], FULL_STANDARD, 4_000);
    const result = computePayloadRange(
      { ...A321NEO_BASE, cruiseBurnTPerNm: burn },
      STANDARD_CABIN,
      [],
      FULL_STANDARD,
    );
    expect(result.rangeNm).toBeCloseTo(4_000, 9);
  });

  it('gives a burn in the right order for a narrowbody', () => {
    // 6.6 kg per nautical mile. A number two orders out would mean the fixture
    // weights are wrong, not just the arithmetic.
    expect(CRUISE_BURN * 1000).toBeCloseTo(6.6, 3);
  });

  it('refuses to calibrate a build that cannot carry fuel at that payload', () => {
    expect(() =>
      calibrateCruiseBurn(A321NEO_BASE, STANDARD_CABIN, [], { passengers: 200, cargoT: 40 }, 4_000),
    ).toThrow(/carries no fuel/);
  });
});

describe('purity', () => {
  it('gives the same answer every time and mutates nothing', () => {
    const cabin: CabinWeight = { ...DENSE_CABIN };
    const options: OptionDelta[] = [{ ...LIGHTWEIGHT_CABIN }];
    const load = { passengers: 244, cargoT: 1.5 };

    const first = computePayloadRange(A321NEO, cabin, options, load, 2_400);
    const second = computePayloadRange(A321NEO, cabin, options, load, 2_400);

    expect(second).toEqual(first);
    expect(cabin).toEqual(DENSE_CABIN);
    expect(options).toEqual([LIGHTWEIGHT_CABIN]);
    expect(DEFAULT_PAYLOAD_RANGE.passengerWeightKg).toBe(84);
  });
});
