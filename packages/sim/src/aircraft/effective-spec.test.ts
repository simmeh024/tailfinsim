import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT_CATALOGUE_V1,
  AIRCRAFT_OPTIONS_V1_BY_ID,
  type AircraftOption,
  type AircraftType,
  type WingspanCode,
} from '@tailfin/shared';

import { computeFuelCost, DEFAULT_FUEL_MARKET } from '../economy/fuel-price';
import { DEFAULT_AIRPORT_FEES, settleFlight } from '../economy/settlement';
import { computeBlockTime } from '../flight/block';
import { computeFuelBurn } from '../flight/fuel';
import { DEFAULT_FLIGHT_PROFILE } from '../flight/profile';
import { checkReachability } from '../route/reachability';

import {
  computeEffectiveBuild,
  computeEffectiveSpec,
  optionDeltasFor,
  resolveOptions,
  stepWingspanCode,
  validateBuild,
} from './effective-spec';

/**
 * `effective_spec` and the configurator (M4-03, App. C.3, C.4, C.6).
 *
 * The four claims M4-03 is accountable for, and the order they matter in:
 *
 *   1. **App. C.4's three-way A321neo reproduces.** It is the only place the
 *      design doc configures the same aircraft three ways and states the result,
 *      so it is the one test that can catch a delta authored wrongly.
 *   2. **Sharklets raise the wingspan code, and that reaches gate compatibility.**
 *      C.3 rule 3 wants a fuel-saving option to be able to strand you at your own
 *      hub, and it only does if the code propagates to `checkReachability`.
 *   3. **An MTOW increase raises landing fees at every airport.** C.3 rule 4.
 *   4. **Nothing special-cases an option.** Every assertion below reads a folded
 *      spec; none names an option to a downstream function.
 */

function typeNamed(designation: string): AircraftType {
  const type = AIRCRAFT_CATALOGUE_V1.types.find((t) => t.designation === designation);
  if (type === undefined) throw new Error(`No ${designation} in the shipped catalogue`);
  return type;
}

function optionsNamed(...ids: readonly string[]): readonly AircraftOption[] {
  return ids.map((id) => {
    const option = AIRCRAFT_OPTIONS_V1_BY_ID.get(id);
    if (option === undefined) throw new Error(`No option ${id}`);
    return option;
  });
}

const A321NEO = typeNamed('A321neo');

// ---------------------------------------------------------------------------
// App. C.4 — one A321neo, three ways
// ---------------------------------------------------------------------------

