/**
 * What this airframe can actually do at the load you planned (M2-02, App. C.3–C.4).
 *
 * Range is not a property of a type, it is a property of a *flight*. The
 * catalogue's 4,000 nm against the A321neo is a brochure figure quoted at a
 * payload nobody states; fill every seat on a marginal sector and the aircraft
 * either leaves fuel behind or does not go. §6.4 puts the trade in one line:
 *
 *   `seats ↑ → revenue potential ↑ · comfort ↓ · weight ↑ → range ↓, fuel ↑`
 *
 * This resolves that trade and — the part that matters — **names which limit
 * bound it.** App. B.4 makes the same demand of reachability: *"The UI shows
 * exactly which one failed, never a generic 'unavailable'."* A range of 3,595 nm
 * is a number. *"MTOW-limited; the tanks would have taken another 2.7 t"* is a
 * decision: buy the paper MTOW upgrade, or leave eight passengers behind.
 *
 * ## It feeds reachability
 *
 * `rangeNm` and `takeoffRunM` are exactly what `checkReachability`'s
 * `AircraftCapability` wants for its first two checks — that interface already
 * documents them as *"at the planned payload"* and defers the trade to here.
 * Nothing downstream re-derives a range (CONTRIBUTING invariant 4).
 *
 * ## Pure, and supplied with its inputs
 *
 * Same discipline as M2-01: the aircraft catalogue is M4 and the cabin builder is
 * M6, so this takes a resolved spec, a cabin and a list of option deltas as
 * arguments rather than stubbing either. C.6 is explicit that this is the right
 * shape — `effective_spec` is *"derived from base spec plus option deltas plus
 * cabin weight"*, and *"everything downstream reads only effective_spec"*.
 *
 * ## What is deliberately not modelled
 *
 * - **Maximum zero-fuel weight.** A real fourth limit, and the one that bites a
 *   freighter. The issue names three, and MZFW is not in the App. C.2 catalogue,
 *   so inventing a column for it would be guessing at balance data M4 owns.
 * - **Belly volume.** C.3 charges auxiliary tanks *"−18% to −40% belly cargo
 *   volume"*, and C.4's long-range build gives up 38% of its hold. That is a
 *   volume constraint, not a weight one; cargo arrives here already in tonnes and
 *   §12's cargo system owns whether it physically fits.
 * - **Reserves.** The published ranges this calibrates against already carry
 *   them, so subtracting a reserve here would subtract it twice.
 */

/** Which limit stopped more fuel going aboard. */
export type PayloadRangeLimit = 'mtow' | 'fuel' | 'runway';

/**
 * Tie-break order, and the order a UI should list the limits in.
 *
 * Exact ties are rare and physically uninteresting — an airframe perfectly
 * matched to its tanks — but the answer still has to be the same every time
 * (CONTRIBUTING invariant 2). The order itself carries no judgement.
 */
export const PAYLOAD_RANGE_LIMITS: readonly PayloadRangeLimit[] = ['mtow', 'fuel', 'runway'];

/**
 * The airframe before a cabin is fitted or an option is taken.
 *
 * `emptyWeightT` is **bare**, not the manufacturer's published OEW: published
 * OEW already includes a reference cabin, and adding a cabin config on top of it
 * would count the seats twice. M4 authors this figure; the difference is the
 * furnishing weight.
 */
export interface AirframeSpec {
  /** Manufacturer's empty weight with no cabin fitted, in tonnes. */
  emptyWeightT: number;
  /** Certified maximum takeoff weight, in tonnes, before any paper upgrade. */
  maxTakeoffWeightT: number;
  /** Usable fuel in the standard tanks, in tonnes. */
  fuelCapacityT: number;
  /**
   * Tonnes of fuel per nautical mile of still-air range.
   *
   * Authored per type. Derive it from a published range with
   * {@link calibrateCruiseBurn} rather than typing a number, so the catalogue's
   * brochure figure and this stay the same fact.
   */
  cruiseBurnTPerNm: number;
  /** Takeoff run required at MTOW, sea level, ISA, in metres. */
  takeoffRunAtMtowM: number;
}

