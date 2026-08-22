import {
  type AircraftOption,
  type AircraftSpec,
  type AircraftSpecDelta,
  WINGSPAN_CODES,
  type WingspanCode,
} from '@tailfin/shared';

import { type CabinWeight, cabinWeightT, type OptionDelta } from './payload-range';

/**
 * `effective_spec` — base spec plus option deltas plus cabin weight (M4-03, App. C.6).
 *
 * C.6 states the rule this file exists to make true, and the reason for it:
 *
 * > *"`effective_spec` is derived from base spec plus option deltas plus cabin
 * > weight, cached per airframe, recomputed on any change. **Everything
 * > downstream — reachability (App. B.4), fuel burn, fees, demand — reads only
 * > `effective_spec`.** Nothing special-cases options, which is what keeps the
 * > system from becoming unmaintainable."*
 *
 * So there is exactly one fold, here, and no consumer anywhere asks whether a
 * particular option was taken. A route check reads a wingspan code; it does not
 * know that sharklets exist. Landing fees read an MTOW; they do not know it was
 * bought on paper.
 *
 * ## Two effective specs, one of them narrower
 *
 * `payload-range.ts` already folds a **physics** subset — empty weight, MTOW,
 * tank capacity, cruise burn, takeoff run — because M2-02 needed the
 * payload/range trade before there was a catalogue to draw options from. That
 * function stays: it is the one that resolves a *flight*.
 *
 * This one folds the **catalogue** spec, which is the shape `Airframe.effectiveSpec`
 * is typed as and the shape every other consumer reads. {@link optionDeltasFor}
 * is the bridge, so the physics layer consumes the same authored option rows
 * rather than hand-written deltas — which is what makes C.6's rule true rather
 * than merely stated.
 *
 * ## Determinism
 *
 * Options are folded in a canonical order rather than the order a player clicked
 * them. Addition and multiplication commute in arithmetic and not quite in
 * floating point, and CONTRIBUTING invariant 2 requires the same inputs to
 * produce the same outputs for ever — including across a replay that reconstructs
 * a build from a stored set of ids.
 */

/** Every axis App. C.3 charges that no `AircraftSpec` field carries. */
export interface EffectiveBuildExtras {
  /**
   * Usable belly volume as a fraction of standard. App. C.4's long-range
   * A321neo ends at 0.62.
   *
   * Volume, not weight: §12's cargo system owns whether a consignment fits.
   */
  cargoVolumeFactor: number;
  /**
   * The sum of C.3's comfort charges, as an **input to M6-09's score** rather
   * than a score.
   *
   * M4-03 deliberately does not turn this into a comfort figure. C.3 charges
   * −0.15 for high-density exits and −0.10 for the lightweight cabin, and C.4
   * shows the two together producing 0.38 from a 0.55 base — which is not
   * 0.55 − 0.25 by any reading. The scoring model is M6-09's, the charges are
   * C.3's, and reconciling them is that issue's to do with a cabin in hand.
   */
  comfortDelta: number;
  /** Multiplier on maintenance cost. M4-06 owns what it multiplies. */
  maintenanceCostFactor: number;
  /**
   * Certified single-engine diversion minutes, or null for no approval.
   *
   * Feeds `AircraftCapability.etopsMinutes` — a type with no approval can still
   * fly anything inside the default 60-minute rule.
   */
  etopsMinutes: number | null;
  /** Multiplier on low-visibility cancellations. Cat IIIb buys 0.4. */
  lowVisibilityCancellationFactor: number;
  /** Whether this build may legally fly an ultra-long-haul sector (§9.2). */
  ulhCapable: boolean;
  /** Whether this build may operate from unpaved and gravel strips. */
  unpavedCapable: boolean;
}

export interface EffectiveBuild extends EffectiveBuildExtras {
  /** What every downstream consumer reads. */
  spec: AircraftSpec;
  /** List price plus every option's price, in minor units. */
  priceMinor: number;
  /** Weeks added to delivery by the options taken. C.3 rule 2. */
  leadTimeWeeks: number;
  /** The option ids folded in, in canonical order. */
  optionIds: readonly string[];
}

/** Neutral extras — what an aircraft ordered off the shelf carries. */
const NEUTRAL: EffectiveBuildExtras = {
  cargoVolumeFactor: 1,
  comfortDelta: 0,
  maintenanceCostFactor: 1,
  etopsMinutes: null,
  lowVisibilityCancellationFactor: 1,
  ulhCapable: false,
  unpavedCapable: false,
};

