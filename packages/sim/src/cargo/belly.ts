/**
 * How much freight actually fits in the hold of a passenger flight (M8-15, §12.1).
 *
 * §12.1 gives the equation and the reason it is interesting:
 *
 * ```
 * Available belly payload = MTOW − OEW − fuel − passengers − passenger bags
 * ```
 *
 * *"Which means belly cargo is in **direct competition with your own passengers
 * and your own range**. A full cabin with full bags on a long sector leaves
 * almost no belly capacity. A widebody on a medium sector has tonnes spare."*
 * And then the demand this module exists to satisfy: *"the game should make that
 * discoverable rather than stated."*
 *
 * So this does not return a tonnage. It returns **three allowances and the name
 * of the one that bound**, which is the same contract `payload-range.ts` draws
 * for range and App. B.4 draws for reachability: a number is not a decision, and
 * *"MTOW-limited — a lighter cabin would buy you 3.1 t"* is.
 *
 * ## Three limits, all real
 *
 * - **Weight.** §12.1's equation, exactly. What is left of maximum takeoff
 *   weight once the aeroplane, its fuel, its passengers and their bags are on.
 * - **Structure.** `maxPayloadTonnes` — the floor and the frames, which do not
 *   care that the aircraft is light on fuel today. A short sector in a full
 *   narrowbody is usually stopped here rather than by MTOW, which surprises
 *   people and is correct.
 * - **Volume.** §12.6: *"Dense freight hits weight limits; e-commerce hits
 *   volume limits first. Both are real constraints."* Modelling weight alone
 *   would make e-commerce indistinguishable from general freight, which is
 *   CARGO-04's stated risk.
 *
 * ## The bags are in the hold, and that is the point
 *
 * Passenger baggage is subtracted from **both** the weight allowance and the
 * volume allowance, because it physically occupies the same compartments the
 * freight would. That is what makes §12.1's *"direct competition with your own
 * passengers"* literally true rather than a figure of speech: filling the cabin
 * costs belly capacity twice over, once in kilograms and once in cubic metres.
 *
 * Bags are never displaced by freight. They belong to passengers who have been
 * sold a seat, so they load first and the freight takes what is left.
 *
 * ## This is physics, not economy
 *
 * Every coefficient below is aircraft performance, pinned by
 * `world.aircraft_catalogue_version` (§22.5) rather than by
 * `economy_config_version` (§22.3) — the same split `payload-range.ts` and
 * `flight/fuel.ts` sit on, and `balance-source.test.ts` holds the line. What a
 * tonne *earns* is the economy's and lives in `EconomyConfig.cargo`; how many
 * kilograms fill a cubic metre is the economy's too, because the commodity mix
 * decides it. See {@link BellyCapacityInput.freightDensityKgPerM3}.
 *
 * ## What it deliberately does not model
 *
 * - **Balance.** §12.6 lists *"weight and balance and volume"*; this does weight
 *   and volume. A centre-of-gravity envelope needs per-compartment geometry the
 *   §22.5 catalogue does not carry, and CARGO-10's own text warns that load
 *   planning is where this becomes a logistics simulator. Two constraints are
 *   enough to make a decision.
 * - **Maximum zero-fuel weight.** `payload-range.ts` already names MZFW as a
 *   real fourth limit that is not in the App. C.2 catalogue. Inventing a column
 *   for it would be guessing at data M4 owns, and the structural limit above
 *   catches most of what it would.
 * - **ULDs and positioning.** CARGO-10.
 */

import {
  payloadT,
  type PayloadRangeConfig,
  DEFAULT_PAYLOAD_RANGE,
} from '../aircraft/payload-range';

/** Which limit stopped more freight going aboard. */
export type BellyLimit = 'weight' | 'structural' | 'volume';

/**
 * Tie-break order, and the order a UI should list the limits in.
 *
 * Weight first because it is the equation §12.1 states; structure next because
 * it is the one that surprises people on short sectors; volume last because it
 * is the one that only bites on the big aeroplanes. Exact ties are physically
 * uninteresting but the answer still has to be the same every time (CONTRIBUTING
 * invariant 2), and the order itself carries no judgement.
 */
