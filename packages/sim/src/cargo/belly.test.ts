import { describe, expect, it } from 'vitest';

import {
  BELLY_LIMITS,
  bellyCapacity,
  DEFAULT_BELLY_GEOMETRY,
  DEFAULT_CARGO,
  type BellyAirframe,
} from './index';

/**
 * §12.1's two claims, tested rather than asserted.
 *
 * *"A full cabin with full bags on a long sector leaves almost no belly capacity.
 * A widebody on a medium sector has tonnes spare."* Both halves are properties of
 * the model, so both are checked against real aircraft figures — and so is the
 * part that makes them a *decision*, which is that the two aeroplanes are stopped
 * by different limits.
 */

/** A320neo, App. C.2 figures: 79 t MTOW, 44.5 t OEW, 20 t structural payload. */
const NARROWBODY: BellyAirframe = {
  mtowTonnes: 79,
  oewTonnes: 44.5,
  maxPayloadTonnes: 20,
};

/** 777-300ER: 351.5 t MTOW, 167.8 t OEW, 68 t structural payload. */
const WIDEBODY: BellyAirframe = {
  mtowTonnes: 351.5,
  oewTonnes: 167.8,
  maxPayloadTonnes: 68,
};

const density = DEFAULT_CARGO.freightDensityKgPerM3;

