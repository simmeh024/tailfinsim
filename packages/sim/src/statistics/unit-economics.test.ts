import { describe, expect, it } from 'vitest';

import {
  addFlight,
  breakevenLoadFactor,
  cask,
  emptyTraffic,
  loadFactor,
  onTimeRate,
  passengerYield,
  rask,
  rtkOf,
  spillRate,
  type TrafficTotals,
} from './unit-economics';

/**
 * §14.3's unit economics.
 *
 * The identity worth proving rather than asserting is `RASK = yield × LF`: the
 * two revenue measures differ by exactly the load factor, and an implementation
 * that conflated them would still look plausible on a single flight.
 */

/** One sector: 180 seats, 144 sold, 1,000 km. */
function sector(overrides: Partial<Parameters<typeof addFlight>[1]> = {}): TrafficTotals {
  return addFlight(emptyTraffic(), {
    seats: 180,
    passengers: 144,
    spilledPassengers: 0,
    cargoKg: 0,
    distanceKm: 1_000,
    revenueMinor: 1_800_000,
    costMinor: 1_500_000,
    blockSeconds: 7_200,
    onTime: true,
    ...overrides,
  });
}

describe('unit economics', () => {
  it('keeps RASK and yield apart, and they differ by exactly the load factor', () => {
    const totals = sector();
    const revenuePerAsk = rask(totals);
    const perRpk = passengerYield(totals);
    const lf = loadFactor(totals);

    expect(lf).toBeCloseTo(0.8, 10);
    // 1,800,000 minor over 180,000 ASK.
    expect(revenuePerAsk).toBeCloseTo(10, 10);
    // …and over 144,000 RPK, which is 25% more per unit.
    expect(perRpk).toBeCloseTo(12.5, 10);
    // The identity. An airline raising yield while RASK falls is pricing into a
    // market that is leaving, and conflating the two hides that entirely.
    expect(revenuePerAsk).toBeCloseTo((perRpk ?? 0) * (lf ?? 0), 10);
  });

  it('measures cost against seats offered, not seats sold', () => {
    // Flying the same sector emptier costs the same to offer.
    const full = sector({ passengers: 180 });
    const empty = sector({ passengers: 10 });
    expect(cask(full)).toBeCloseTo(cask(empty) ?? 0, 10);
    expect(passengerYield(full)).not.toBeCloseTo(passengerYield(empty) ?? 0, 5);
  });

  it('reports nothing flown as null rather than as zero', () => {
    const nothing = emptyTraffic();
    expect(rask(nothing)).toBeNull();
    expect(cask(nothing)).toBeNull();
    expect(passengerYield(nothing)).toBeNull();
    expect(loadFactor(nothing)).toBeNull();
    expect(breakevenLoadFactor(nothing)).toBeNull();
    expect(onTimeRate(nothing)).toBeNull();
    // Zero would read as "earned nothing per seat", which is a claim about a bad
    // month rather than about an absent one.
  });

  it('counts cargo in tonne-kilometres, not kilogram-kilometres', () => {
    expect(rtkOf(2_500, 1_000)).toBeCloseTo(2_500, 10);
    const withCargo = sector({ cargoKg: 2_500 });
    expect(withCargo.rtkKm).toBeCloseTo(2_500, 10);
  });

  it('measures spill against the demand that came, not the demand that flew', () => {
    const spilling = sector({ passengers: 180, spilledPassengers: 20 });
    // 20 of the 200 who wanted a seat went elsewhere — a tenth of the market.
    expect(spillRate(spilling)).toBeCloseTo(0.1, 10);
  });

  describe('breakeven load factor', () => {
    it('is the load at which revenue would cover cost', () => {
      const totals = sector();
      const belf = breakevenLoadFactor(totals);
      expect(belf).not.toBeNull();

      // Sanity: flying at exactly the breakeven load makes net zero.
      const atBreakeven = sector({
        passengers: Math.round(180 * (belf ?? 0)),
        revenueMinor: Math.round(12.5 * 180 * (belf ?? 0) * 1_000),
      });
      expect(atBreakeven.revenueMinor - atBreakeven.costMinor).toBeLessThan(2_000);
      expect(atBreakeven.revenueMinor - atBreakeven.costMinor).toBeGreaterThan(-2_000);
    });

    it('goes above 1 rather than clamping, because that is a different route', () => {
      // Costs more per seat offered than it earns per seat sold: no load factor
      // saves it. A clamped 1.00 would read as "nearly there"; §14.4's ranked
      // chart has to tell "reprice it" from "kill it".
      const hopeless = sector({ revenueMinor: 900_000, costMinor: 1_500_000 });
      expect(breakevenLoadFactor(hopeless) ?? 0).toBeGreaterThan(1);
    });

    it('is null when nothing was sold, because a yield of zero has no ratio', () => {
      const ferried = sector({ passengers: 0, revenueMinor: 0 });
      expect(breakevenLoadFactor(ferried)).toBeNull();
    });
  });

  it('folds many sectors into one window', () => {
    let totals = emptyTraffic();
    totals = addFlight(totals, {
      seats: 100,
      passengers: 80,
      spilledPassengers: 0,
      cargoKg: 0,
      distanceKm: 500,
      revenueMinor: 500_000,
      costMinor: 400_000,
      blockSeconds: 3_600,
      onTime: true,
    });
    totals = addFlight(totals, {
      seats: 200,
      passengers: 100,
      spilledPassengers: 5,
      cargoKg: 1_000,
      distanceKm: 2_000,
      revenueMinor: 2_000_000,
      costMinor: 1_800_000,
      blockSeconds: 10_800,
      onTime: false,
    });

    expect(totals.flights).toBe(2);
    expect(totals.askKm).toBe(100 * 500 + 200 * 2_000);
    expect(totals.rpkKm).toBe(80 * 500 + 100 * 2_000);
    expect(totals.rtkKm).toBeCloseTo(2_000, 10);
    expect(totals.blockHours).toBeCloseTo(4, 10);
    expect(onTimeRate(totals)).toBeCloseTo(0.5, 10);
    // Distance-weighted, so the long sector dominates — which is the whole
    // reason these are per-kilometre and not per-flight.
    expect(loadFactor(totals)).toBeCloseTo(180 / 300, 10);
  });
});