export const BELLY_LIMITS: readonly BellyLimit[] = ['weight', 'structural', 'volume'];

/**
 * The hold, as a proxy until the catalogue carries one.
 *
 * App. C.2 gives no hold volume for any type, so this derives it from
 * `maxPayloadTonnes`, which is the closest thing to a size the catalogue does
 * carry. The ratio is roughly right across the fleet — a narrowbody runs near
 * 1.9 m³ per structural tonne and a large widebody near 2.9 — and a single
 * middle figure is honest about being a proxy in a way a per-type invented
 * column would not be.
 *
 * **When the catalogue gains a real `bellyVolumeM3`, this is what it replaces.**
 * CARGO-05 is the issue that would add it, because a freighter's main deck makes
 * the omission untenable; until then a passenger aeroplane's hold is estimated
 * and the estimate is named.
 */
export interface BellyGeometryConfig {
  /** Cubic metres of hold per tonne of structural payload limit. */
  bellyVolumeM3PerPayloadTonne: number;
  /**
   * How many kilograms of checked baggage fill a cubic metre.
   *
   * Lower than freight: a bag is an awkward shape with air in it, and a hold
   * full of bags weighs distinctly less than a hold full of boxes. This is what
   * makes a full cabin cost more hold *volume* than its bag weight alone
   * suggests.
   */
  bagDensityKgPerM3: number;
}

/**
 * The hold geometry as currently estimated.
 *
 * A literal, deliberately, for the reason `balance-source.test.ts` records: this
 * is §22.5 aircraft performance rather than §22.3 balance, so it is versioned
 * with the catalogue and not with the economy. `DEFAULT_PAYLOAD_RANGE` beside it
 * is a literal for the same reason.
 *
 * 2.4 m³ per structural tonne sits between the narrowbody and widebody figures
 * above. 130 kg/m³ for baggage is the round planning density that turns a
 * 180-seat narrowbody's 2.9 t of bags into about 22 m³ — over half its hold,
 * which is why a full cabin is felt in the belly at all.
 */
export const DEFAULT_BELLY_GEOMETRY: BellyGeometryConfig = {
  bellyVolumeM3PerPayloadTonne: 2.4,
  bagDensityKgPerM3: 130,
};

/** What the aeroplane brings. App. C.6's `effective_spec`, narrowed to what fits. */
export interface BellyAirframe {
  /** Certified maximum takeoff weight in tonnes, after any paper upgrade. */
  mtowTonnes: number;
  /** Operating empty weight in tonnes, cabin and options included. */
  oewTonnes: number;
  /** Structural payload limit in tonnes — the floor, not the wings. */
  maxPayloadTonnes: number;
}

export interface BellyCapacityInput {
  aircraft: BellyAirframe;
  /**
   * Passengers planned aboard, and their bags with them.
   *
   * Planned rather than booked. A load planner does not sell belly capacity it
   * may need for the seats it has already sold, so the honest input is the cabin
   * the aeroplane is *offering* — see the note on `cargo/plan.ts` in the server,
   * which passes the fitted layout until `flight.load` carries real bookings.
   */
  passengers: number;
  /**
   * Fuel aboard for this sector, in tonnes.
   *
   * Supplied, never recomputed. M2-05 owns the burn and `payload-range.ts` owns
   * what the tanks and MTOW permit; deriving a second fuel figure here is
   * exactly the two-numbers-for-one-fact dead end CONTRIBUTING invariant 4
   * exists to prevent.
   */
  fuelTonnes: number;
  /**
   * Usable belly volume as a fraction of standard — App. C.6's
   * `cargoVolumeFactor`, folded from the options actually fitted.
   *
   * This is where C.3's belly tanks stop being decorative: a long-range build
   * ends at 0.62 and a main-deck cargo door at 0.94, and both now change what
   * the aeroplane can carry. Defaults to 1, an aeroplane straight off the shelf.
   */
  cargoVolumeFactor?: number;
  /**
   * Kilograms of freight per cubic metre — `EconomyConfig.cargo`'s, because the
   * commodity mix decides it and the commodity mix is demand (§12.3).
   */
  freightDensityKgPerM3: number;
  /** Passenger and bag planning weights. Shared with the payload/range model. */
  payload?: PayloadRangeConfig;
  geometry?: BellyGeometryConfig;
}

