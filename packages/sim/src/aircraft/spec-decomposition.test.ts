import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT_CATALOGUE_V1,
  AIRCRAFT_OPTIONS_V1_BY_ID,
  type AircraftOption,
  type AircraftType,
} from '@tailfin/shared';

import { computeEffectiveBuild, computeEffectiveSpec, validateBuild } from './effective-spec';
import { type CabinWeight } from './payload-range';
import { CAPABILITY_AXES, decomposeBuild, SPEC_AXES } from './spec-decomposition';

/**
 * Taking an effective spec apart (M4-07, App. C.6).
 *
 * M4-07's first acceptance criterion — *"effective spec shows base value and
 * delta per option, not just the total"* — is a claim about arithmetic, so this
 * file is mostly one property asserted over the shipped catalogue rather than a
 * handful of hand-checked rows:
 *
 *   **base + the sum of the steps = the spec the engine bills.**
 *
 * If that ever stops holding, the build screen is telling a player a story the
 * simulation does not agree with, and every individual figure on it becomes
 * unfalsifiable. It is the same reason `used-market.test.ts` asserts its
 * valuation decomposes exactly.
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

/**
 * Every research topic any shipped option asks for.
 *
 * Held in full by the walk below, and that is not a convenience: without it
 * `validateBuild` refuses `etops-180`, `etops-330` and `cat-iiib`, and the
 * exactness property would then never touch `etopsMinutes` or
 * `lowVisibilityCancellationFactor` at all. The reachability assertion at the
 * bottom of this file is what caught that.
 */
const EVERY_RESEARCH_TOPIC: readonly string[] = [
  ...new Set(
    [...AIRCRAFT_OPTIONS_V1_BY_ID.values()].flatMap((option) => [...option.requiresResearch]),
  ),
];

/** Every option a type offers that can legally be taken with the ones before it. */
function everyLegalOption(type: AircraftType): readonly AircraftOption[] {
  const taken: string[] = [];
  for (const id of type.availableOptionIds) {
    const candidate = [...taken, id];
    const refusals = validateBuild({
      type,
      catalogue: AIRCRAFT_OPTIONS_V1_BY_ID,
      optionIds: candidate,
      research: EVERY_RESEARCH_TOPIC,
    });
    if (refusals.length === 0) taken.push(id);
  }
  return optionsNamed(...taken);
}

const A320NEO = typeNamed('A320neo');

// ---------------------------------------------------------------------------
// The property the criterion rests on
// ---------------------------------------------------------------------------

describe('a decomposition is exact', () => {
  it('sums to the spec the engine bills, for every type in the catalogue', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      const options = everyLegalOption(type);
      const listPriceMinor = type.listPrice ?? 0;
      const { base, steps, build } = decomposeBuild({
        baseSpec: type.baseSpec,
        options,
        listPriceMinor,
      });

      // The last fold *is* the total, not a reconstruction of it.
      expect(build.spec, type.designation).toEqual(
        computeEffectiveSpec({ baseSpec: type.baseSpec, options, listPriceMinor }),
      );

      for (const axis of SPEC_AXES) {
        const summed = steps.reduce(
          (total, step) =>
            total +
            (step.movements.find((movement) => movement.axis === axis)?.after ?? 0) -
            (step.movements.find((movement) => movement.axis === axis)?.before ?? 0),
          base[axis],
        );
        // Floating point: burn is a chain of multiplications, so the sum of
        // differences and the folded value agree to within representation error
        // rather than bit-for-bit.
        expect(summed, `${type.designation} ${axis}`).toBeCloseTo(build.spec[axis], 9);
      }
    }
  });

  it('accounts for every option in price and lead time', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      const options = everyLegalOption(type);
      const listPriceMinor = type.listPrice ?? 0;
      const { steps, build } = decomposeBuild({
        baseSpec: type.baseSpec,
        options,
        listPriceMinor,
      });

      const price = steps.reduce((total, step) => total + step.priceMinor, listPriceMinor);
      const lead = steps.reduce((total, step) => total + step.leadTimeWeeks, 0);
      expect(price, `${type.designation} price`).toBe(build.priceMinor);
      expect(lead, `${type.designation} lead time`).toBe(build.leadTimeWeeks);
    }
  });

  it('reports one step per option, in the order the fold used', () => {
    const options = everyLegalOption(A320NEO);
    const { steps, build } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      options,
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    expect(steps).toHaveLength(options.length);
    // Canonical, by option id — the order `computeEffectiveBuild` folds in, so
    // the attribution a player reads is the attribution the engine performed.
    expect(steps.map((step) => step.optionId)).toEqual([...build.optionIds]);
  });

  it('decomposes a build with no options into no steps at all', () => {
    const { base, steps, build } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    expect(steps).toEqual([]);
    expect(base).toEqual(A320NEO.baseSpec);
    expect(build.spec).toEqual(A320NEO.baseSpec);
  });
});