/**
 * The cabin builder's weight output (§6.1, *"weight & balance"*).
 *
 * Seat count and seat weight are separate because they move independently: a
 * lightweight package changes the second without touching the first, and
 * high-density exits change the first without touching the second.
 */
export interface CabinWeight {
  /** Installed seats. What the aircraft can be sold to, before load factor. */
  seats: number;
  /** Installed weight per seat, kilograms — seat, rails, and its share of trim. */
  seatWeightKg: number;
  /** Galleys, lavatories, IFE, crew rest and bar modules, in tonnes. */
  fittingsWeightT: number;
}

/**
 * One factory option's effect on weight and performance (C.3, C.6 `spec_deltas`).
 *
 * A list rather than a resolved total, so a build reads as the options it was
 * ordered with and a UI can attribute *"−300 nm"* to the option that caused it.
 * Every field is optional and defaults to no effect, because C.3's rule 1 is that
 * every option debits **at least one** axis, not all of them.
 *
 * Options that change *certified seat count* rather than weight — high-density
 * exits raising the ceiling — are not here. The ceiling is a cabin-builder
 * constraint (M6); what arrives here is the cabin actually fitted.
 */
export interface OptionDelta {
  /** For attribution in the readout, and for `option_conflicts[]` in C.6. */
  id: string;
  /** Auxiliary tanks and cargo doors add weight; a lightweight cabin removes it. */
  oewDeltaT?: number;
  /** The paper MTOW upgrade. C.3 rule 4: it raises landing fees for ever. */
  mtowDeltaT?: number;
  /** Auxiliary centre tanks. */
  fuelCapacityDeltaT?: number;
  /** Multiplier on cruise burn — sharklets 0.965, a higher thrust rating 1.06. */
  burnFactor?: number;
  /** Multiplier on takeoff run — a higher thrust rating buys short-field performance. */
  takeoffRunFactor?: number;
}

/** What is going on board. */
export interface PlannedLoad {
  /** Passengers actually carried, not seats fitted. */
  passengers: number;
  /** Belly freight, in tonnes (§12.1). */
  cargoT: number;
}

/**
 * Balance numbers, so they are retunable against a snapshot rather than compiled
 * in (CONTRIBUTING invariant 3, §22.3).
 */
export interface PayloadRangeConfig {
  /** Planning weight per passenger including carry-on, kilograms. */
  passengerWeightKg: number;
  /** Planning weight of checked baggage per passenger, kilograms. */
  bagWeightKg: number;
  /**
   * How takeoff run grows with takeoff weight.
   *
   * Takeoff distance rises roughly with the square of weight — a heavier
   * aircraft needs more speed to fly *and* accelerates to it more slowly, and
   * the two compound. 2 stands in for a real performance chart, and it is the
   * exponent that gets retuned when one exists.
   */
  takeoffWeightExponent: number;
}

/**
 * 84 kg and 16 kg are the round planning figures airlines use for an adult with
 * carry-on and one checked bag; together they give the 100 kg per passenger that
 * makes a 200-seat narrowbody a 20 t payload.
 */
export const DEFAULT_PAYLOAD_RANGE: PayloadRangeConfig = {
  passengerWeightKg: 84,
  bagWeightKg: 16,
  takeoffWeightExponent: 2,
};

/** How much fuel each limit would permit, in tonnes. The smallest one wins. */
export interface FuelAllowances {
  /** Maximum takeoff weight less the zero-fuel weight. Negative if the load alone is over. */
  mtow: number;
  /** Tank capacity, including any auxiliary tanks. */
  fuel: number;
  /** What the runway permits, or null when no runway was supplied. */
  runway: number | null;
}

