import { describe, expect, it } from 'vitest';

import {
  computeFuelCost,
  DEFAULT_FUEL_MARKET,
  type FuelMarket,
  type FuelStation,
  stationPricePerTonne,
} from './fuel-price';

/**
 * Fuel pricing (M2-05, §9.3, §11, §20).
 *
 * Two behaviours carry the whole design, and both are about what happens when the
 * world curve moves:
 *
 *   1. **A shock moves every station at once.** §20's oil shock is one number
 *      changing, and it has to reach the whole map, which is why stations scale a
 *      world price rather than holding their own.
 *   2. **The into-plane fee does not move with it.** It is a service charge — a
 *      bowser and a driver — so a shock changes the fuel and leaves the handling
 *      alone. That is what keeps the *relative* cost of stations shifting during a
 *      shock, which is what keeps tankering (§9.3) a live decision rather than a
 *      solved one.
 */

/** Schiphol: NW Europe, a little above the world reference. */
const AMS: FuelStation = { icao: 'EHAM', regionFactor: 1.03, intoPlaneFeePerTonne: 35 };

/** A Gulf station: cheap fuel, and cheap to put aboard. */
const DXB: FuelStation = { icao: 'OMDB', regionFactor: 0.78, intoPlaneFeePerTonne: 18 };

describe('stationPricePerTonne', () => {
  it('is the world price scaled by the region, plus the fee', () => {
    expect(stationPricePerTonne({ basePricePerTonne: 1_000 }, AMS)).toBeCloseTo(1_065, 10);
    expect(stationPricePerTonne({ basePricePerTonne: 1_000 }, DXB)).toBeCloseTo(798, 10);
  });

  it('leaves a station at the world reference paying the world price plus its fee', () => {
    const reference: FuelStation = { icao: 'ZZZZ', regionFactor: 1, intoPlaneFeePerTonne: 0 };

    expect(stationPricePerTonne({ basePricePerTonne: 900 }, reference)).toBe(900);
  });

  describe('rejects inputs that cannot mean anything', () => {
    it('refuses a non-positive world price', () => {
      expect(() => stationPricePerTonne({ basePricePerTonne: 0 }, AMS)).toThrow(/[Bb]ase fuel/);
    });

    it('refuses a non-positive region factor', () => {
      expect(() => stationPricePerTonne(DEFAULT_FUEL_MARKET, { ...AMS, regionFactor: -1 })).toThrow(
        /[Rr]egion/,
      );
    });

    it('refuses a negative into-plane fee', () => {
      expect(() =>
        stationPricePerTonne(DEFAULT_FUEL_MARKET, { ...AMS, intoPlaneFeePerTonne: -5 }),
      ).toThrow(/[Ii]nto-plane/);
    });
  });
});

describe('an oil shock (§20)', () => {
  const calm: FuelMarket = { basePricePerTonne: 1_000 };
  const shock: FuelMarket = { basePricePerTonne: 1_400 };

  it('reaches every station from one number', () => {
    expect(stationPricePerTonne(shock, AMS)).toBeGreaterThan(stationPricePerTonne(calm, AMS));
    expect(stationPricePerTonne(shock, DXB)).toBeGreaterThan(stationPricePerTonne(calm, DXB));
  });

  it('leaves the into-plane fee where it was — it is a service, not a commodity', () => {
    const before = computeFuelCost(10, calm, AMS);
    const after = computeFuelCost(10, shock, AMS);

    expect(after.intoPlaneCost).toBeCloseTo(before.intoPlaneCost, 10);
    expect(after.fuelCost).toBeGreaterThan(before.fuelCost);
  });

  it('widens the gap between a cheap station and a dear one, so tankering pays more', () => {
    const gapBefore = stationPricePerTonne(calm, AMS) - stationPricePerTonne(calm, DXB);
    const gapAfter = stationPricePerTonne(shock, AMS) - stationPricePerTonne(shock, DXB);

    expect(gapAfter).toBeGreaterThan(gapBefore);
  });
});

describe('computeFuelCost', () => {
  it('bills the commodity and the handling separately, and they add up', () => {
    const result = computeFuelCost(2.5, DEFAULT_FUEL_MARKET, AMS);

    expect(result.fuelCost + result.intoPlaneCost).toBeCloseTo(result.totalCost, 10);
    expect(result.totalCost).toBeCloseTo(2.5 * 1_065, 10);
  });

  it('states its own quantity, price and station, so no figure is a dead end', () => {
    const result = computeFuelCost(2.5, DEFAULT_FUEL_MARKET, AMS);

    expect(result.tonnes).toBe(2.5);
    expect(result.icao).toBe('EHAM');
    expect(result.pricePerTonne).toBeCloseTo(1_065, 10);
  });

  it('carries components that reconcile to the total', () => {
    const result = computeFuelCost(2.5, DEFAULT_FUEL_MARKET, AMS);
    const summed = result.components.reduce((total, c) => total + c.cost, 0);

    expect(summed).toBeCloseTo(result.totalCost, 10);
    expect(result.components.map((c) => c.source)).toEqual(['fuel', 'into-plane']);
  });

  it('says how far the station sits from the world price, in the direction it sits', () => {
    const dear = computeFuelCost(1, DEFAULT_FUEL_MARKET, AMS).components[0]?.detail ?? '';
    const cheap = computeFuelCost(1, DEFAULT_FUEL_MARKET, DXB).components[0]?.detail ?? '';

    expect(dear).toContain('EHAM');
    expect(dear).toMatch(/above/);
    expect(cheap).toMatch(/below/);
  });

  it('says so plainly when a station sits on the world reference', () => {
    const reference: FuelStation = { ...AMS, icao: 'ZZZZ', regionFactor: 1 };
    const detail = computeFuelCost(1, DEFAULT_FUEL_MARKET, reference).components[0]?.detail ?? '';

    // Neither "above" nor "below" — a 0% premium reads as noise, and the
    // reference station is the one a player compares the others against.
    expect(detail).toMatch(/world reference/);
    expect(detail).not.toMatch(/above|below/);
  });

  it('omits the into-plane line at a station that does not charge one', () => {
    // Self-handling at your own hub, or a station that folds it into the price.
    const free: FuelStation = { ...AMS, intoPlaneFeePerTonne: 0 };
    const result = computeFuelCost(2.5, DEFAULT_FUEL_MARKET, free);

    expect(result.components.map((c) => c.source)).toEqual(['fuel']);
    expect(result.intoPlaneCost).toBe(0);
  });

  it('prices nothing at nothing', () => {
    // An aircraft that arrives with enough fuel for the next sector buys none.
    expect(computeFuelCost(0, DEFAULT_FUEL_MARKET, AMS).totalCost).toBe(0);
  });

  it('refuses a negative quantity', () => {
    expect(() => computeFuelCost(-1, DEFAULT_FUEL_MARKET, AMS)).toThrow(/[Ff]uel quantity/);
  });

  it('is a pure function — the same uplift always costs the same', () => {
    expect(computeFuelCost(2.5, DEFAULT_FUEL_MARKET, AMS)).toEqual(
      computeFuelCost(2.5, DEFAULT_FUEL_MARKET, AMS),
    );
  });
});
