/**
 * How many people want to fly between two cities (M3-01, App. A.2).
 *
 * The first step of Appendix A, and the input to every commercial decision in
 * the game. A.2 gives the formula outright:
 *
 * ```
 * D_base = k · (Pop_o · Wealth_o · Pop_d · Wealth_d)^α · f(distance) · Affinity_od
 * ```
 *
 * This computes it, splits the result into A.2's three passenger segments, and
 * stops there. **Live modulation is M3-02's** — season, day of week, the global
 * economy and induced demand all multiply this number afterwards, and A.2 keeps
 * them in a separate equation for the good reason that the base pool is computed
 * once at world creation while the modulation runs continuously.
 *
 * ## Why α is sub-linear, and why it matters more than it looks
 *
 * A.2 says *"α ≈ 0.4 — sub-linear, so megacity pairs don't dwarf everything"*.
 * The exponent applies to the **product** of four numbers, so at α = 0.4 a city
 * pair with ten times the population and wealth of another has roughly 2.5 times
 * the demand, not ten. Without that, London–New York would be worth more than
 * every regional route in Europe combined and there would be exactly one viable
 * strategy in the game.
 *
 * ## What is deliberately not modelled
 *
 * **Migration ties.** A.2 names them as an affinity input and they are real —
 * they are most of why VFR traffic exists on some pairs and not others. But
 * bilateral migration is data nobody here has, and inventing it from
 * geography would produce a number that looks authoritative and means nothing.
 * It arrives as an input field defaulting to zero, so the pairs where it is
 * eventually known can use it and the rest are honestly silent.
 */

import { type DemandSegment, ECONOMY_CONFIG_V1 } from '@tailfin/shared';

/** One end of a city pair — the four catchment numbers M1-03 derived, plus where it is. */
export interface DemandEndpoint {
  icaoCode: string;
  /** People in the catchment, already split between the airports of a multi-airport city. */
  population: number;
  /**
   * Normalised multipliers with a world median of 1.0, not raw quantities.
   *
   * A.2 multiplies these together, so a value only means anything relative to
   * everywhere else — which is why M1-03 normalises rather than storing GDP per
   * capita. See the note on `airport.wealth_index`.
   */
  wealthIndex: number;
  tourismIndex: number;
  businessIndex: number;
  /** ISO 3166-1 alpha-2, for the same-country and shared-language terms. */
  isoCountry: string;
  /** Primary language, ISO 639-1. Absent when it is not known. */
  language?: string;
}

/**
 * Balance numbers (invariant 3). `k` and `α` are here rather than in code
 * because M3-01 asks for exactly that, and because §22.3 wants an admin able to
 * retune an Appendix A coefficient against a snapshot without a deploy.
 */
export interface GravityConfig {
  /** The scale factor: turns the dimensionless product into daily passengers. */
  k: number;
  /** A.2's α ≈ 0.4. Sub-linear on purpose; see the note above. */
  alpha: number;

  /**
   * Below this, the train wins and there is no air market to speak of.
   *
   * A.2: *"rises from ~0 at very short distance (surface transport competes)"*.
   * 100 nm is about 185 km — Amsterdam to Brussels is 90, and nobody flies it.
   */
  surfaceCompetitionNm: number;
  /** How quickly the market builds once surface transport stops competing. */
  riseConstantNm: number;
  /** Where the distance curve peaks — medium haul, in A.2's words. */
  peakDistanceNm: number;
  /** How slowly the curve decays beyond the peak. Larger is slower. */
  longHaulDecayNm: number;

  /** How strongly tourism at the far end pulls. */
  tourismWeight: number;
  /** How strongly business links at both ends pull. */
  businessWeight: number;
  /** Bonus for a shared language. */
  languageAffinity: number;
  /** Bonus for a domestic pair — same country, and usually strong ties. */
  domesticAffinity: number;
}