describe('belly capacity', () => {
  it('leaves a full narrowbody cabin nothing on a long sector (§12.1)', () => {
    // 180 passengers and 18 t of fuel — about as far as an A320neo goes with a
    // full cabin. 44.5 + 18 (pax and bags) + 18 (fuel) = 80.5 t against a 79 t
    // MTOW: the aeroplane is over before a single box is loaded.
    const result = bellyCapacity({
      aircraft: NARROWBODY,
      passengers: 180,
      fuelTonnes: 18,
      freightDensityKgPerM3: density,
    });

    expect(result.availableTonnes).toBe(0);
    expect(result.limit).toBe('weight');
    expect(result.allowances.weight).toBeLessThan(0);
    expect(result.detail).toContain('no belly capacity');
    expect(result.detail).toContain('maximum takeoff weight');
  });

  it('leaves a widebody tonnes spare on a medium sector (§12.1)', () => {
    const result = bellyCapacity({
      aircraft: WIDEBODY,
      passengers: 350,
      fuelTonnes: 60,
      freightDensityKgPerM3: density,
    });

    // "Tonnes spare" is the claim, and it is a large number rather than a
    // rounding error: more than ten tonnes of saleable freight.
    expect(result.availableTonnes).toBeGreaterThan(10);
  });

  it('stops the two aeroplanes for different reasons, which is the decision', () => {
    // The whole point of reporting a limit. A widebody on a medium sector has
    // weight to spare and runs out of *room*; the narrowbody on the same trip
    // runs out of *structure*. A model that only did weight would call both of
    // these "fine" and neither would be actionable.
    const wide = bellyCapacity({
      aircraft: WIDEBODY,
      passengers: 350,
      fuelTonnes: 60,
      freightDensityKgPerM3: density,
    });
    const narrow = bellyCapacity({
      aircraft: NARROWBODY,
      passengers: 180,
      fuelTonnes: 5,
      freightDensityKgPerM3: density,
    });

    expect(wide.limit).toBe('volume');
    expect(wide.allowances.weight).toBeGreaterThan(wide.availableTonnes);
    expect(narrow.limit).toBe('structural');
    expect(narrow.allowances.weight).toBeGreaterThan(narrow.availableTonnes);
  });

  it('names the runner-up, so the readout says what would buy capacity', () => {
    const result = bellyCapacity({
      aircraft: WIDEBODY,
      passengers: 350,
      fuelTonnes: 60,
      freightDensityKgPerM3: density,
    });

    expect(result.detail).toContain('hold volume');
    // Volume-limited with structural weight to spare: a denser consignment is
    // worth having, and the sentence has to say so.
    expect(result.detail).toContain('would have taken another');
  });

  it('charges the belly tank its volume — `cargoVolumeFactor` finally bites', () => {
    // App. C.4's long-range A321neo build ends at 0.62 of standard belly volume.
    // Until M8-15 that number reached the fleet API and was consumed by nothing.
    const shelf = bellyCapacity({
      aircraft: NARROWBODY,
      passengers: 120,
      fuelTonnes: 6,
      freightDensityKgPerM3: density,
    });
    const longRange = bellyCapacity({
      aircraft: NARROWBODY,
      passengers: 120,
      fuelTonnes: 6,
      cargoVolumeFactor: 0.62,
      freightDensityKgPerM3: density,
    });

    expect(longRange.volume.usableM3).toBeCloseTo(shelf.volume.usableM3 * 0.62, 6);
    expect(longRange.allowances.volume).toBeLessThan(shelf.allowances.volume);
    expect(longRange.availableTonnes).toBeLessThan(shelf.availableTonnes);
    expect(longRange.limit).toBe('volume');
  });

  it('loads the passengers’ bags first, and charges the hold for them', () => {
    const empty = bellyCapacity({
      aircraft: WIDEBODY,
      passengers: 0,
      fuelTonnes: 60,
      freightDensityKgPerM3: density,
    });
    const full = bellyCapacity({
      aircraft: WIDEBODY,
      passengers: 350,
      fuelTonnes: 60,
      freightDensityKgPerM3: density,
    });

    expect(empty.volume.baggageM3).toBe(0);
    expect(full.volume.baggageM3).toBeGreaterThan(0);
    // §12.1's "direct competition with your own passengers", in cubic metres:
    // the freight loses exactly the room the bags take.
    expect(full.volume.freightM3).toBeCloseTo(empty.volume.freightM3 - full.volume.baggageM3, 6);
  });

  it('reads a freighter’s load with passengers and bags at zero', () => {
    // CARGO-05 flies the same function with an empty cabin. Nothing special-cases
    // it: the structural limit becomes the whole payload and the hold is all
    // freight, which is what a freighter is.
    const result = bellyCapacity({
      aircraft: WIDEBODY,
      passengers: 0,
      fuelTonnes: 60,
      freightDensityKgPerM3: density,
    });

    expect(result.passengerPayloadTonnes).toBe(0);
    expect(result.allowances.structural).toBe(WIDEBODY.maxPayloadTonnes);
    expect(result.volume.freightM3).toBe(result.volume.usableM3);
  });

  it('never reports a negative tonnage, whatever the limits say', () => {
    const result = bellyCapacity({
      aircraft: NARROWBODY,
      // Deliberately impossible: more passengers than the aeroplane can lift.
      passengers: 400,
      fuelTonnes: 10,
      freightDensityKgPerM3: density,
    });

    expect(result.availableTonnes).toBe(0);
    expect(BELLY_LIMITS).toContain(result.limit);
  });

  it('derives the hold from the structural limit, and says so in the numbers', () => {
    const result = bellyCapacity({
      aircraft: NARROWBODY,
      passengers: 0,
      fuelTonnes: 5,
      freightDensityKgPerM3: density,
    });

    expect(result.volume.holdM3).toBeCloseTo(
      NARROWBODY.maxPayloadTonnes * DEFAULT_BELLY_GEOMETRY.bellyVolumeM3PerPayloadTonne,
      6,
    );
  });

  it('refuses inputs that cannot describe an aeroplane', () => {
    expect(() =>
      bellyCapacity({
        aircraft: { ...NARROWBODY, mtowTonnes: 0 },
        passengers: 100,
        fuelTonnes: 5,
        freightDensityKgPerM3: density,
      }),
    ).toThrow(/Maximum takeoff weight/);

    expect(() =>
      bellyCapacity({
        aircraft: NARROWBODY,
        passengers: -1,
        fuelTonnes: 5,
        freightDensityKgPerM3: density,
      }),
    ).toThrow(/Passenger count/);

    expect(() =>
      bellyCapacity({
        aircraft: NARROWBODY,
        passengers: 100,
        fuelTonnes: 5,
        freightDensityKgPerM3: 0,
      }),
    ).toThrow(/Freight density/);
  });

  it('is deterministic: the same flight gives the same answer (invariant 2)', () => {
    const input = {
      aircraft: WIDEBODY,
      passengers: 287,
      fuelTonnes: 73.4,
      cargoVolumeFactor: 0.82,
      freightDensityKgPerM3: density,
    };
    expect(bellyCapacity(input)).toEqual(bellyCapacity(input));
  });
});