/** What each limit would allow, in tonnes. The smallest one wins. */
export interface BellyAllowances {
  /** §12.1's equation. Negative when the aeroplane is over MTOW before any freight. */
  weight: number;
  /** Structural payload less what the passengers and their bags already use. */
  structural: number;
  /** What the hold has room for, once the bags are in it. */
  volume: number;
}

/** The hold, in cubic metres, so the volume answer can explain itself. */
export interface BellyVolume {
  /** Standard hold volume for this airframe, before options. */
  holdM3: number;
  /** After `cargoVolumeFactor` — what the build actually has. */
  usableM3: number;
  /** Taken by checked baggage, which loads first. */
  baggageM3: number;
  /** What is left for freight. Never negative. */
  freightM3: number;
}

export interface BellyCapacityResult {
  /** Tonnes of freight this flight can take. Zero, never negative. */
  availableTonnes: number;
  /** Which limit bound it. */
  limit: BellyLimit;
  /** What each limit would have allowed, so the answer explains itself. */
  allowances: BellyAllowances;
  volume: BellyVolume;
  /** Passengers and their bags, in tonnes — what the cabin costs the hold. */
  passengerPayloadTonnes: number;
  /** OEW + passengers + bags + fuel: the weight before any freight. */
  weightBeforeFreightT: number;
  /** One sentence naming the binding limit and what the runner-up would have allowed. */
  detail: string;
}

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${what} must be a finite number, got ${String(value)}`);
  }
}

function assertPositive(value: number, what: string): void {
  assertFinite(value, what);
  if (value <= 0) throw new Error(`${what} must be positive, got ${String(value)}`);
}

function assertNonNegative(value: number, what: string): void {
  assertFinite(value, what);
  if (value < 0) throw new Error(`${what} must be zero or more, got ${String(value)}`);
}

function round(value: number, places = 0): string {
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/**
 * Resolve the belly capacity of one flight.
 *
 * Pure, and supplied with its inputs — the same discipline `payload-range.ts`
 * draws: the catalogue is M4's, the cabin is M6's and the fuel is M2-05's, so
 * they arrive as arguments rather than as stubs.
 */
export function bellyCapacity(input: BellyCapacityInput): BellyCapacityResult {
  const { aircraft } = input;
  assertPositive(aircraft.mtowTonnes, 'Maximum takeoff weight');
  assertPositive(aircraft.oewTonnes, 'Operating empty weight');
  assertPositive(aircraft.maxPayloadTonnes, 'Maximum payload');
  assertNonNegative(input.passengers, 'Passenger count');
  assertNonNegative(input.fuelTonnes, 'Fuel aboard');
  assertPositive(input.freightDensityKgPerM3, 'Freight density');

  const payloadConfig = input.payload ?? DEFAULT_PAYLOAD_RANGE;
  const geometry = input.geometry ?? DEFAULT_BELLY_GEOMETRY;
  assertPositive(geometry.bellyVolumeM3PerPayloadTonne, 'Belly volume per payload tonne');
  assertPositive(geometry.bagDensityKgPerM3, 'Baggage density');

  const cargoVolumeFactor = input.cargoVolumeFactor ?? 1;
  assertPositive(cargoVolumeFactor, 'Cargo volume factor');

  // Passengers and their bags, through the payload/range model's own function so
  // the two cannot disagree about what a passenger weighs.
  const passengerPayloadTonnes = payloadT(
    { passengers: input.passengers, cargoT: 0 },
    payloadConfig,
  );
  const weightBeforeFreightT = aircraft.oewTonnes + passengerPayloadTonnes + input.fuelTonnes;

  const holdM3 = aircraft.maxPayloadTonnes * geometry.bellyVolumeM3PerPayloadTonne;
  const usableM3 = holdM3 * cargoVolumeFactor;
  const baggageTonnes = (input.passengers * payloadConfig.bagWeightKg) / 1000;
  const baggageM3 = (baggageTonnes * 1000) / geometry.bagDensityKgPerM3;
  // Clamped: a hold too small for its own aeroplane's bags has no room for
  // freight, which is the honest answer rather than a negative volume.
  const freightM3 = Math.max(0, usableM3 - baggageM3);

  const allowances: BellyAllowances = {
    weight: aircraft.mtowTonnes - weightBeforeFreightT,
    structural: aircraft.maxPayloadTonnes - passengerPayloadTonnes,
    volume: (freightM3 * input.freightDensityKgPerM3) / 1000,
  };

  // The binding limit is decided before the clamp at zero, exactly as
  // `computePayloadRange` decides its own: an aeroplane whose passengers alone
  // put it over MTOW is weight-limited, and saying so is more use than reporting
  // a three-way tie at nil freight.
  let limit: BellyLimit = 'weight';
  let allowed = allowances.weight;
  for (const candidate of BELLY_LIMITS) {
    if (allowances[candidate] < allowed) {
      limit = candidate;
      allowed = allowances[candidate];
    }
  }

  const availableTonnes = Math.max(0, allowed);

  return {
    availableTonnes,
    limit,
    allowances,
    volume: { holdM3, usableM3, baggageM3, freightM3 },
    passengerPayloadTonnes,
    weightBeforeFreightT,
    detail: explain(limit, allowances, input.passengers, availableTonnes),
  };
}

/** Half the 0.1 t step the readout prints at — below this the gap is not news. */
const SPARE_WORTH_MENTIONING_T = 0.05;

const LIMIT_NAMES: Record<BellyLimit, string> = {
  weight: 'maximum takeoff weight',
  structural: 'the structural payload limit',
  volume: 'hold volume',
};

/**
 * One sentence a player can act on.
 *
 * It names the binding limit **and the runner-up**, because the gap between them
 * is the decision. Weight-limited with 12 t of unused hold means a lighter cabin
 * or less fuel buys freight; weight-limited with the hold already full means it
 * buys nothing. The same reasoning `payload-range.ts` gives for naming its own
 * runner-up.
 */
function explain(
  limit: BellyLimit,
  allowances: BellyAllowances,
  passengers: number,
  availableTonnes: number,
): string {
  const cabin = `${round(passengers)} passenger${passengers === 1 ? '' : 's'} and their bags`;

  if (availableTonnes <= 0) {
    return (
      `${cabin} leave no belly capacity on this sector — ` +
      `${LIMIT_NAMES[limit]} is reached before any freight is loaded.`
    );
  }

  const others = BELLY_LIMITS.filter((other) => other !== limit).map((other) => ({
    name: LIMIT_NAMES[other],
    slack: allowances[other] - availableTonnes,
  }));
  // The tightest of the limits that did not bind — the one that would bind next.
  const runnerUp = others.reduce<{ name: string; slack: number } | null>(
    (tightest, candidate) =>
      tightest === null || candidate.slack < tightest.slack ? candidate : tightest,
    null,
  );

  // Suppressed below the precision the sentence prints at: two limits within a
  // few kilograms of each other are the same limit as far as a decision goes,
  // and "another 0.0 t" is worse than saying nothing.
  const spare =
    runnerUp === null || runnerUp.slack < SPARE_WORTH_MENTIONING_T
      ? ''
      : ` — ${runnerUp.name} would have taken another ${round(runnerUp.slack, 1)} t`;

  return (
    `${cabin} leave ${round(availableTonnes, 1)} t of belly capacity, ` +
    `limited by ${LIMIT_NAMES[limit]}${spare}.`
  );
}