/**
 * A.2's coefficients, as the world is currently tuned.
 *
 * The numbers are not here: they are a slice of `ECONOMY_CONFIG_V1` in
 * `@tailfin/shared`, which is also the row seeded into `economy_config` and the
 * payload an admin retunes without a deploy (M3-11, §22.3). `packages/sim`
 * holds no balance literal, so there is exactly one place a coefficient can be
 * changed and exactly one version number that describes it.
 *
 * This constant remains as the **default parameter** for the pure functions
 * below, so a test can size a pool without carrying a config around. The server
 * never uses it — lint forbids that, because a route running the shipped seed
 * instead of the world's pinned config is invariant 3 quietly failing.
 */
export const DEFAULT_GRAVITY: GravityConfig = ECONOMY_CONFIG_V1.demand.gravity;

/** Version tag. A demand pool has to stay explicable after a retune (invariant 4). */
export const GRAVITY_CONFIG_VERSION = 'v1' as const;

/**
 * A.2's `f(distance)`: *"rises from ~0 at very short distance, peaks at medium
 * haul, decays slowly at long haul"*.
 *
 * Three regimes in one curve, and the shape is doing real work in the game:
 *
 * - **Below 100 nm** the train wins. A quartic ramp from zero, not a soft
 *   penalty, because a 60 nm point-to-point air market does not exist.
 * - **Rising fast from there**, reaching most of its height by 400 nm. This is
 *   where the correction was needed: short-haul Europe carries several times
 *   what the North Atlantic does, and a slow rise made the opposite true.
 * - **Peaking around 700 nm**, then decaying slowly. Long haul is a smaller
 *   market per pair, not a dead one, which is what leaves room for a widebody
 *   strategy to exist at all.
 *
 * Checked against reality at the calibration anchor and either side of it:
 * Amsterdam–London 200 nm comes out near 10,000 passengers a day and
 * Amsterdam–New York 3,160 nm near 5,400, against real figures of roughly
 * 10,000 and 5,000.
 */
export function distanceFactor(
  distanceNm: number,
  config: GravityConfig = DEFAULT_GRAVITY,
): number {
  if (!Number.isFinite(distanceNm) || distanceNm < 0) {
    throw new Error(`Distance must be zero or more, got ${String(distanceNm)}`);
  }
  if (distanceNm <= config.surfaceCompetitionNm) {
    // Steeply, not linearly: at 90 nm there is essentially no point-to-point air
    // market, and a gentle ramp would leave Amsterdam–Brussels looking like a
    // route somebody should fly.
    const ramp = distanceNm / config.surfaceCompetitionNm;
    return ramp ** 4 * 0.05;
  }

  if (distanceNm <= config.peakDistanceNm) {
    // The rising limb has to be fast. The first version rose as a square root
    // towards a 1,500 nm peak, which put Amsterdam–London — one of the densest
    // pairs in Europe — at a fifth of peak demand and made transatlantic flying
    // look like the bigger market. It is not: short-haul Europe carries several
    // times what the North Atlantic does.
    return 1 - Math.exp(-(distanceNm - config.surfaceCompetitionNm) / config.riseConstantNm);
  }

  // Falling limb, slowly. At 3,000 nm this is still about a third of peak, which
  // is what "decays slowly" has to mean for a widebody strategy to exist.
  return Math.exp(-(distanceNm - config.peakDistanceNm) / config.longHaulDecayNm);
}

/** What makes a particular pair want to travel, beyond size and distance. */
export interface Affinity {
  value: number;
  /** Each contribution, so a surprising pool can be explained (§14.1). */
  components: { source: string; value: number; detail: string }[];
}

/**
 * A.2's `Affinity_od` — *"tourism pull, business links, historical/migration
 * ties (drives VFR), shared language"*.
 *
 * A multiplier around 1, not a probability. 1.0 is an unremarkable pair; a
 * sunshine destination from a wealthy northern city is well above it.
 *
 * `migrationTie` is the input A.2 asks for and nobody has data for. Zero by
 * default — see the module note.
 */
