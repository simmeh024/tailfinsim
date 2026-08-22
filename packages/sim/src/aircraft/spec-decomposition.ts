import {
  type AircraftOption,
  type AircraftSpec,
  BuildCapability,
  type CapabilityAxis,
  CapabilityMovement,
  SpecAxis,
  type SpecMovement,
  type SpecWingspanMovement,
} from '@tailfin/shared';

import {
  computeEffectiveBuild,
  type EffectiveBuild,
  type EffectiveBuildInput,
} from './effective-spec';

/**
 * Where an effective spec came from, option by option (M4-07, App. C.6).
 *
 * `effective-spec.ts` folds a build into one answer, which is the right shape for
 * every consumer: *"everything downstream reads only `effective_spec`"*. This
 * file answers the other question — the player's. M4-07's first acceptance
 * criterion is that the *"effective spec shows base value and delta per option,
 * not just the total"*, and the reason is CONTRIBUTING's fourth invariant: a
 * 79.4 t MTOW a player cannot take apart is a number they will assume is a bug,
 * and a configurator that only shows totals is one you cannot learn from.
 *
 * ## Prefix folds, not per-option arithmetic
 *
 * The obvious implementation is to read each option's `specDeltas` and print
 * them. It is also wrong, and quietly. `computeEffectiveBuild` multiplies where
 * C.3 quotes a percentage, rounds `maxSeats` once at the end, rounds
 * `runwayRequirementM` up, clamps `seatsTwoClass` to the certificate and clamps
 * the wingspan code at both ends of the scale. So an option's published delta is
 * not the delta it produced in *this* build. An A320neo with the efficiency
 * package and sharklets, both of which C.3 quotes as a percentage of burn:
 *
 * ```
 *                          printed from specDeltas      actually folded
 *   base                            2100 kg/h              2100 kg/h
 *   efficiency package (x0.98)          -2%                  -42.00
 *   sharklets (x0.965)                -3.5%                  -72.03
 *   effective                         -5.5%  = 1984.5      1985.97 kg/h
 * ```
 *
 * The percentages are accurate about the options and add up to the wrong
 * aeroplane, because the second factor applies to a burn the first already
 * reduced. `maxSeats` fails the same way from the other direction: high-density
 * exits are *"+22%"*, and what the player needs to know is *"180 seats becomes
 * 220"*.
 *
 * So this reports the difference between two real folds — prefix `i` and prefix
 * `i - 1` — which makes the decomposition **arithmetically exact by
 * construction**: every `after` is a spec the engine really computed, the last
 * one *is* `computeEffectiveSpec` of the whole build, and every axis satisfies
 * `base + sum of deltas = effective`. The same approach `used-market.ts` takes
 * with its valuation, and for the same reason — a decomposition that can
 * disagree with the number it explains is worse than no decomposition at all.
 *
 * The cost is that attribution is **order-dependent**, and it has to be: in the
 * table above, whichever factor is applied second gets the smaller share. The
 * order used is the one the billing fold uses — canonical, by option id — so what
 * a player is shown is what the engine did rather than a second story about it.
 *
 * ## Determinism
 *
 * Nothing here decides anything. Every number is `computeEffectiveBuild`'s, so
 * this cannot drift from the spec it explains even when C.3's rules change
 * underneath it.
 */

/**
 * The axis lists, from the wire contract rather than restated here.
 *
 * They live in `@tailfin/shared` because they cross the boundary — the client
 * renders a movement per axis — and one list means a new specification field
 * cannot arrive with a decomposition that quietly ignores it. `fleet.test.ts`
 * asserts `SPEC_AXES` plus `wingspanCode` is exactly `AircraftSpec`.
 */
export const SPEC_AXES: readonly SpecAxis[] = SpecAxis.options;
export const CAPABILITY_AXES: readonly CapabilityAxis[] = CapabilityMovement.shape.axis.options;
export const BUILD_CAPABILITIES: readonly BuildCapability[] = BuildCapability.options;

