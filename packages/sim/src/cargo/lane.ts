/**
 * What a lane pays for a tonne, and which way round (M8-15, §12.2).
 *
 * §12.2's first sentence is the whole design: *"Cargo demand does **not** follow
 * passenger demand. It follows **trade**, and that changes everything about how
 * routes are chosen."* Two consequences this module implements:
 *
 * - **Manufacturing → consumption.** *"Cargo pools are driven by industrial
 *   output, port proximity, and trade balance, not by tourism or population."*
 * - **Directionally imbalanced, severely.** *"Asia→Europe headhaul runs full at
 *   high yield; the backhaul runs half-empty at a fraction of the rate. Cargo
 *   route profitability must be evaluated as a round trip, never per leg — this
 *   is the single most common real-world mistake and it should be a real trap in
 *   the game."*
 *
 * ## Why a function and not a pool
 *
 * The 2026-09-07 cargo decision (#1087) confirmed M8-15's independence and drew
 * one line around it: belly cargo *"needs the payload arithmetic and
 * `cargoVolumeFactor`, not the freight domain"*, and *"the one thing it must not
 * do is invent a cargo demand pool — CARGO-03 owns that"*.
 *
 * So there is no table here. This is a **pure function over airport attributes
 * the world already has**, and it is enough for the belly channel precisely
 * because belly freight is opportunistic: the aeroplane was going anyway, so the
 * question is only what the hold is worth on that lane, in that direction. A
 * freight *network* — a pool that depletes, a commodity mix, Q4 seasonality,
 * cargo's own airports — is a different question and a different issue.
 *
 * **What CARGO-03 replaces, exactly:** {@link cargoLane}'s `offeredTonnes`, and
 * nothing else. The direction, the yield asymmetry and the whole capacity model
 * in `belly.ts` stay as they are.
 *
 * ## The trade proxy, and its honest limits
 *
 * §12.2 asks for industrial output, port proximity and trade balance. The
 * `airport` table carries `catchment_population`, `wealth_index`,
 * `tourism_index`, `business_index` and `connectivity_index` (M1-03) — so:
 *
 * - **`business_index` stands in for industrial and commercial output** at the
 *   sending end. It is A.2's *"business links"* multiplier, normalised to a world
 *   median of 1.0, and it is the only production-shaped number the world has.
 * - **`wealth_index` stands in for consumption** at the receiving end.
 * - **`tourism_index` is deliberately unused.** §12.2 says freight does not
 *   follow tourism, and reading it here would make Palma a freight hub.
 *
 * Direction falls out of that asymmetry rather than being asserted: a lane from a
 * high-output, lower-wealth airport to a high-wealth one is heavier outbound than
 * inbound, which is exactly the Asia→Europe shape §12.2 names, reached without a
 * table of trade partners.
 *
 * **Port proximity is not modelled** — no column expresses it — and what that
 * omission costs is understated sea-freight competition on the densest ocean
 * lanes. Named rather than hidden, because CARGO-03 is where it would be fixed.
 *
 * ## Two quantities, computed differently on purpose
 *
 * **Magnitude** — how much freight a lane has — is sub-linear in the size of its
 * ends, for the reason A.2's α is: doubling both ends does not double the trade.
 *
 * **Imbalance** — which way it leans — is taken from the raw index ratio,
 * *before* that exponent. Applying the exponent to the direction as well was the
 * first attempt and it was wrong: it crushed a genuine 1.9× trade asymmetry into
 * 1.3×, and §12.2's *"severely"* survived as a rounding error. The exponent
 * exists to keep magnitudes sane, not to flatten direction.
 *
 * A consequence worth knowing, because it falls out rather than being designed:
 * the populations **cancel** in the imbalance ratio, so lopsidedness is a
 * property of the *character* of the two ends and not of their size. A small
 * factory town shipping to a wealthy city is exactly as imbalanced a lane as a
 * large one — which is right, and is why the ratio is stated as indices only.
 */

import { ECONOMY_CONFIG_V1, type CargoBalance } from '@tailfin/shared';

import { majorFromMinor } from '../economy/money';

/**
 * One end of a lane, as `airport` holds it.
 *
 * Nulls are real and common: `catchment_population` and the indices are NULL for
 * every airport with no scheduled service, by the same rule as `tier`. A lane
 * touching one is not an error — it is a lane with nothing known about its trade,
 * and {@link cargoLane} answers with the neutral case rather than throwing.
 */
export interface CargoLaneEndpoint {
  /** People in the catchment, already split between a metro's airports (M1-03). */
  catchmentPopulation: number | null;
  /** A.2's business-links multiplier, world median 1.0. Stands in for output. */
  businessIndex: number | null;
  /** A.2's wealth multiplier, world median 1.0. Stands in for consumption. */
  wealthIndex: number | null;
}

/** Which way round this lane runs. */
export type CargoDirection = 'headhaul' | 'backhaul' | 'balanced';