export function affinityBetween(
  origin: DemandEndpoint,
  destination: DemandEndpoint,
  migrationTie = 0,
  config: GravityConfig = DEFAULT_GRAVITY,
): Affinity {
  const components: Affinity['components'] = [];

  // Tourism is directional in reality — people fly *to* the beach — but a base
  // pool is a two-way market, so both ends' pull counts and the stronger one
  // dominates. Using only the destination's would make AMS→PMI and PMI→AMS
  // different markets, which they are not.
  const tourism = Math.max(origin.tourismIndex, destination.tourismIndex) - 1;
  if (tourism > 0) {
    const value = tourism * config.tourismWeight;
    components.push({
      source: 'tourism',
      value,
      detail: `One end draws ${tourism.toFixed(2)}× the median tourism.`,
    });
  }

  // Business links need *both* ends: a financial centre paired with a beach is a
  // leisure route, not a business one, and multiplying the two rather than
  // adding them is what encodes that.
  const business = Math.sqrt(origin.businessIndex * destination.businessIndex) - 1;
  if (business > 0) {
    const value = business * config.businessWeight;
    components.push({
      source: 'business',
      value,
      detail: `Both ends average ${(business + 1).toFixed(2)}× the median business activity.`,
    });
  }

  if (origin.isoCountry === destination.isoCountry) {
    components.push({
      source: 'domestic',
      value: config.domesticAffinity,
      detail: `Both in ${origin.isoCountry}.`,
    });
  } else if (origin.language !== undefined && origin.language === destination.language) {
    components.push({
      source: 'language',
      value: config.languageAffinity,
      detail: `Both speak ${origin.language}.`,
    });
  }

  if (migrationTie > 0) {
    components.push({
      source: 'migration',
      value: migrationTie,
      detail: 'Historical and migration ties between these countries.',
    });
  }

  return {
    value: 1 + components.reduce((sum, c) => sum + c.value, 0),
    components,
  };
}

/** A.2's three segments and their shares. Always sums to exactly 1. */
export type SegmentShares = Record<DemandSegment, number>;

/**
 * Balance numbers for the segment split.
 *
 * A.2 gives typical shares as bands rather than numbers — business 10–35%,
 * leisure 40–70%, VFR 15–30% — and says the mix *"is a property of the city
 * pair"*. These are the ends of those bands and the rules that move a pair
 * between them.
 */
export interface SegmentConfig {
  /** The mix for a pair with nothing distinctive about it. */
  base: SegmentShares;
  /** How far business activity at both ends can push the business share. */
  businessSwing: number;
  /** How far tourism at either end can push the leisure share. */
  tourismSwing: number;
  /** How much a shared language or a domestic pair pushes VFR. */
  vfrSwing: number;
  /** A.2's bands. The result is clamped into them. */
  bounds: Record<DemandSegment, readonly [number, number]>;
}

export const DEFAULT_SEGMENTS: SegmentConfig = ECONOMY_CONFIG_V1.demand.segments;

/**
 * How a pair's traffic splits between business, leisure and VFR.
 *
 * The acceptance criterion is a shape rather than a number: *"AMS–LHR is
 * business-heavy; AMS–PMI is leisure-heavy"*. Two financial centres 200 nm apart
 * and a northern city paired with a holiday island are the two ends of the range
 * this has to produce, and everything between them follows from the same two
 * indices.
 *
 * **Always sums to exactly 1**, which is the third acceptance criterion and the
 * reason for the final normalisation rather than trusting the arithmetic: the
 * shares are clamped into A.2's bands first, and clamping three numbers
 * independently does not preserve their sum.
 */
export function segmentShares(
  origin: DemandEndpoint,
  destination: DemandEndpoint,
  config: SegmentConfig = DEFAULT_SEGMENTS,
): SegmentShares {
  // Both ends, geometrically: a business route needs somewhere to fly from as
  // well as to.
  const business = Math.sqrt(origin.businessIndex * destination.businessIndex) - 1;
  // Either end, because one beach is enough to make a leisure route.
  const tourism = Math.max(origin.tourismIndex, destination.tourismIndex) - 1;
  const familiar =
    origin.isoCountry === destination.isoCountry ||
    (origin.language !== undefined && origin.language === destination.language);

  const raw: SegmentShares = {
    business: config.base.business + Math.max(0, business) * config.businessSwing,
    leisure: config.base.leisure + Math.max(0, tourism) * config.tourismSwing,
    vfr: config.base.vfr + (familiar ? config.vfrSwing : 0),
  };

  const clamped: SegmentShares = {
    business: clamp(raw.business, config.bounds.business),
    leisure: clamp(raw.leisure, config.bounds.leisure),
    vfr: clamp(raw.vfr, config.bounds.vfr),
  };

  const total = clamped.business + clamped.leisure + clamped.vfr;
  return {
    business: clamped.business / total,
    leisure: clamped.leisure / total,
    vfr: clamped.vfr / total,
  };
}