export interface PayloadRangeResult {
  /** Bare airframe + cabin + option deltas, in tonnes. */
  operatingEmptyWeightT: number;
  /** Passengers, their bags, and freight, in tonnes. */
  payloadT: number;
  /** OEW + payload. */
  zeroFuelWeightT: number;
  /** Fuel loadable at this payload. Zero when the load alone is already over a limit. */
  fuelT: number;
  /** Zero-fuel weight + fuel. */
  takeoffWeightT: number;
  /** Still-air range at this load, in nautical miles. */
  rangeNm: number;
  /** Takeoff run required at this weight, sea level, ISA — feeds `checkReachability`. */
  takeoffRunM: number;
  /** Effective MTOW after option deltas. Landing fees are charged against this (C.3 rule 4). */
  maxTakeoffWeightT: number;
  /** Which limit bound the fuel load. */
  limit: PayloadRangeLimit;
  /** What each limit would have allowed, so the answer explains itself. */
  allowances: FuelAllowances;
  /** One sentence naming the binding limit and what it cost. */
  detail: string;
}

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${what} must be a finite number, got ${String(value)}`);
  }
}

function assertPositive(value: number, what: string): void {
  assertFinite(value, what);
  if (value <= 0) {
    throw new Error(`${what} must be positive, got ${String(value)}`);
  }
}

function assertNonNegative(value: number, what: string): void {
  assertFinite(value, what);
  if (value < 0) {
    throw new Error(`${what} must be zero or more, got ${String(value)}`);
  }
}

function round(value: number, places = 0): string {
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/** Cabin furnishing weight in tonnes. */
export function cabinWeightT(cabin: CabinWeight): number {
  assertNonNegative(cabin.seats, 'Seat count');
  assertNonNegative(cabin.seatWeightKg, 'Seat weight');
  assertNonNegative(cabin.fittingsWeightT, 'Fittings weight');
  return (cabin.seats * cabin.seatWeightKg) / 1000 + cabin.fittingsWeightT;
}

/**
 * The spec after the cabin and the options have had their say — C.6's
 * `effective_spec`, minus the fields no downstream system reads yet.
 */
export interface EffectiveSpec {
  operatingEmptyWeightT: number;
  maxTakeoffWeightT: number;
  fuelCapacityT: number;
  cruiseBurnTPerNm: number;
  takeoffRunAtMtowM: number;
}

/**
 * Fold the base spec, the cabin and every option into one effective spec.
 *
 * Weights and capacities add; burn and takeoff run multiply. That is not
 * cosmetic — two options each cutting burn 3.5% should compound to 6.9%, not
 * 7%, and two 2 t weight penalties are 4 t rather than 4.08 t.
 */
export function effectiveSpec(
  spec: AirframeSpec,
  cabin: CabinWeight,
  options: readonly OptionDelta[] = [],
): EffectiveSpec {
  assertNonNegative(spec.emptyWeightT, 'Empty weight');
  assertPositive(spec.maxTakeoffWeightT, 'Maximum takeoff weight');
  assertPositive(spec.fuelCapacityT, 'Fuel capacity');
  assertPositive(spec.cruiseBurnTPerNm, 'Cruise burn');
  assertPositive(spec.takeoffRunAtMtowM, 'Takeoff run at MTOW');

  let oewT = spec.emptyWeightT + cabinWeightT(cabin);
  let maxTakeoffWeightT = spec.maxTakeoffWeightT;
  let fuelCapacityT = spec.fuelCapacityT;
  let cruiseBurnTPerNm = spec.cruiseBurnTPerNm;
  let takeoffRunAtMtowM = spec.takeoffRunAtMtowM;

  for (const option of options) {
    oewT += option.oewDeltaT ?? 0;
    maxTakeoffWeightT += option.mtowDeltaT ?? 0;
    fuelCapacityT += option.fuelCapacityDeltaT ?? 0;
    cruiseBurnTPerNm *= option.burnFactor ?? 1;
    takeoffRunAtMtowM *= option.takeoffRunFactor ?? 1;
  }

  if (oewT <= 0) {
    throw new Error(`Options left a non-positive operating empty weight of ${String(oewT)} t`);
  }
  return {
    operatingEmptyWeightT: oewT,
    maxTakeoffWeightT,
    fuelCapacityT,
    cruiseBurnTPerNm,
    takeoffRunAtMtowM,
  };
}

/**
 * The takeoff weight a given length of runway permits.
 *
 * The inverse of the weight-to-distance relation in `PayloadRangeConfig`, and it
 * is deliberately **not clamped to MTOW**: a runway that would allow 120 t under
 * a 97 t airframe should report 120 t, so the result can say the runway was not
 * what stopped you.
 *
 * `runwayAvailableM` is the takeoff distance available **after** any elevation or
 * temperature correction. `checkReachability` owns that correction — it holds
 * `takeoffPerThousandFeet` — and applying it in both places would charge for
 * thin air twice.
 */
export function runwayLimitedTakeoffWeightT(
  spec: Pick<EffectiveSpec, 'maxTakeoffWeightT' | 'takeoffRunAtMtowM'>,
  runwayAvailableM: number,
  config: PayloadRangeConfig = DEFAULT_PAYLOAD_RANGE,
): number {
  assertNonNegative(runwayAvailableM, 'Runway available');
  assertPositive(config.takeoffWeightExponent, 'Takeoff weight exponent');
  return (
    spec.maxTakeoffWeightT *
    (runwayAvailableM / spec.takeoffRunAtMtowM) ** (1 / config.takeoffWeightExponent)
  );
}

/** Payload in tonnes: passengers, their bags, and freight. */
export function payloadT(
  load: PlannedLoad,
  config: PayloadRangeConfig = DEFAULT_PAYLOAD_RANGE,
): number {
  assertNonNegative(load.passengers, 'Passenger count');
  assertNonNegative(load.cargoT, 'Cargo weight');
  assertNonNegative(config.passengerWeightKg, 'Passenger weight');
  assertNonNegative(config.bagWeightKg, 'Bag weight');
  return (load.passengers * (config.passengerWeightKg + config.bagWeightKg)) / 1000 + load.cargoT;
}

/**
 * Resolve the payload/range trade for one flight.
 *
 * `runwayAvailableM` is optional because most of the time the runway is not the
 * question — a network planner asking *"how far does this reach fully loaded?"*
 * has no departure field in mind yet. Omit it and the runway cannot bind.
 */
export function computePayloadRange(
  spec: AirframeSpec,
  cabin: CabinWeight,
  options: readonly OptionDelta[],
  load: PlannedLoad,
  runwayAvailableM: number | null = null,
  config: PayloadRangeConfig = DEFAULT_PAYLOAD_RANGE,
): PayloadRangeResult {
  const effective = effectiveSpec(spec, cabin, options);
  const payload = payloadT(load, config);
  const zeroFuelWeightT = effective.operatingEmptyWeightT + payload;

  const allowances: FuelAllowances = {
    mtow: effective.maxTakeoffWeightT - zeroFuelWeightT,
    fuel: effective.fuelCapacityT,
    runway:
      runwayAvailableM === null
        ? null
        : runwayLimitedTakeoffWeightT(effective, runwayAvailableM, config) - zeroFuelWeightT,
  };

  // The binding limit is the smallest allowance, decided before the clamp at
  // zero: an aircraft whose payload alone is over MTOW is MTOW-limited, and
  // saying so is more use than reporting a tie at nil fuel.
  let limit: PayloadRangeLimit = 'mtow';
  let allowed = allowances.mtow;
  for (const candidate of PAYLOAD_RANGE_LIMITS) {
    const value = allowances[candidate];
    if (value !== null && value < allowed) {
      limit = candidate;
      allowed = value;
    }
  }

  const fuelT = Math.max(0, allowed);
  const takeoffWeightT = zeroFuelWeightT + fuelT;
  const rangeNm = fuelT / effective.cruiseBurnTPerNm;
  const takeoffRunM =
    effective.takeoffRunAtMtowM *
    (takeoffWeightT / effective.maxTakeoffWeightT) ** config.takeoffWeightExponent;

  return {
    operatingEmptyWeightT: effective.operatingEmptyWeightT,
    payloadT: payload,
    zeroFuelWeightT,
    fuelT,
    takeoffWeightT,
    rangeNm,
    takeoffRunM,
    maxTakeoffWeightT: effective.maxTakeoffWeightT,
    limit,
    allowances,
    detail: explain(limit, allowances, load, payload, fuelT, rangeNm),
  };
}

/** Half the 0.1 t step the readout rounds to — below this, the gap is not news. */
const SPARE_FUEL_WORTH_MENTIONING_T = 0.05;

const LIMIT_NAMES: Record<PayloadRangeLimit, string> = {
  mtow: 'maximum takeoff weight',
  fuel: 'tank capacity',
  runway: 'the runway',
};

/**
 * One sentence a player can act on.
 *
 * It names the binding limit *and the runner-up*, because the gap between them
 * is the whole decision: 2.7 t of unused tank behind an MTOW limit means the
 * paper upgrade buys range, while an MTOW limit with the tanks already full
 * means it buys nothing.
 */
function explain(
  limit: PayloadRangeLimit,
  allowances: FuelAllowances,
  load: PlannedLoad,
  payload: number,
  fuelT: number,
  rangeNm: number,
): string {
  const carried =
    `${round(load.passengers)} passengers` +
    (load.cargoT > 0 ? ` and ${round(load.cargoT, 1)} t of cargo` : '') +
    ` weigh ${round(payload, 1)} t`;

  if (fuelT <= 0) {
    return `${carried}, which is already over ${LIMIT_NAMES[limit]} before any fuel is loaded.`;
  }

  const others = PAYLOAD_RANGE_LIMITS.filter((other) => other !== limit).flatMap((other) => {
    const value = allowances[other];
    return value === null ? [] : [{ name: LIMIT_NAMES[other], slack: value - fuelT }];
  });
  // The tightest of the limits that did not bind — the one that would bind next.
  const runnerUp = others.reduce<{ name: string; slack: number } | null>(
    (tightest, candidate) =>
      tightest === null || candidate.slack < tightest.slack ? candidate : tightest,
    null,
  );

  // Suppressed below the precision the sentence prints at. Two limits that bind
  // within a few kilograms of each other are the same limit as far as a decision
  // goes, and "would have taken another 0.0 t" is worse than saying nothing.
  const spare =
    runnerUp === null || runnerUp.slack < SPARE_FUEL_WORTH_MENTIONING_T
      ? ''
      : ` — ${runnerUp.name} would have taken another ${round(runnerUp.slack, 1)} t`;

  return (
    `${carried}, leaving ${round(fuelT, 1)} t of fuel for ${round(rangeNm)} nm, ` +
    `limited by ${LIMIT_NAMES[limit]}${spare}.`
  );
}

/**
 * Solve for the cruise burn that reproduces a published range.
 *
 * App. C.2 gives ranges, not fuel flows, and typing both into the catalogue
 * would create two numbers that can disagree — the dead end CONTRIBUTING
 * invariant 4 exists to prevent. This is how M4 should author
 * `cruiseBurnTPerNm`: state the brochure range and the payload it is quoted at,
 * and let the arithmetic close.
 *
 * It works because **fuel loaded does not depend on burn** — it falls out of
 * weights and tank volume alone — so the burn can be recovered by division.
 */
export function calibrateCruiseBurn(
  spec: Omit<AirframeSpec, 'cruiseBurnTPerNm'>,
  cabin: CabinWeight,
  options: readonly OptionDelta[],
  load: PlannedLoad,
  publishedRangeNm: number,
  config: PayloadRangeConfig = DEFAULT_PAYLOAD_RANGE,
): number {
  assertPositive(publishedRangeNm, 'Published range');
  // Any positive placeholder does: it scales `rangeNm`, which is discarded, and
  // has no effect on the fuel figure this reads.
  const probe = computePayloadRange(
    { ...spec, cruiseBurnTPerNm: 1 },
    cabin,
    options,
    load,
    null,
    config,
  );
  if (probe.fuelT <= 0) {
    throw new Error(
      `Cannot calibrate burn: this build carries no fuel at the published payload (${probe.detail})`,
    );
  }
  return probe.fuelT / publishedRangeNm;
}