/** The economy half of §12: what a tonne earns, and how much there is of it. */
export interface CargoLaneConfig {
  baseRatePerTonneMinor: number;
  distanceRateExponent: number;
  referenceDistanceNm: number;
  headhaulPremium: number;
  backhaulDiscount: number;
  imbalanceCap: number;
  offeredTonnesK: number;
  tradeMassExponent: number;
}

/**
 * §12's cargo coefficients, as the world is currently tuned.
 *
 * The numbers are not here: this is a slice of `ECONOMY_CONFIG_V1` in
 * `@tailfin/shared`, which is also the row seeded into `economy_config` and the
 * payload an admin retunes without a deploy (M3-11, §22.3). `packages/sim` holds
 * no balance literal, so there is exactly one place a cargo coefficient can be
 * changed and exactly one version number that describes it.
 *
 * The default parameter for the pure functions below, so a test can price a lane
 * without carrying a config around. The server never uses it — lint forbids that,
 * because a flight billed against the shipped seed instead of its world's pinned
 * config is invariant 3 quietly failing.
 */
export const DEFAULT_CARGO: CargoBalance = ECONOMY_CONFIG_V1.cargo;

/**
 * Version tag, mirroring `SETTLEMENT_CONFIG_VERSION`.
 *
 * A settled flight's cargo revenue has to stay explicable after a retune
 * (invariant 4). `flight_result.settlement_version` already records the economy
 * version that billed it, and this is the tag that says which cargo model those
 * coefficients were fed to.
 */
export const CARGO_CONFIG_VERSION = 'v1' as const;

export interface CargoLane {
  /** Whether this direction is the heavy one, the light one, or neither. */
  direction: CargoDirection;
  /** Trade mass this way — the magnitude the tonnage is scaled from. */
  tradeMass: number;
  /** Trade mass the other way. */
  reverseTradeMass: number;
  /**
   * How lopsided the lane is: heavy direction ÷ light direction, at least 1.
   *
   * Uncapped, so a player sees the real asymmetry; `imbalanceCap` bounds only
   * what it is *paid* for. Always stated as ≥ 1 whichever way you are flying, so
   * comparing the two legs of a rotation shows one imbalance figure rather than a
   * number and its reciprocal.
   */
  imbalance: number;
  /** What a tonne earns in this direction, minor units. */
  ratePerTonneMinor: number;
  /** What a tonne earns flying back, so the round trip can be priced (§12.2). */
  reverseRatePerTonneMinor: number;
  /** Tonnes this lane offers one flight in this direction. */
  offeredTonnes: number;
  /** One sentence: the direction, the imbalance, and the round-trip warning. */
  detail: string;
}