describe('App. C.4: one A321neo, three ways', () => {
  const standard = computeEffectiveBuild({
    baseSpec: A321NEO.baseSpec,
    listPriceMinor: A321NEO.listPrice ?? 0,
  });

  const longRange = computeEffectiveBuild({
    baseSpec: A321NEO.baseSpec,
    // C.4's configuration column: "+3 ACT, +MTOW, ETOPS 180".
    options: optionsNamed('act-3', 'mtow-increase', 'etops-180'),
    listPriceMinor: A321NEO.listPrice ?? 0,
  });

  const highDensity = computeEffectiveBuild({
    baseSpec: A321NEO.baseSpec,
    // C.4: "High-density exits, lightweight cabin".
    options: optionsNamed('high-density-exits', 'lightweight-cabin'),
    listPriceMinor: A321NEO.listPrice ?? 0,
  });

  it('reproduces the range row: 4,000 / 4,700 / 3,800 nm at spec level', () => {
    expect(standard.spec.rangeNm).toBe(4_000);
    // The row C.4 states outright, and the reason `act-3` carries +700 rather
    // than a point lower in C.3's "+250 to +700 nm".
    expect(longRange.spec.rangeNm).toBe(4_700);

    /*
     * The high-density build's 3,800 nm is **not** a spec delta and is not
     * asserted as one.
     *
     * C.3 charges the high-density option in seats, turnaround, comfort and
     * galley space — not in tanks. Its 200 nm is what forty-four more passengers
     * weigh, which is a property of a *flight* at a *cabin*, and both
     * `computePayloadRange` and M6 own that. Asserting 3,800 here would mean
     * inventing a cabin weight in the milestone that does not own cabins.
     *
     * What is assertable, and is the honest half: the option takes no range out
     * of the specification.
     */
    expect(highDensity.spec.rangeNm).toBe(4_000);
  });

  it('reproduces the MTOW row: 97 / 101 / 97 t', () => {
    expect(standard.spec.mtowTonnes).toBe(97);
    expect(longRange.spec.mtowTonnes).toBe(101);
    // The high-density build buys no certificate, so it carries the base MTOW —
    // and therefore the base landing fee. C.4 says 97 t and means it.
    expect(highDensity.spec.mtowTonnes).toBe(97);
  });

  it('reproduces the belly cargo row: 100% / 62% / 94%', () => {
    expect(standard.cargoVolumeFactor).toBe(1);
    // C.4's headline trade: "The long-range build trades away 38% of its cargo
    // hold — which, per §12.1, is exactly the revenue that makes marginal
    // long-haul work."
    expect(longRange.cargoVolumeFactor).toBeCloseTo(0.62, 10);
    expect(highDensity.cargoVolumeFactor).toBeCloseTo(0.94, 10);
  });

  it('reproduces the seat row as the multiplier C.4 applies to a one-class cabin', () => {
    // C.4's seat row — 200 / 200 / 244 — is a *fitted* one-class cabin, not the
    // certificate: the A321neo's certified ceiling is 220. What C.3 sells is the
    // ceiling multiplier, and 200 × 1.22 = 244 exactly, which is what pins it to
    // the top of C.3's "+12% to +22%".
    const oneClassCabin = 200;
    const factor = highDensity.spec.maxSeats / standard.spec.maxSeats;
    expect(Math.round(oneClassCabin * factor)).toBe(244);

    // And the certificate itself moves with it.
    expect(standard.spec.maxSeats).toBe(220);
    expect(highDensity.spec.maxSeats).toBe(268);
    expect(longRange.spec.maxSeats).toBe(220);
  });

  it('reproduces the turnaround row: baseline / baseline / +5 min', () => {
    expect(standard.spec.turnaroundBaselineMin).toBe(45);
    expect(longRange.spec.turnaroundBaselineMin).toBe(45);
    expect(highDensity.spec.turnaroundBaselineMin).toBe(50);
  });

  it('reproduces the price row: $129M / $146M / $132M', () => {
    const millions = (minor: number): number => minor / 100 / 1_000_000;
    expect(millions(standard.priceMinor)).toBeCloseTo(129, 6);
    expect(millions(longRange.priceMinor)).toBeCloseTo(146, 6);
    expect(millions(highDensity.priceMinor)).toBeCloseTo(132, 6);
  });

  it('reproduces the delivery-lead row: baseline / +7 weeks / +2 weeks', () => {
    // C.3 rule 2 in numbers: "Ordering off-the-shelf is a legitimate speed play."
    expect(standard.leadTimeWeeks).toBe(0);
    expect(longRange.leadTimeWeeks).toBe(7);
    expect(highDensity.leadTimeWeeks).toBe(2);
  });

  it('gives the long-range build its ETOPS approval and leaves the others without one', () => {
    expect(standard.etopsMinutes).toBeNull();
    expect(longRange.etopsMinutes).toBe(180);
    expect(highDensity.etopsMinutes).toBeNull();
  });

  it('carries C.3 comfort charges without turning them into a score', () => {
    /*
     * C.3 charges −0.15 for high-density exits and −0.10 for the lightweight
     * cabin. C.4 shows the two together producing **0.38** from a 0.55 base,
     * which is not 0.55 − 0.25 by any reading, and is not 0.55 × 0.85 × 0.90
     * either.
     *
     * The design doc disagrees with itself here, so M4-03 does not guess: it
     * carries C.3's charges as the inputs they are and leaves the score to
     * M6-09, which owns comfort scoring and will have a cabin in hand. Raised
     * rather than silently resolved, per CONTRIBUTING.
     */
    expect(highDensity.comfortDelta).toBeCloseTo(-0.25, 10);
    expect(standard.comfortDelta).toBe(0);
  });

  it('leaves the standard build genuinely standard', () => {
    // The base spec, unchanged, through the same code path an option-laden
    // build goes through. If this ever diverges, the fold has grown a default.
    expect(computeEffectiveSpec({ baseSpec: A321NEO.baseSpec })).toEqual(A321NEO.baseSpec);
  });
});

// ---------------------------------------------------------------------------
// C.3 rule 3 — wingspan is a live constraint
// ---------------------------------------------------------------------------