/**
 * Move along the wingspan scale, clamped at both ends.
 *
 * Clamped rather than thrown, because the ends are physically meaningful: a code
 * F aircraft folding into code E is C.3's whole folding-wingtip mechanic, and
 * nothing should be able to fold below code A or grow above code F.
 */
export function stepWingspanCode(code: WingspanCode, steps: number): WingspanCode {
  const index = WINGSPAN_CODES.indexOf(code);
  if (index < 0) throw new Error(`Unknown wingspan code "${code}"`);
  const moved = Math.min(WINGSPAN_CODES.length - 1, Math.max(0, index + steps));
  // Index is clamped into range above, so this cannot be undefined.
  return WINGSPAN_CODES[moved]!;
}

/**
 * Canonical fold order: by option id.
 *
 * Any total order would do. The id is used because it is stable across catalogue
 * versions in a way an array index is not, so a build stored as ids folds the
 * same way after a type's option list is reordered.
 */
function canonical(options: readonly AircraftOption[]): readonly AircraftOption[] {
  return [...options].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function assertPositive(value: number, what: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} must be a positive finite number, got ${String(value)}`);
  }
}

export interface EffectiveBuildInput {
  baseSpec: AircraftSpec;
  /** The options actually taken. Resolved rows, not ids — see {@link resolveOptions}. */
  options?: readonly AircraftOption[];
  /**
   * The cabin fitted, if one is (§6.1, M6).
   *
   * Adds furnishing weight to OEW. Omitted for a type-level spec, where the
   * published OEW already includes a reference cabin — see the note in
   * `payload-range.ts` about not counting the seats twice.
   */
  cabin?: CabinWeight;
  /** The type's list price, so the build can report a total. Zero when unpriced. */
  listPriceMinor?: number;
}

/**
 * Fold a base spec, a set of options and a cabin into one effective build.
 *
 * Weights, seats, ranges and times **add**; burn, runway and volume factors
 * **multiply**. Seat factors apply before seat deltas, because C.3's
 * high-density option raises the certified ceiling and the cargo door then takes
 * physical space out of whatever that ceiling is.
 */
export function computeEffectiveBuild(input: EffectiveBuildInput): EffectiveBuild {
  const { baseSpec, options = [], cabin, listPriceMinor = 0 } = input;

  assertPositive(baseSpec.mtowTonnes, 'MTOW');
  assertPositive(baseSpec.oewTonnes, 'OEW');
  assertPositive(baseSpec.rangeNm, 'Range');
  assertPositive(baseSpec.runwayRequirementM, 'Runway requirement');
  assertPositive(baseSpec.fuelBurnKgPerHour, 'Fuel burn');
  assertPositive(baseSpec.turnaroundBaselineMin, 'Turnaround baseline');

  const ordered = canonical(options);

  let maxSeats = baseSpec.maxSeats;
  let seatsTwoClass = baseSpec.seatsTwoClass;
  let seatsDelta = 0;
  let maxPayloadTonnes = baseSpec.maxPayloadTonnes;
  let rangeNm = baseSpec.rangeNm;
  let oewTonnes = baseSpec.oewTonnes + (cabin === undefined ? 0 : cabinWeightT(cabin));
  let mtowTonnes = baseSpec.mtowTonnes;
  let runwayFactor = 1;
  let burnFactor = 1;
  let wingspanSteps = 0;
  let turnaroundDelta = 0;

  const extras: EffectiveBuildExtras = { ...NEUTRAL };
  let priceMinor = listPriceMinor;
  let leadTimeWeeks = 0;

  for (const option of ordered) {
    const d: AircraftSpecDelta = option.specDeltas;

    // The certified ceiling scales; physical space comes out of it afterwards.
    if (d.maxSeatsFactor !== undefined) maxSeats *= d.maxSeatsFactor;
    seatsDelta += d.seatsDelta ?? 0;

    maxPayloadTonnes += d.maxPayloadDeltaTonnes ?? 0;
    rangeNm += d.rangeDeltaNm ?? 0;
    oewTonnes += d.oewDeltaTonnes ?? 0;
    mtowTonnes += d.mtowDeltaTonnes ?? 0;
    runwayFactor *= d.runwayRequirementFactor ?? 1;
    burnFactor *= d.fuelBurnFactor ?? 1;
    wingspanSteps += d.wingspanCodeSteps ?? 0;
    turnaroundDelta += d.turnaroundDeltaMin ?? 0;

    extras.cargoVolumeFactor *= d.cargoVolumeFactor ?? 1;
    extras.comfortDelta += d.comfortDelta ?? 0;
    extras.maintenanceCostFactor *= d.maintenanceCostFactor ?? 1;
    extras.lowVisibilityCancellationFactor *= d.lowVisibilityCancellationFactor ?? 1;
    if (d.ulhCapable === true) extras.ulhCapable = true;
    if (d.unpavedCapable === true) extras.unpavedCapable = true;
    if (d.etopsMinutes !== undefined) {
      // The best approval wins. Two ETOPS packages conflict, so in a valid build
      // there is at most one — this is what makes an invalid one still resolve.
      extras.etopsMinutes = Math.max(extras.etopsMinutes ?? 0, d.etopsMinutes);
    }

    priceMinor += option.priceMinor;
    leadTimeWeeks += option.leadTimeWeeks;
  }

  maxSeats = Math.max(0, Math.round(maxSeats) + seatsDelta);
  seatsTwoClass = Math.max(0, seatsTwoClass + seatsDelta);
  // A two-class layout cannot exceed the certificate.
  seatsTwoClass = Math.min(seatsTwoClass, maxSeats);

  if (oewTonnes <= 0) {
    throw new Error(`Options left a non-positive operating empty weight of ${String(oewTonnes)} t`);
  }
  if (maxPayloadTonnes <= 0) {
    throw new Error(`Options left a non-positive payload limit of ${String(maxPayloadTonnes)} t`);
  }

  const spec: AircraftSpec = {
    maxSeats,
    seatsTwoClass,
    maxPayloadTonnes,
    rangeNm,
    cruiseSpeedKt: baseSpec.cruiseSpeedKt,
    mtowTonnes,
    oewTonnes,
    // Rounded **up**: a runway requirement rounded down is a safety claim the
    // arithmetic does not support.
    runwayRequirementM: Math.ceil(baseSpec.runwayRequirementM * runwayFactor),
    fuelBurnKgPerHour: baseSpec.fuelBurnKgPerHour * burnFactor,
    wingspanCode: stepWingspanCode(baseSpec.wingspanCode, wingspanSteps),
    // No option in C.3 changes the noise certificate.
    noiseChapter: baseSpec.noiseChapter,
    turnaroundBaselineMin: Math.max(
      1,
      Math.round(baseSpec.turnaroundBaselineMin + turnaroundDelta),
    ),
  };

  return {
    spec,
    ...extras,
    priceMinor,
    leadTimeWeeks,
    optionIds: ordered.map((option) => option.id),
  };
}

/**
 * The spec alone — the common case, and the name C.6 uses.
 *
 * `AircraftSpec` in, `AircraftSpec` out, so a type-level read with no options is
 * the same code path as an airframe with nine. That uniformity is the point: it
 * is what makes *"no consumer reads the base spec directly"* a property of the
 * call graph rather than a convention.
 */
export function computeEffectiveSpec(input: EffectiveBuildInput): AircraftSpec {
  return computeEffectiveBuild(input).spec;
}

/**
 * The bridge to `payload-range.ts`'s physics fold.
 *
 * Its `OptionDelta` predates the catalogue and was documented as taking *"a list
 * of option deltas as arguments rather than stubbing"* a catalogue that did not
 * exist. This produces that list from the authored rows, so there is one set of
 * option numbers in the repository rather than two.
 *
 * `fuelCapacityDeltaT` is deliberately absent: C.3 quotes auxiliary tanks as
 * range rather than tonnage, and converting one into the other here would invent
 * a tank volume the design doc does not state. `computePayloadRange` takes the
 * range effect through the effective spec instead.
 */
export function optionDeltasFor(options: readonly AircraftOption[]): readonly OptionDelta[] {
  return canonical(options).map((option) => ({
    id: option.id,
    oewDeltaT: option.specDeltas.oewDeltaTonnes,
    mtowDeltaT: option.specDeltas.mtowDeltaTonnes,
    burnFactor: option.specDeltas.fuelBurnFactor,
    takeoffRunFactor: option.specDeltas.runwayRequirementFactor,
  }));
}

// ---------------------------------------------------------------------------
// Build validation
// ---------------------------------------------------------------------------

/** Why a build was refused. One code per rule in App. C.3. */
export type BuildRefusalCode =
  /** No such option in this catalogue version. */
  | 'unknown_option'
  /** The option exists and this type cannot be ordered with it (C.6 `available_options[]`). */
  | 'not_available_for_type'
  /** Two options that cannot be taken together (C.6 `option_conflicts[]`). */
  | 'conflict'
  /** §10.3 research the airline does not hold. */
  | 'research_required'
  /** Asked for as a retrofit, and C.3 rule 5 says this one cannot be. */
  | 'not_retrofittable';

export interface BuildRefusal {
  code: BuildRefusalCode;
  /** The option that caused it. */
  optionId: string;
  /** The other option, for a conflict. */
  withOptionId?: string;
  /** The research topic, for `research_required`. */
  research?: string;
  /** One sentence naming the rule, so a refusal is never a generic "unavailable". */
  detail: string;
}

export interface ValidateBuildInput {
  /** The type being configured — its designation and what it may be ordered with. */
  type: { designation: string; availableOptionIds: readonly string[] };
  /** The catalogue version's whole option set, by id. */
  catalogue: ReadonlyMap<string, AircraftOption>;
  /** What the player asked for. */
  optionIds: readonly string[];
  /** §10.3 topics the airline holds. Empty when research is not modelled yet. */
  research?: readonly string[];
  /**
   * True when these options are being added to an airframe that already exists.
   *
   * C.3 rule 5: *"Retrofit is possible but worse … and some (structural, engine
   * variant) can't be changed at all."* At order time everything on the type's
   * list is fair game.
   */
  retrofit?: boolean;
}

/**
 * Check a build against C.3's rules. Every refusal names the rule it broke.
 *
 * Returns them all rather than the first, because a configurator should be able
 * to mark every offending choice at once — the same reasoning M3-09's fare floor
 * uses when it returns a violation per cabin.
 */
export function validateBuild(input: ValidateBuildInput): readonly BuildRefusal[] {
  const { type, catalogue, optionIds, research = [], retrofit = false } = input;
  const refusals: BuildRefusal[] = [];

  const available = new Set(type.availableOptionIds);
  const held = new Set(research);
  // Deduplicated: asking for the same option twice is one choice, not a conflict
  // with itself.
  const asked = [...new Set(optionIds)];

  for (const id of asked) {
    const option = catalogue.get(id);
    if (option === undefined) {
      refusals.push({
        code: 'unknown_option',
        optionId: id,
        detail: `There is no option "${id}" in this catalogue version.`,
      });
      continue;
    }

    if (!available.has(id)) {
      refusals.push({
        code: 'not_available_for_type',
        optionId: id,
        detail: `${option.name} cannot be ordered on the ${type.designation}.`,
      });
    }

    if (retrofit && !option.retrofittable) {
      refusals.push({
        code: 'not_retrofittable',
        optionId: id,
        detail: `${option.name} is a ${option.category} change and cannot be fitted after delivery.`,
      });
    }

    for (const topic of option.requiresResearch) {
      if (!held.has(topic)) {
        refusals.push({
          code: 'research_required',
          optionId: id,
          research: topic,
          detail: `${option.name} needs the "${topic}" research topic first.`,
        });
      }
    }

    for (const other of option.conflictsWith) {
      // Reported once per pair rather than twice, by only looking forward.
      if (asked.includes(other) && id < other) {
        const otherOption = catalogue.get(other);
        refusals.push({
          code: 'conflict',
          optionId: id,
          withOptionId: other,
          detail: `${option.name} cannot be taken with ${otherOption?.name ?? other}.`,
        });
      }
    }
  }

  return refusals;
}

/**
 * Resolve ids to rows, refusing anything that fails {@link validateBuild}.
 *
 * A single entry point so no caller can fold an invalid build by forgetting to
 * validate first.
 */
export type ResolveBuildResult =
  | { ok: true; options: readonly AircraftOption[] }
  | { ok: false; refusals: readonly BuildRefusal[] };

export function resolveOptions(input: ValidateBuildInput): ResolveBuildResult {
  const refusals = validateBuild(input);
  if (refusals.length > 0) return { ok: false, refusals };

  const options: AircraftOption[] = [];
  for (const id of new Set(input.optionIds)) {
    const option = input.catalogue.get(id);
    // `validateBuild` has already refused an unknown id; this keeps the types
    // honest rather than because it can happen.
    if (option !== undefined) options.push(option);
  }
  return { ok: true, options: canonical(options) };
}