function positiveOr(value: number | null, fallback: number): number {
  return value !== null && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The neutral index for an airport that has none.
 *
 * 1.0 rather than 0: the indices are *multipliers* with a world median of 1.0, so
 * the neutral value is the median and not the absence of a market. Zero would
 * make every lane touching an unclassified field worth nothing, which reads as a
 * broken lane rather than an unknown one.
 */
const NEUTRAL_INDEX = 1;

/**
 * The catchment a lane end with no figure is assumed to have.
 *
 * Small on purpose. An airport with no scheduled service has no catchment row
 * because it has no market to size, so assuming a median metro would invent
 * freight where there is none.
 */
const UNKNOWN_CATCHMENT = 50_000;

/** Below this the two directions are the same lane, and saying otherwise is noise. */
const IMBALANCE_WORTH_MENTIONING = 1.05;

/**
 * Trade mass in one direction: output at the sender, consumption at the receiver.
 *
 * Deliberately the same *shape* as A.2's gravity numerator — a product of both
 * ends' size and quality, raised to a sub-linear exponent — and deliberately not
 * the same *terms*. Passenger demand multiplies population, wealth and tourism
 * symmetrically because a trip has two ends that both want it. Freight does not:
 * a shipment has a producer and a buyer, and swapping them is a different
 * shipment.
 *
 * Divided by a million so an ordinary pair lands near 0.1 rather than near
 * 100,000, which keeps `offeredTonnesK` a two-digit number a person can reason
 * about.
 */
function tradeMassOf(from: CargoLaneEndpoint, to: CargoLaneEndpoint, exponent: number): number {
  const output =
    positiveOr(from.catchmentPopulation, UNKNOWN_CATCHMENT) *
    positiveOr(from.businessIndex, NEUTRAL_INDEX);
  const consumption =
    positiveOr(to.catchmentPopulation, UNKNOWN_CATCHMENT) *
    positiveOr(to.wealthIndex, NEUTRAL_INDEX);
  return (output * consumption) ** exponent / 1_000_000;
}

/**
 * How lopsided the lane is, before any exponent — see the module note.
 *
 * `(output_o × consumption_d) / (output_d × consumption_o)`, which reduces to the
 * indices alone because the populations appear on both sides. Greater than 1
 * means the given direction is the headhaul.
 */
function directionalRatio(origin: CargoLaneEndpoint, destination: CargoLaneEndpoint): number {
  const out =
    positiveOr(origin.businessIndex, NEUTRAL_INDEX) *
    positiveOr(destination.wealthIndex, NEUTRAL_INDEX);
  const back =
    positiveOr(destination.businessIndex, NEUTRAL_INDEX) *
    positiveOr(origin.wealthIndex, NEUTRAL_INDEX);
  return out / back;
}

function assertConfig(config: CargoLaneConfig): void {
  if (!Number.isFinite(config.baseRatePerTonneMinor) || config.baseRatePerTonneMinor < 0) {
    throw new Error(
      `Base cargo rate must be zero or more, got ${String(config.baseRatePerTonneMinor)}`,
    );
  }
  if (!(config.imbalanceCap > 1)) {
    throw new Error(`Imbalance cap must exceed 1, got ${String(config.imbalanceCap)}`);
  }
  if (!(config.referenceDistanceNm > 0)) {
    throw new Error(
      `Reference distance must be positive, got ${String(config.referenceDistanceNm)}`,
    );
  }
  if (!Number.isFinite(config.offeredTonnesK) || config.offeredTonnesK < 0) {
    throw new Error(
      `Offered tonnage scale must be zero or more, got ${String(config.offeredTonnesK)}`,
    );
  }
}

function round(value: number, places = 0): string {
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/**
 * Price and size one direction of a lane.
 *
 * `origin` and `destination` are the direction being flown, and the answer is
 * asymmetric — that is the entire point. Call it twice for a round trip, or read
 * `reverseRatePerTonneMinor` from either call, which is the same number.
 *
 * `distanceNm` is the great-circle distance, from `haversineNm`. It is the same
 * both ways, so only the direction terms differ between the two calls.
 */
export function cargoLane(
  origin: CargoLaneEndpoint,
  destination: CargoLaneEndpoint,
  distanceNm: number,
  config: CargoLaneConfig = DEFAULT_CARGO,
): CargoLane {
  assertConfig(config);
  if (!Number.isFinite(distanceNm) || distanceNm < 0) {
    throw new Error(`Sector distance must be zero or more, got ${String(distanceNm)}`);
  }

  const tradeMass = tradeMassOf(origin, destination, config.tradeMassExponent);
  const reverseTradeMass = tradeMassOf(destination, origin, config.tradeMassExponent);

  const ratio = directionalRatio(origin, destination);
  // Stated as ≥ 1 whichever way round it is, so the two legs of a rotation agree
  // about how lopsided their lane is.
  const imbalance = ratio >= 1 ? ratio : 1 / ratio;

  const direction: CargoDirection =
    imbalance < IMBALANCE_WORTH_MENTIONING ? 'balanced' : ratio > 1 ? 'headhaul' : 'backhaul';

  // How far along the way to "fully imbalanced" this lane is, in [0, 1]. Linear
  // in the *ratio* rather than in its logarithm, because the cap is close enough
  // to 1 that the difference is cosmetic and a ratio is what a player can check.
  const tilt = Math.min(1, Math.max(0, (imbalance - 1) / (config.imbalanceCap - 1)));

  const distanceFactor =
    (Math.max(distanceNm, 0) / config.referenceDistanceNm) ** config.distanceRateExponent;
  const balancedRate = config.baseRatePerTonneMinor * distanceFactor;

  const heavyRate = Math.round(balancedRate * (1 + config.headhaulPremium * tilt));
  const lightRate = Math.round(balancedRate * (1 - config.backhaulDiscount * tilt));

  // A balanced lane has `tilt` at 0, so both rates are the base rate and it does
  // not matter which branch it takes.
  const flyingTheHeadhaul = direction !== 'backhaul';

  return {
    direction,
    tradeMass,
    reverseTradeMass,
    imbalance,
    ratePerTonneMinor: flyingTheHeadhaul ? heavyRate : lightRate,
    reverseRatePerTonneMinor: flyingTheHeadhaul ? lightRate : heavyRate,
    offeredTonnes: Math.max(0, config.offeredTonnesK * tradeMass),
    detail: explain(
      direction,
      imbalance,
      flyingTheHeadhaul ? heavyRate : lightRate,
      flyingTheHeadhaul ? lightRate : heavyRate,
    ),
  };
}

function explain(
  direction: CargoDirection,
  imbalance: number,
  rate: number,
  reverseRate: number,
): string {
  if (direction === 'balanced') {
    return 'Trade runs about evenly both ways on this lane, so each leg earns the same rate.';
  }

  const ratio = `${round(imbalance, 1)}×`;
  // §12.2's trap, stated as the thing to do about it rather than as a warning. A
  // player who reads only the leg in front of them is the mistake this exists to
  // make visible, so both numbers are always in the sentence.
  const roundTrip =
    `Price the round trip, not the leg: ${round(majorFromMinor(rate))} out against ` +
    `${round(majorFromMinor(reverseRate))} back, a tonne.`;

  return direction === 'headhaul'
    ? `Headhaul — ${ratio} more trade moves this way than back. ${roundTrip}`
    : `Backhaul — ${ratio} more trade moves the other way. ${roundTrip}`;
}