describe('C.3 rule 3: sharklets raise the wingspan code, and it reaches the gate', () => {
  const sharkletted = computeEffectiveSpec({
    baseSpec: A321NEO.baseSpec,
    options: optionsNamed('sharklets'),
  });

  it('moves the A321neo from code C to code D', () => {
    expect(A321NEO.baseSpec.wingspanCode).toBe('C');
    expect(sharkletted.wingspanCode).toBe('D');
  });

  /**
   * The propagation, end to end, through the function that actually decides.
   *
   * `checkReachability` is given a capability and an airport. It has never heard
   * of sharklets and does not need to: the code it compares is the folded one.
   * That is C.6's rule working — *"nothing special-cases options"*.
   */
  const hub = {
    icao: 'EHAM',
    longestRunwayM: 3_800,
    elevationFt: -11,
    maxWingspanCode: 'C' as const,
    hours: null,
    countryCode: 'NL',
  };
  const destination = { ...hub, icao: 'LEBL', countryCode: 'ES' };
  // Everything except the wingspan deliberately fine, so the one check that
  // fails is the one under test.
  const plan = {
    distanceNm: 800,
    departureMinute: 9 * 60,
    arrivalMinute: 11 * 60,
    diversionMinutes: 0,
    hasTrafficRights: true,
    hasSlot: true,
  };

  const capabilityFor = (wingspanCode: WingspanCode) => ({
    rangeNm: 4_000,
    takeoffRunM: 2_200,
    wingspanCode,
    etopsMinutes: null,
  });

  it('refuses the gate that took the aircraft before the option', () => {
    // Standard build: the hub takes it.
    const standard = checkReachability(
      capabilityFor(A321NEO.baseSpec.wingspanCode),
      hub,
      destination,
      plan,
    );
    expect(standard.ok).toBe(true);

    // Same aircraft, one fuel-saving option, and now its own hub refuses it —
    // which C.3 calls "exactly the kind of mistake this system should let you
    // make".
    const withSharklets = checkReachability(
      capabilityFor(sharkletted.wingspanCode),
      hub,
      destination,
      plan,
    );
    expect(withSharklets.ok).toBe(false);
    expect(withSharklets.ok === false && withSharklets.reason).toBe('wingspan');
  });

  it('folds the 777-9 down a code, which is what C.3 sells the wingtips for', () => {
    const triple7 = typeNamed('777-9');
    expect(triple7.baseSpec.wingspanCode).toBe('F');

    const folded = computeEffectiveSpec({
      baseSpec: triple7.baseSpec,
      options: optionsNamed('folding-wingtips'),
    });
    expect(folded.wingspanCode).toBe('E');
    // C.3 names the aircraft, so the catalogue must offer it only there.
    expect(triple7.availableOptionIds).toContain('folding-wingtips');
    expect(A321NEO.availableOptionIds).not.toContain('folding-wingtips');
  });

  it('clamps at both ends of the scale rather than throwing', () => {
    // Physically meaningful ends: nothing folds below A, nothing grows above F.
    expect(stepWingspanCode('A', -3)).toBe('A');
    expect(stepWingspanCode('F', 2)).toBe('F');
    expect(stepWingspanCode('C', 0)).toBe('C');
  });
});

// ---------------------------------------------------------------------------
// C.3 rule 4 — an MTOW increase raises landing fees for ever
// ---------------------------------------------------------------------------