function clamp(value: number, [low, high]: readonly [number, number]): number {
  return Math.min(high, Math.max(low, value));
}

export interface DemandPool {
  originIcao: string;
  destinationIcao: string;
  distanceNm: number;
  /** Passengers a day, both directions, before any live modulation (M3-02). */
  dailyPassengers: number;
  segments: SegmentShares;
  /** Every term that produced it, so no figure is a dead end (§14.1). */
  basis: {
    massTerm: number;
    distanceFactor: number;
    affinity: Affinity;
  };
}

function assertEndpoint(endpoint: DemandEndpoint, which: string): void {
  if (!Number.isFinite(endpoint.population) || endpoint.population < 0) {
    throw new Error(`${which} population must be zero or more, got ${String(endpoint.population)}`);
  }
  for (const key of ['wealthIndex', 'tourismIndex', 'businessIndex'] as const) {
    const value = endpoint[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${which} ${key} must be positive, got ${String(value)}`);
    }
  }
}

/**
 * The base daily pool for one city pair.
 *
 * Pure, and deliberately cheap: this runs across millions of pairs at world
 * creation, so it is arithmetic and two square roots with no allocation beyond
 * the result. The 5-minute budget in M3-01 is a property of how many pairs are
 * *offered*, not of what happens to each one — filtering is the caller's job and
 * `isViablePair` is what it should filter on.
 */
export function demandPool(
  origin: DemandEndpoint,
  destination: DemandEndpoint,
  distanceNm: number,
  options: { migrationTie?: number; gravity?: GravityConfig; segments?: SegmentConfig } = {},
): DemandPool {
  const config = options.gravity ?? DEFAULT_GRAVITY;
  assertEndpoint(origin, 'Origin');
  assertEndpoint(destination, 'Destination');

  const mass =
    origin.population * origin.wealthIndex * destination.population * destination.wealthIndex;
  const massTerm = mass <= 0 ? 0 : mass ** config.alpha;

  const distance = distanceFactor(distanceNm, config);
  const affinity = affinityBetween(origin, destination, options.migrationTie ?? 0, config);

  return {
    originIcao: origin.icaoCode,
    destinationIcao: destination.icaoCode,
    distanceNm,
    dailyPassengers: config.k * massTerm * distance * affinity.value,
    segments: segmentShares(origin, destination, options.segments ?? DEFAULT_SEGMENTS),
    basis: { massTerm, distanceFactor: distance, affinity },
  };
}

/**
 * The pool below which a pair is not worth storing.
 *
 * 25 a day is about one turboprop half full, once. Below that there is no
 * service anybody would run and no market for M3-03's share model to divide
 * between competitors.
 *
 * The threshold exists because of α. A.2's sub-linear exponent is what stops
 * megacity pairs dwarfing everything, and the same compression means two tiny
 * airports still produce a non-zero pool — the model has no natural floor, so
 * one has to be chosen. With ~4,400 scheduled-service airports there are 9.7
 * million unordered pairs, and storing a row for every fractional market would
 * cost gigabytes to represent flying nobody would do.
 *
 * A balance number like any other: raise it and the world gets smaller and
 * cheaper, lower it and thin regional markets become playable.
 */
export const VIABLE_DAILY_PASSENGERS = ECONOMY_CONFIG_V1.demand.viableDailyPassengers;

/** Whether a pair is worth storing at all. See {@link VIABLE_DAILY_PASSENGERS}. */
export function isViablePair(
  pool: DemandPool,
  minimumDailyPassengers = VIABLE_DAILY_PASSENGERS,
): boolean {
  return pool.dailyPassengers >= minimumDailyPassengers;
}