/** One contribution to the effective spec: an option, or the cabin fitted. */
export interface BuildStep {
  /**
   * The option that made this step, or `null` for the cabin.
   *
   * The cabin is a step because it moves OEW before any option does (§6.1), and
   * leaving it out would break the sum for any airframe that has one.
   */
  optionId: string | null;
  /** The running spec **after** this step — a fold the engine really performed. */
  spec: AircraftSpec;
  /** Only the axes this step moved. A step that moved none is still a step. */
  movements: readonly SpecMovement[];
  /** Set only when this step moved the aircraft along the wingspan scale. */
  wingspan: SpecWingspanMovement | null;
  capabilityMovements: readonly CapabilityMovement[];
  /** Capabilities this step switched on. */
  capabilitiesGained: readonly BuildCapability[];
  /** What it added to the price, in minor units. Zero for the cabin. */
  priceMinor: number;
  /** Weeks it added to delivery. C.3 rule 2. */
  leadTimeWeeks: number;
}

export interface SpecDecomposition {
  /** The type's published base spec, before the cabin and before any option. */
  base: AircraftSpec;
  /**
   * Every contribution, in the order the engine folded it: the cabin first when
   * there is one, then the options in canonical order.
   */
  steps: readonly BuildStep[];
  /** The total. Identical to `computeEffectiveBuild` on the same input. */
  build: EffectiveBuild;
}

function movementsBetween(before: AircraftSpec, after: AircraftSpec): SpecMovement[] {
  const moved: SpecMovement[] = [];
  for (const axis of SPEC_AXES) {
    if (before[axis] !== after[axis])
      moved.push({ axis, before: before[axis], after: after[axis] });
  }
  return moved;
}

function capabilityMovementsBetween(
  before: EffectiveBuild,
  after: EffectiveBuild,
): CapabilityMovement[] {
  const moved: CapabilityMovement[] = [];
  for (const axis of CAPABILITY_AXES) {
    if (before[axis] !== after[axis]) {
      moved.push({ axis, before: before[axis], after: after[axis] });
    }
  }
  return moved;
}

function capabilitiesGainedBetween(
  before: EffectiveBuild,
  after: EffectiveBuild,
): BuildCapability[] {
  return BUILD_CAPABILITIES.filter((flag) => !before[flag] && after[flag]);
}

function stepBetween(
  optionId: string | null,
  before: EffectiveBuild,
  after: EffectiveBuild,
): BuildStep {
  return {
    optionId,
    spec: after.spec,
    movements: movementsBetween(before.spec, after.spec),
    wingspan:
      before.spec.wingspanCode === after.spec.wingspanCode
        ? null
        : { before: before.spec.wingspanCode, after: after.spec.wingspanCode },
    capabilityMovements: capabilityMovementsBetween(before, after),
    capabilitiesGained: capabilitiesGainedBetween(before, after),
    priceMinor: after.priceMinor - before.priceMinor,
    leadTimeWeeks: after.leadTimeWeeks - before.leadTimeWeeks,
  };
}

/**
 * Take a build apart, exactly.
 *
 * Runs `computeEffectiveBuild` once per prefix — one more fold than there are
 * options, and no build in App. C.3 takes more than a handful — so every step is
 * a difference between specs the engine computed, rather than a second arithmetic
 * that has to be kept in step with the first.
 */
export function decomposeBuild(input: EffectiveBuildInput): SpecDecomposition {
  const { baseSpec, options = [], cabin, listPriceMinor = 0 } = input;

  // The bare type: no cabin, nothing fitted. Folded rather than used directly, so
  // `base` has been through the same validation and rounding as every other point
  // on the chain.
  const bare = computeEffectiveBuild({ baseSpec, listPriceMinor });

  const steps: BuildStep[] = [];
  let previous = bare;

  if (cabin !== undefined) {
    const withCabin = computeEffectiveBuild({ baseSpec, cabin, listPriceMinor });
    steps.push(stepBetween(null, previous, withCabin));
    previous = withCabin;
  }

  // The canonical order, taken from the fold itself rather than re-sorted here.
  // Two copies of "options are folded by id" is how the explanation and the
  // billing eventually disagree about which option came first.
  const full = computeEffectiveBuild(input);
  const byId = new Map(options.map((option) => [option.id, option]));

  const taken: AircraftOption[] = [];
  for (const id of full.optionIds) {
    const option = byId.get(id);
    // `optionIds` is derived from `options`, so this cannot miss; the guard keeps
    // the types honest rather than because it can happen.
    if (option === undefined) continue;
    taken.push(option);
    const upTo = computeEffectiveBuild({ baseSpec, cabin, listPriceMinor, options: [...taken] });
    steps.push(stepBetween(id, previous, upTo));
    previous = upTo;
  }

  return { base: bare.spec, steps, build: full };
}