describe('C.3 rule 4: an MTOW increase raises landing fees at every airport', () => {
  const A321_BURN_T_PER_NM = 2.4 / 447;

  function landingCostMinor(mtowTonnes: number): number {
    const block = computeBlockTime(800, A321NEO.baseSpec.cruiseSpeedKt, DEFAULT_FLIGHT_PROFILE);
    const burn = computeFuelBurn(block, { cruiseBurnTPerNm: A321_BURN_T_PER_NM });
    const settled = settleFlight({
      kind: 'scheduled',
      load: { economy: { seats: 180, passengers: 150, revenue: 150 * 12_000 } },
      cargoKg: 0,
      block,
      fuelCost: computeFuelCost(burn.tonnes, DEFAULT_FUEL_MARKET, {
        icao: 'EHAM',
        regionFactor: 1.03,
        intoPlaneFeePerTonne: 35,
      }),
      // The whole point: what settlement reads is the *effective* MTOW.
      aircraft: { maxTakeoffWeightT: mtowTonnes },
      originFees: DEFAULT_AIRPORT_FEES,
      destinationFees: DEFAULT_AIRPORT_FEES,
    });
    const airport = settled.costs.find((line) => line.source === 'airport');
    if (airport === undefined) throw new Error('No airport cost line');
    return airport.amountMinor;
  }

  it('costs more per landing, by exactly the tonnage bought', () => {
    const standard = computeEffectiveSpec({ baseSpec: A321NEO.baseSpec });
    const upgraded = computeEffectiveSpec({
      baseSpec: A321NEO.baseSpec,
      options: optionsNamed('mtow-increase'),
    });

    const before = landingCostMinor(standard.mtowTonnes);
    const after = landingCostMinor(upgraded.mtowTonnes);

    expect(after).toBeGreaterThan(before);
    // Charged per tonne at every airport, every flight — so the delta is the
    // four tonnes at the airport's own rate and nothing else.
    const boughtTonnes = upgraded.mtowTonnes - standard.mtowTonnes;
    expect(boughtTonnes).toBe(4);
    expect(after - before).toBe(
      Math.round(upgraded.mtowTonnes * DEFAULT_AIRPORT_FEES.landingPerTonne) -
        Math.round(standard.mtowTonnes * DEFAULT_AIRPORT_FEES.landingPerTonne),
    );
  });
});

// ---------------------------------------------------------------------------
// The fold itself
// ---------------------------------------------------------------------------

