import { describe, expect, it } from 'vitest';

import { AIRCRAFT_CATALOGUE_V1, type AircraftSpec } from '@tailfin/shared';
import { computeEffectiveSpec, DEFAULT_FUEL_BURN } from '@tailfin/sim';

import { settlementAirframeOf } from './performance';

/**
 * Turning a catalogue spec into the three numbers a flight is billed on
 * (IMPROVE-02).
 *
 * A unit test, so it runs on every pull request rather than only where
 * `DATABASE_URL` is set. `flight/settle-aircraft.test.ts` proves the database
 * half — that the flight's own airframe is the one resolved — and this proves
 * the arithmetic, which is the part with a unit conversion in it and therefore
 * the part that would be quietly wrong.
 */

function specOf(designation: string): AircraftSpec {
  const type = AIRCRAFT_CATALOGUE_V1.types.find((t) => t.designation === designation);
  if (!type) throw new Error(`no ${designation} in the shipped catalogue`);
  // A standard build: App. C.6's rule is that everything reads `effective_spec`,
  // and a catalogue listing is the effective spec of an empty option list.
  return computeEffectiveSpec({ baseSpec: type.baseSpec });
}

describe('settlementAirframeOf', () => {
  it('carries weight and speed across unchanged', () => {
    // Neither needs converting, and a helper that quietly scaled them would be
    // a landing fee and a block time that are wrong in a way nothing else
    // checks.
    const atr = settlementAirframeOf(specOf('ATR 72-600'));
    expect(atr.maxTakeoffWeightT).toBe(23);
    expect(atr.cruiseSpeedKt).toBe(275);
  });

  it('undoes the trip-fuel haircut, so the published flow is what burns', () => {
    /*
     * The conversion worth testing.
     *
     * The catalogue publishes a cruise fuel flow in kg/h. `computeFuelBurn`
     * wants `cruiseBurnTPerNm`, which it documents as *fuel loaded ÷ published
     * range* and then multiplies by `tripFuelFraction` to take back the reserves
     * a published range already respects. So converting a flow into that figure
     * means dividing by the fraction — and feeding the raw per-mile flow in
     * would under-burn every sector by roughly the reserve fraction, which is a
     * fuel bill wrong in the cheap direction. Nobody reports those.
     */
    const spec = specOf('A320neo');
    const perNm = spec.fuelBurnKgPerHour / 1000 / spec.cruiseSpeedKt;

    const derived = settlementAirframeOf(spec).cruiseBurnTPerNm;

    expect(derived).toBeCloseTo(perNm / DEFAULT_FUEL_BURN.tripFuelFraction, 12);
    // Above the raw figure, not below it. The sign of the correction is the
    // thing an inverted division would get wrong while still looking plausible.
    expect(derived).toBeGreaterThan(perNm);
  });

  it('lands close to the two hand-authored figures it replaces', () => {
    /*
     * Not a tolerance anybody has to hit — it is the sanity check that the units
     * are right.
     *
     * Two numbers were hand-written before this existed: the placeholder ATR at
     * 2.5/825 t/nm, and the "representative narrowbody" fare-floor aircraft at
     * 0.0062. Both derive about 10% lower from the catalogue, and it is the
     * *consistency* that matters — a unit error or an inverted division would
     * not be a uniform 10% across a turboprop and a jet.
     */
    const atr = settlementAirframeOf(specOf('ATR 72-600')).cruiseBurnTPerNm;
    const neo = settlementAirframeOf(specOf('A320neo')).cruiseBurnTPerNm;

    expect(atr / (2.5 / 825)).toBeGreaterThan(0.85);
    expect(atr / (2.5 / 825)).toBeLessThan(0.95);
    expect(neo / 0.0062).toBeGreaterThan(0.85);
    expect(neo / 0.0062).toBeLessThan(0.95);
  });

  it('is linear in the burn an option folded into the spec', () => {
    // Sharklets are `fuelBurnFactor: 0.965`, applied to `fuelBurnKgPerHour`
    // inside `computeEffectiveSpec`. Nothing in this module knows options
    // exist — App. C.6's rule — so this is what makes that true rather than
    // merely intended.
    const type = AIRCRAFT_CATALOGUE_V1.types.find((t) => t.designation === 'A320neo');
    if (!type) throw new Error('no A320neo');

    const plain = computeEffectiveSpec({ baseSpec: type.baseSpec });
    const sharkleted = computeEffectiveSpec({
      baseSpec: type.baseSpec,
      options: AIRCRAFT_CATALOGUE_V1.options.filter((o) => o.id === 'sharklets'),
    });

    const before = settlementAirframeOf(plain).cruiseBurnTPerNm;
    const after = settlementAirframeOf(sharkleted).cruiseBurnTPerNm;

    expect(after / before).toBeCloseTo(0.965, 12);
    // And nothing else moved: sharklets are a burn option, so a difference in
    // speed or weight here would mean the wrong field had been read.
    expect(settlementAirframeOf(sharkleted).cruiseSpeedKt).toBe(
      settlementAirframeOf(plain).cruiseSpeedKt,
    );
  });

  it('separates the turboprop from the jet in every dimension it bills on', () => {
    // The shape of the whole change, in one assertion: these three numbers were
    // identical for every flight in the game.
    const atr = settlementAirframeOf(specOf('ATR 72-600'));
    const neo = settlementAirframeOf(specOf('A320neo'));

    expect(neo.cruiseSpeedKt).toBeGreaterThan(atr.cruiseSpeedKt);
    expect(neo.maxTakeoffWeightT).toBeGreaterThan(atr.maxTakeoffWeightT);
    expect(neo.cruiseBurnTPerNm).toBeGreaterThan(atr.cruiseBurnTPerNm);
  });

  it('takes the fuel fraction from the economy rather than a constant', () => {
    // `tripFuelFraction` is a balance number (invariant 3), so a world running a
    // retuned economy has to reach a different figure. Hard-coding 0.85 here
    // would put a balance literal in the server.
    const spec = specOf('A320neo');
    const tighter = settlementAirframeOf(spec, {
      ...DEFAULT_FUEL_BURN,
      tripFuelFraction: 0.5,
    });
    expect(tighter.cruiseBurnTPerNm).toBeCloseTo(
      settlementAirframeOf(spec).cruiseBurnTPerNm * (DEFAULT_FUEL_BURN.tripFuelFraction / 0.5),
      12,
    );
  });
});