// ---------------------------------------------------------------------------
// Why prefix folds rather than printing `specDeltas`
// ---------------------------------------------------------------------------

describe('the numbers a player could not have worked out from the percentages', () => {
  /**
   * The case in the module header. Both options are quoted by C.3 as a
   * percentage of burn, and adding the percentages gives the wrong aeroplane
   * because the second factor applies to a burn the first already reduced.
   */
  it('splits two multiplicative burn options by what each actually saved', () => {
    const options = optionsNamed('efficiency-package', 'sharklets');
    const { base, steps, build } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      options,
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    expect(base.fuelBurnKgPerHour).toBe(2_100);
    // Canonical order puts the efficiency package first, so it gets the full
    // 2% of 2100 and sharklets take 3.5% of what is left.
    const burn = steps.map(
      (step) => step.movements.find((movement) => movement.axis === 'fuelBurnKgPerHour')?.after,
    );
    expect(burn[0]).toBeCloseTo(2_058, 6);
    expect(burn[1]).toBeCloseTo(1_985.97, 6);
    expect(build.spec.fuelBurnKgPerHour).toBeCloseTo(1_985.97, 6);

    // The naive reading — add the percentages — is a different aeroplane, and
    // this is the assertion that would fail if anyone "simplified" the module
    // into printing `specDeltas`.
    expect(2_100 * (1 - 0.02 - 0.035)).not.toBeCloseTo(build.spec.fuelBurnKgPerHour, 6);
  });

  it('turns a seat-ceiling percentage into seats', () => {
    const { base, steps } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      options: optionsNamed('high-density-exits'),
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    expect(base.maxSeats).toBe(180);
    const seats = steps[0]?.movements.find((movement) => movement.axis === 'maxSeats');
    // 180 x 1.22 = 219.6, rounded once by the fold. "+22%" is not a seat count,
    // and 219.6 is not an aeroplane.
    expect(seats).toEqual({ axis: 'maxSeats', before: 180, after: 220 });
  });

  it('reports a wingspan change as a step along the scale, not a number', () => {
    const triple7 = typeNamed('777-9');
    const { steps } = decomposeBuild({
      baseSpec: triple7.baseSpec,
      options: optionsNamed('folding-wingtips'),
      listPriceMinor: triple7.listPrice ?? 0,
    });

    expect(triple7.baseSpec.wingspanCode).toBe('F');
    expect(steps[0]?.wingspan).toEqual({ before: 'F', after: 'E' });
  });

  it('says nothing about an axis an option did not move', () => {
    const { steps } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      options: optionsNamed('mtow-increase'),
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    const moved = steps[0]?.movements.map((movement) => movement.axis) ?? [];
    // C.3 rule 1 is that an option debits *at least one* axis, not all of them.
    // A readout listing eleven unchanged numbers is how the two that changed get
    // lost. Both of these are the paper upgrade: a higher certificated weight is
    // a higher payload limit, which is what it is bought for.
    expect(moved).toEqual(['maxPayloadTonnes', 'mtowTonnes']);
    expect(steps[0]?.wingspan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The charges no specification field carries
// ---------------------------------------------------------------------------

describe('capabilities and the charges C.3 makes outside the spec', () => {
  it('shows an ETOPS approval arriving from nothing, not from zero', () => {
    const { steps } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      options: optionsNamed('etops-180'),
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    // `null` is "no approval", which is a different fact from "zero minutes of
    // approved diversion" — every aircraft may fly inside the 60-minute rule.
    expect(steps[0]?.capabilityMovements).toEqual([
      { axis: 'etopsMinutes', before: null, after: 180 },
    ]);
  });

  it('shows the comfort charge that is the whole point of a lightweight cabin', () => {
    const { steps } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      options: optionsNamed('lightweight-cabin'),
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    const step = steps[0];
    // The weight saving is in the spec; the comfort and maintenance charges are
    // not, and a readout showing only "-1.8 t" has hidden the trade.
    expect(step?.movements).toEqual([{ axis: 'oewTonnes', before: 44.3, after: 42.5 }]);
    expect(step?.capabilityMovements).toEqual([
      { axis: 'comfortDelta', before: 0, after: -0.1 },
      { axis: 'maintenanceCostFactor', before: 1, after: 1.05 },
    ]);
  });

  it('names a capability an option switched on', () => {
    const xlr = typeNamed('A321XLR');
    const { steps } = decomposeBuild({
      baseSpec: xlr.baseSpec,
      options: everyLegalOption(xlr),
      listPriceMinor: xlr.listPrice ?? 0,
    });

    const gained = steps.flatMap((step) => step.capabilitiesGained);
    // Whatever the XLR's option list grants, each grant is attributed to exactly
    // one step. A capability appearing twice would mean two options claiming the
    // same switch, which is the double-count this shape prevents.
    expect(new Set(gained).size).toBe(gained.length);
  });

  it('decomposes every capability axis it claims to cover', () => {
    // Every axis in `CAPABILITY_AXES` is reachable from some shipped option, so
    // the list cannot quietly grow an entry nothing can move — the dead
    // configuration M4-06's risk ceiling turned out to be.
    const reachable = new Set<string>();
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      const { steps } = decomposeBuild({
        baseSpec: type.baseSpec,
        options: everyLegalOption(type),
        listPriceMinor: type.listPrice ?? 0,
      });
      for (const step of steps) {
        for (const movement of step.capabilityMovements) reachable.add(movement.axis);
      }
    }
    expect([...CAPABILITY_AXES].filter((axis) => !reachable.has(axis))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The cabin
// ---------------------------------------------------------------------------

describe('a fitted cabin is a step like any other', () => {
  const CABIN: CabinWeight = { seats: 180, seatWeightKg: 14, fittingsWeightT: 1.4 };

  it('keeps the sum exact when a cabin is fitted', () => {
    const options = optionsNamed('efficiency-package', 'sharklets', 'mtow-increase');
    const { base, steps, build } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      cabin: CABIN,
      options,
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    // The cabin moves OEW before any option does (§6.1). Left out of the steps,
    // the OEW column would not add up for any airframe that has one — which is
    // every airframe, once M6 ships cabins.
    expect(steps[0]?.optionId).toBeNull();
    expect(steps).toHaveLength(options.length + 1);

    const oew = steps.reduce(
      (total, step) =>
        total +
        (step.movements.find((movement) => movement.axis === 'oewTonnes')?.after ?? 0) -
        (step.movements.find((movement) => movement.axis === 'oewTonnes')?.before ?? 0),
      base.oewTonnes,
    );
    expect(oew).toBeCloseTo(build.spec.oewTonnes, 9);
    expect(build.spec).toEqual(
      computeEffectiveBuild({
        baseSpec: A320NEO.baseSpec,
        cabin: CABIN,
        options,
        listPriceMinor: A320NEO.listPrice ?? 0,
      }).spec,
    );
  });

  it('charges the cabin nothing in price or lead time', () => {
    const { steps } = decomposeBuild({
      baseSpec: A320NEO.baseSpec,
      cabin: CABIN,
      listPriceMinor: A320NEO.listPrice ?? 0,
    });

    // A cabin is bought in the cabin builder, not from the manufacturer. Pricing
    // it here would bill it twice once M6 arrives.
    expect(steps[0]?.priceMinor).toBe(0);
    expect(steps[0]?.leadTimeWeeks).toBe(0);
  });
});