describe('folding a build', () => {
  it('adds weights and multiplies factors', () => {
    // Two burn factors compound rather than sum: 0.965 × 0.98, not 1 − 0.055.
    const both = computeEffectiveSpec({
      baseSpec: A321NEO.baseSpec,
      options: optionsNamed('sharklets', 'efficiency-package'),
    });
    expect(both.fuelBurnKgPerHour).toBeCloseTo(
      A321NEO.baseSpec.fuelBurnKgPerHour * 0.965 * 0.98,
      6,
    );

    // Weights add.
    const heavy = computeEffectiveSpec({
      baseSpec: A321NEO.baseSpec,
      options: optionsNamed('sharklets', 'cargo-door'),
    });
    expect(heavy.oewTonnes).toBeCloseTo(A321NEO.baseSpec.oewTonnes + 0.3 + 2.1, 10);
  });

  it('is the same whatever order the options were chosen in', () => {
    // CONTRIBUTING invariant 2. A build is a *set* of ids, and a replay
    // reconstructing one must fold it to the same numbers for ever.
    const forwards = computeEffectiveSpec({
      baseSpec: A321NEO.baseSpec,
      options: optionsNamed('sharklets', 'mtow-increase', 'act-3', 'etops-180'),
    });
    const backwards = computeEffectiveSpec({
      baseSpec: A321NEO.baseSpec,
      options: optionsNamed('etops-180', 'act-3', 'mtow-increase', 'sharklets'),
    });
    expect(forwards).toEqual(backwards);
  });

  it('rounds a runway requirement up, never down', () => {
    // A requirement rounded down is a safety claim the arithmetic cannot make.
    const shortField = computeEffectiveSpec({
      baseSpec: A321NEO.baseSpec,
      options: optionsNamed('thrust-rating-high'),
    });
    const exact = A321NEO.baseSpec.runwayRequirementM * 0.88;
    expect(shortField.runwayRequirementM).toBe(Math.ceil(exact));
    expect(shortField.runwayRequirementM).toBeGreaterThanOrEqual(exact);
  });

  it('keeps a two-class layout inside the certificate', () => {
    const withDoor = computeEffectiveSpec({
      baseSpec: A321NEO.baseSpec,
      options: optionsNamed('cargo-door'),
    });
    // A cargo door takes physical space, so it comes out of both counts.
    expect(withDoor.maxSeats).toBe(A321NEO.baseSpec.maxSeats - 22);
    expect(withDoor.seatsTwoClass).toBe(A321NEO.baseSpec.seatsTwoClass - 22);
    expect(withDoor.seatsTwoClass).toBeLessThanOrEqual(withDoor.maxSeats);
  });

  it('adds cabin furnishing weight when a cabin is fitted', () => {
    const bare = computeEffectiveSpec({ baseSpec: A321NEO.baseSpec });
    const furnished = computeEffectiveSpec({
      baseSpec: A321NEO.baseSpec,
      cabin: { seats: 200, seatWeightKg: 12, fittingsWeightT: 1.5 },
    });
    expect(furnished.oewTonnes).toBeCloseTo(bare.oewTonnes + (200 * 12) / 1000 + 1.5, 10);
  });

  it('refuses a build that would leave no aircraft', () => {
    expect(() =>
      computeEffectiveSpec({
        baseSpec: { ...A321NEO.baseSpec, oewTonnes: 1 },
        options: optionsNamed('lightweight-cabin'),
      }),
    ).toThrow(/non-positive operating empty weight/i);
  });

  it('hands the physics layer the same authored numbers', () => {
    // The bridge that keeps one set of option deltas in the repository rather
    // than two. `payload-range.ts` predates the catalogue and folds its own
    // subset; these are the rows it now folds.
    const deltas = optionDeltasFor(optionsNamed('sharklets', 'mtow-increase'));
    expect(deltas.map((d) => d.id)).toEqual(['mtow-increase', 'sharklets']);
    expect(deltas.find((d) => d.id === 'sharklets')?.burnFactor).toBe(0.965);
    expect(deltas.find((d) => d.id === 'mtow-increase')?.mtowDeltaT).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Build validation
// ---------------------------------------------------------------------------

describe('validating a build', () => {
  const catalogue = AIRCRAFT_OPTIONS_V1_BY_ID;
  const type = { designation: 'A321neo', availableOptionIds: A321NEO.availableOptionIds };

  it('accepts a build C.4 orders', () => {
    expect(
      validateBuild({
        type,
        catalogue,
        optionIds: ['act-3', 'mtow-increase', 'etops-180'],
        research: ['etops-180'],
      }),
    ).toEqual([]);
  });

  it('refuses two auxiliary tank fits at once, once per pair', () => {
    const refusals = validateBuild({ type, catalogue, optionIds: ['act-1', 'act-3'] });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe('conflict');
    expect(refusals[0]?.optionId).toBe('act-1');
    expect(refusals[0]?.withOptionId).toBe('act-3');
  });

  it('refuses an option this type cannot be ordered with, and names the type', () => {
    const refusals = validateBuild({ type, catalogue, optionIds: ['folding-wingtips'] });
    expect(refusals.map((r) => r.code)).toContain('not_available_for_type');
    expect(refusals[0]?.detail).toContain('A321neo');
  });

  it('refuses an unknown option rather than ignoring it', () => {
    const refusals = validateBuild({ type, catalogue, optionIds: ['winglets-deluxe'] });
    expect(refusals.map((r) => r.code)).toEqual(['unknown_option']);
  });

  it('refuses ETOPS without the research, and names the topic', () => {
    const refusals = validateBuild({ type, catalogue, optionIds: ['etops-180'] });
    expect(refusals.map((r) => r.code)).toEqual(['research_required']);
    expect(refusals[0]?.research).toBe('etops-180');
  });

  it('refuses a structural option as a retrofit — C.3 rule 5', () => {
    const atOrder = validateBuild({ type, catalogue, optionIds: ['cargo-door'] });
    expect(atOrder).toEqual([]);

    const asRetrofit = validateBuild({
      type,
      catalogue,
      optionIds: ['cargo-door'],
      retrofit: true,
    });
    expect(asRetrofit.map((r) => r.code)).toEqual(['not_retrofittable']);
  });

  it('reports every refusal rather than the first', () => {
    // A configurator should be able to mark every offending choice at once — the
    // same reasoning M3-09's fare floor uses when it returns a violation per cabin.
    const refusals = validateBuild({
      type,
      catalogue,
      optionIds: ['act-1', 'act-3', 'folding-wingtips', 'etops-180'],
    });
    expect(new Set(refusals.map((r) => r.code))).toEqual(
      new Set(['conflict', 'not_available_for_type', 'research_required']),
    );
  });

  it('treats a duplicated id as one choice, not a conflict with itself', () => {
    expect(validateBuild({ type, catalogue, optionIds: ['sharklets', 'sharklets'] })).toEqual([]);
  });

  it('resolves ids to rows only when the build is valid', () => {
    const bad = resolveOptions({ type, catalogue, optionIds: ['act-1', 'act-2'] });
    expect(bad.ok).toBe(false);

    const good = resolveOptions({ type, catalogue, optionIds: ['sharklets', 'act-3'] });
    expect(good.ok).toBe(true);
    expect(good.ok && good.options.map((o) => o.id)).toEqual(['act-3', 'sharklets']);
  });
});
