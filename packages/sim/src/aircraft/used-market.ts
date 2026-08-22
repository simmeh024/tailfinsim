/**
 * The used aircraft market — App. C.5 (M4-05).
 *
 * Two things live here, and they are deliberately separate: **what an airframe
 * is worth**, and **which airframes the world is offering**. The first is a
 * fold over facts and is the interesting half; the second is a seeded draw.
 *
 * ## What the design document actually says
 *
 * C.5 is four sentences and no arithmetic. It says a common configuration sells
 * fast at a good price; an unusual one is cheap to buy and hard to sell; buying
 * used means buying someone else's decisions; and — the line that explains why
 * the whole options system exists — that this *"makes every airframe an
 * individual object with a history, rather than an interchangeable unit of
 * capacity."*
 *
 * §24 then lists **"used-aircraft supply and depreciation model"** under *needed
 * before launch, not before MVP*. So there is no curve to quote. Every
 * coefficient here is authored, lives in `EconomyConfig.usedMarket`, and is
 * retuned by an `INSERT` and a re-pin rather than by editing this file. Nothing
 * in this module holds a balance number.
 *
 * ## Why options do not add to a used price
 *
 * The obvious model is `new value = list + options`, then depreciate. It is
 * wrong here, and rejecting it is the central decision in this file.
 *
 * Under that model an unusual airframe can price *above* a plain one of the same
 * age, because the options it carries cost real money new. That directly
 * contradicts C.5 — *"an unusual one is **cheap to buy**"* — and it would make
 * M4-05's acceptance criterion a matter of luck in the coefficients rather than
 * a property of the model.
 *
 * So the anchor is the **type's** new-equivalent value, and configuration only
 * ever multiplies it. The previous owner's invoice is sunk and the market never
 * sees it; what the market prices is the aeroplane in front of it. An unusual
 * configuration is therefore cheaper than a common one of the same age *by
 * construction*, for every type, at every age — and a universally-desirable
 * option can still command a premium, because its drag is negative.
 *
 * ## Determinism
 *
 * A listing is identified by `(world seed, slot, generation)` and nothing else.
 * `random.ts` warns against keying a stream on *when it was asked for*, and this
 * does not: a generation index is part of a listing's identity — *the aircraft
 * standing in berth 3 in game-week 42* — not the moment somebody looked. Ask
 * twice, get the same aeroplane; replay the world six months later, get the same
 * aeroplane; run two workers, get the same aeroplane.
 */

import {
  type AircraftClass,
  type AircraftEraDates,
  type AircraftOption,
  type AircraftSpec,
  type AircraftOptionCategory,
  type EconomyConfig,
  ECONOMY_CONFIG_V1,
} from '@tailfin/shared';

import { deriveRng, gaussian, intBetween, weightedPick, type Rng } from '../random';

import { availabilityOf } from './availability';
import { computeEffectiveSpec, resolveOptions } from './effective-spec';

export type UsedMarketBalance = EconomyConfig['usedMarket'];

/** The shipped slice, for tests and for callers without a world in hand. */
export const DEFAULT_USED_MARKET: UsedMarketBalance = ECONOMY_CONFIG_V1.usedMarket;

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

// ---------------------------------------------------------------------------
// The anchor: what one of these cost new
// ---------------------------------------------------------------------------

/** Where the new-equivalent value came from, so a price can say so. */
export type AnchorSource = 'list_price' | 'capitalised_lease';

export interface ValueAnchor {
  minor: number;
  source: AnchorSource;
}

export interface AnchorInput {
  listPriceMinor: number | null;
  monthlyLeaseRateMinor: number | null;
}

/**
 * The new-equivalent value of a type.
 *
 * A type out of production has no list price — C.2 prints *"—"* and the column
 * is genuinely null, because there is no factory left to quote one. The used
 * market still has to value it, so the lease rate is capitalised instead. Three
 * v1 types take that path: the 737-800, the A380-800 and the 747-8F.
 *
 * Returns `null` when the catalogue gives neither, which nothing in v1 does but
 * a future catalogue could. A type nobody can value is not listed, rather than
 * listed at zero.
 */
export function newEquivalentValue(
  type: AnchorInput,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): ValueAnchor | null {
  if (type.listPriceMinor !== null && type.listPriceMinor > 0) {
    return { minor: type.listPriceMinor, source: 'list_price' };
  }
  if (type.monthlyLeaseRateMinor !== null && type.monthlyLeaseRateMinor > 0) {
    return {
      minor: Math.round(type.monthlyLeaseRateMinor * balance.leaseCapitalisationMonths),
      source: 'capitalised_lease',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/** Years between two game-time instants. Fractional, and never negative. */
export function ageYearsBetween(builtAt: Date, at: Date): number {
  const ms = at.getTime() - builtAt.getTime();
  return ms <= 0 ? 0 : ms / (MS_PER_DAY * DAYS_PER_YEAR);
}

/**
 * The share of value an airframe of this age retains.
 *
 * Declining balance over a **salvage residual**, not a clamped one:
 *
 * ```
 *   floor + (1 - floor) · retention ^ age
 * ```
 *
 * `1` at age zero, strictly decreasing for ever, approaching the residual and
 * never reaching it. That last property is the whole reason for this shape, and
 * the first version got it wrong.
 *
 * `max(floor, retention ** age)` looks equivalent and is not: it goes **flat**
 * past the age where the curve crosses the floor. Everything beyond that age
 * then prices identically, so hours and configuration stop mattering — and they
 * stop mattering precisely at the cheap, old, interesting end of the market
 * where a bargain is supposed to be found. M4-05's own acceptance criterion
 * would have held at eight years and quietly failed at twenty-four.
 */
export function ageFactor(
  ageYears: number,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): number {
  const { annualRetentionRate, residualFloorRatio } = balance.depreciation;
  const depreciable = 1 - residualFloorRatio;
  return residualFloorRatio + depreciable * annualRetentionRate ** Math.max(0, ageYears);
}

// ---------------------------------------------------------------------------
// Utilisation
// ---------------------------------------------------------------------------

/** Block hours an averagely-worked airframe of this class and age would show. */
export function expectedHours(
  ageYears: number,
  aircraftClass: AircraftClass,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): number {
  return Math.max(0, ageYears) * balance.depreciation.expectedAnnualHours[aircraftClass];
}

/** Cycles an airframe of this class would have accumulated over these hours. */
export function cyclesForHours(
  hours: number,
  aircraftClass: AircraftClass,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): number {
  const perCycle = balance.depreciation.averageBlockHoursPerCycle[aircraftClass];
  return Math.max(0, Math.round(hours / perCycle));
}

/**
 * What this airframe's hours say, over and above its age.
 *
 * Measured against what the age already predicted, because age and hours are
 * strongly correlated and charging for both would charge twice for one fact.
 * The residual is the genuinely new information, and it cuts both ways: a
 * low-time airframe is worth a premium, which is exactly how the real market
 * treats one.
 *
 * A brand-new airframe has no expected hours to divide by, so it has no excess
 * either — the factor is 1 and the age curve is the whole story.
 */
export function utilisationFactor(
  hours: number,
  ageYears: number,
  aircraftClass: AircraftClass,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): number {
  const [low, high] = balance.depreciation.utilisationFactorBounds;
  const expected = expectedHours(ageYears, aircraftClass, balance);
  if (expected <= 0) return Math.min(high, Math.max(low, 1));

  const excess = hours / expected - 1;
  const factor = 1 - balance.depreciation.utilisationSensitivity * excess;
  return Math.min(high, Math.max(low, factor));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** One option's contribution to the configuration factor, and why. */
export interface ConfigurationDrag {
  optionId: string;
  category: AircraftOptionCategory;
  /** False doubles down: C.3 rule 5 means the buyer cannot undo it. */
  retrofittable: boolean;
  /** Subtracted from the factor. Negative for an option the market wants. */
  drag: number;
}

export interface ConfigurationVerdict {
  factor: number;
  /** One line per option fitted, so the discount can be attributed (invariant 4). */
  drags: readonly ConfigurationDrag[];
  /**
   * `0` for a plain or universally-desirable airframe, `1` at the factor floor.
   *
   * The scalar C.5's *"hard to sell"* is expressed through — it drives how long
   * a listing lingers, and it is the one number a UI needs to say "unusual".
   */
  unusualness: number;
}

/**
 * How the market prices somebody else's decisions.
 *
 * Every fitted option subtracts its category's drag, doubled up by
 * `nonRetrofittableMultiplier` when the buyer would be stuck with it. Clamped
 * at both ends: the floor keeps a heavily-optioned airframe from approaching
 * free, and the ceiling keeps a stack of desirable options from pricing a used
 * aircraft above a new one.
 */
export function configurationFactor(
  options: readonly AircraftOption[],
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): ConfigurationVerdict {
  const { categoryDrag, nonRetrofittableMultiplier, factorBounds } = balance.configuration;
  const [low, high] = factorBounds;

  const drags = options.map((option): ConfigurationDrag => {
    const base = categoryDrag[option.category];
    return {
      optionId: option.id,
      category: option.category,
      retrofittable: option.retrofittable,
      drag: option.retrofittable ? base : base * nonRetrofittableMultiplier,
    };
  });

  const total = drags.reduce((sum, line) => sum + line.drag, 0);
  const factor = Math.min(high, Math.max(low, 1 - total));

  // Normalised against the floor rather than against the raw total, so
  // `unusualness` still means "as unusual as this market gets" after a retune
  // moves the floor.
  const unusualness = Math.min(1, Math.max(0, (1 - factor) / (1 - low)));

  return { factor, drags, unusualness };
}

/**
 * How long this listing sits before it is withdrawn.
 *
 * C.5's *"hard to sell"*, from the only side of the glass MVP has. Nothing else
 * in the world buys aircraft — NPC carriers do not shop — so a common airframe
 * leaving the market sooner is how "somebody else took it" is modelled, and an
 * unusual one still being there in seven game weeks is the game telling the
 * player something true.
 */
export function listingLifetimeDays(
  unusualness: number,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): number {
  const { baseListingLifetimeDays, unusualLingerDays } = balance.inventory;
  return baseListingLifetimeDays + Math.round(unusualLingerDays * unusualness);
}

// ---------------------------------------------------------------------------
// The price
// ---------------------------------------------------------------------------

export interface ValuationInput {
  aircraftClass: AircraftClass;
  listPriceMinor: number | null;
  monthlyLeaseRateMinor: number | null;
  ageYears: number;
  hours: number;
  options: readonly AircraftOption[];
}

/**
 * A price that can explain itself.
 *
 * Every factor is returned alongside the total, because invariant 4 forbids a
 * number a player cannot attribute — and an asking price they cannot take apart
 * is the single most obvious place for that to go wrong. *"Why is this A321neo
 * cheaper than that one?"* has to be answerable without reading this file.
 */
export interface UsedAircraftValuation {
  anchorMinor: number;
  anchorSource: AnchorSource;
  ageYears: number;
  ageFactor: number;
  hours: number;
  expectedHours: number;
  utilisationFactor: number;
  configuration: ConfigurationVerdict;
  /**
   * The product of the four numbers above, rounded once.
   *
   * Exactly the product, with nothing clamped on top — so a player taking the
   * decomposition apart arrives at this figure rather than at something near it.
   * The residual lives inside `ageFactor` as a salvage term, which is what makes
   * that possible.
   */
  askingPriceMinor: number;
}

export function valueUsedAirframe(
  input: ValuationInput,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): UsedAircraftValuation | null {
  const anchor = newEquivalentValue(input, balance);
  if (anchor === null) return null;

  const age = ageFactor(input.ageYears, balance);
  const utilisation = utilisationFactor(input.hours, input.ageYears, input.aircraftClass, balance);
  const configuration = configurationFactor(input.options, balance);

  // No clamp. Every factor is bounded away from zero on its own — the age curve
  // by its salvage residual, the other two by their configured bounds — so the
  // product cannot reach zero, and leaving it unclamped is what keeps the
  // decomposition arithmetically exact.
  const priced = anchor.minor * age * utilisation * configuration.factor;

  return {
    anchorMinor: anchor.minor,
    anchorSource: anchor.source,
    ageYears: input.ageYears,
    ageFactor: age,
    hours: input.hours,
    expectedHours: expectedHours(input.ageYears, input.aircraftClass, balance),
    utilisationFactor: utilisation,
    configuration,
    askingPriceMinor: Math.round(priced),
  };
}

// ---------------------------------------------------------------------------
// Which airframes the world is offering
// ---------------------------------------------------------------------------

/** Whole game days from the world's epoch. Negative before launch. */
function gameDaysSinceEpoch(epoch: Date, gameNow: Date): number {
  return Math.floor((gameNow.getTime() - epoch.getTime()) / MS_PER_DAY);
}

/**
 * Which generation of the market the world's clock is in.
 *
 * Derived from the clock, never stored — the same reasoning `reviewDue` gives
 * for the NPC review: a stored "last generated" column would have to be reset
 * when a world resets (ADR-0005), and forgetting that would leave a freshly
 * reset world believing its market was already full. The clock cannot forget.
 *
 * `-1` before the world has launched, which no berth is ever filled at.
 */
export function generationIndex(
  epoch: Date,
  gameNow: Date,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): number {
  const days = gameDaysSinceEpoch(epoch, gameNow);
  if (days < 0) return -1;
  return Math.floor(days / Math.max(1, balance.inventory.refreshIntervalDays));
}

/** A type the market may draw from, as the catalogue knows it. */
export interface UsedMarketCandidate {
  designation: string;
  aircraftClass: AircraftClass;
  era: AircraftEraDates;
  baseSpec: AircraftSpec;
  listPriceMinor: number | null;
  monthlyLeaseRateMinor: number | null;
  availableOptionIds: readonly string[];
}

/**
 * The window a used example of this type could have been built in, in game time.
 *
 * Four constraints, and every one of them is somebody else's rule rather than
 * this module's:
 *
 *   - not before **entry into service** (M4-02) — a type has no used examples
 *     before it had any examples;
 *   - not after **production end**, because that is when the last one was built;
 *   - old enough to have had a previous owner (`minAgeYears`) — inheriting one
 *     is C.5's entire subject;
 *   - young enough to still be on the market (`maxAgeYears`).
 *
 * `null` when those cannot all hold, which is the interesting case: in a 2026
 * world the A321XLR entered service in November 2024, so there is no example old
 * enough to have been sold on, and the type is simply absent from the market. A
 * 1990s world's used market contains 1990s aeroplanes for free, because the
 * catalogue's own dates say so.
 */
export function buildWindow(
  candidate: UsedMarketCandidate,
  gameNow: Date,
  balance: UsedMarketBalance = DEFAULT_USED_MARKET,
): { earliest: Date; latest: Date } | null {
  const state = availabilityOf(candidate.era, gameNow);
  // A prototype has no used market — nobody has operated one yet — and a retired
  // type cannot legally be flown, so selling one would be selling a paperweight.
  if (state !== 'orderable' && state !== 'used_only') return null;

  const { minAgeYears, maxAgeYears } = balance.inventory;
  const eis =
    candidate.era.entryIntoService === null
      ? null
      : Date.parse(`${candidate.era.entryIntoService}T00:00:00.000Z`);
  if (eis === null || Number.isNaN(eis)) return null;

  const productionEnd =
    candidate.era.productionEnd === null
      ? null
      : Date.parse(`${candidate.era.productionEnd}T00:00:00.000Z`);

  const earliestMs = Math.max(eis, gameNow.getTime() - maxAgeYears * DAYS_PER_YEAR * MS_PER_DAY);

  let latestMs = gameNow.getTime() - minAgeYears * DAYS_PER_YEAR * MS_PER_DAY;
  if (productionEnd !== null) {
    // An unparseable date is refused rather than ignored. `Math.min(x, NaN)` is
    // NaN and every comparison against it is false, so ignoring it would produce
    // a listing with an invalid build date instead of no listing at all.
    if (Number.isNaN(productionEnd)) return null;
    latestMs = Math.min(latestMs, productionEnd);
  }

  if (latestMs < earliestMs) return null;
  return { earliest: new Date(earliestMs), latest: new Date(latestMs) };
}

/** One aircraft the world is offering, decided and priced. */
export interface UsedListingDraft {
  slotIndex: number;
  generationIndex: number;
  typeDesignation: string;
  /** Game-time instant. Age is derived from it and the clock, never stored. */
  builtAt: Date;
  hours: number;
  cycles: number;
  buildOptionIds: readonly string[];
  effectiveSpec: AircraftSpec;
  valuation: UsedAircraftValuation;
  /** Game-time instant the listing is withdrawn if nobody has bought it. */
  expiresAt: Date;
  /**
   * Which location the caller should use, as an index into the list it supplied.
   *
   * An index rather than an ICAO code because this package cannot read the
   * airport table, and inventing a code it could not check would be worse than
   * asking the caller for the shortlist.
   */
  locationIndex: number;
}

export interface DraftInput {
  worldSeed: string;
  epoch: Date;
  gameNow: Date;
  slotIndex: number;
  candidates: readonly UsedMarketCandidate[];
  optionCatalogue: ReadonlyMap<string, AircraftOption>;
  /** How many airports the caller is offering. Locations are chosen by index. */
  locationCount: number;
  balance?: UsedMarketBalance;
}

/**
 * How many options a generated airframe carries.
 *
 * Weighted hard toward few, because most aeroplanes are ordinary and an unusual
 * one has to be unusual *relative to something*. A market where every airframe
 * carried three options would have no common configurations to compare against,
 * and C.5's whole contrast would collapse.
 */
function optionCount(rng: Rng): number {
  return weightedPick(rng, [
    [0, 40],
    [1, 32],
    [2, 18],
    [3, 10],
  ]);
}

/**
 * Draft the aircraft standing in one berth in one generation.
 *
 * Pure, and keyed only on `(worldSeed, slot, generation)`. Returns `null` when
 * the world has not launched, when no candidate type has a feasible build window
 * — a very early world — or when the drawn type cannot be valued.
 */
export function draftUsedListing(input: DraftInput): UsedListingDraft | null {
  const balance = input.balance ?? DEFAULT_USED_MARKET;
  const generation = generationIndex(input.epoch, input.gameNow, balance);
  if (generation < 0) return null;
  if (input.locationCount <= 0) return null;

  const feasible = input.candidates.flatMap((candidate) => {
    const window = buildWindow(candidate, input.gameNow, balance);
    if (window === null) return [];
    const weight = balance.inventory.classSupplyWeight[candidate.aircraftClass];
    if (weight <= 0) return [];
    return [{ candidate, window, weight }];
  });
  if (feasible.length === 0) return null;

  const rng = deriveRng(
    input.worldSeed,
    'used-market',
    String(input.slotIndex),
    String(generation),
  );

  const drawn = weightedPick(
    rng,
    feasible.map((entry) => [entry, entry.weight] as const),
  );
  const { candidate, window } = drawn;

  const builtAt = new Date(
    window.earliest.getTime() +
      Math.floor(rng() * (window.latest.getTime() - window.earliest.getTime() + 1)),
  );
  const ageYears = ageYearsBetween(builtAt, input.gameNow);

  // Utilisation is drawn once and clamped, then hours follow from it. Drawing
  // hours directly would let a two-year-old airframe come back with 40,000 of
  // them, which is not a rare aeroplane but an impossible one.
  const utilisation = Math.min(1.45, Math.max(0.55, gaussian(rng, 1, 0.18)));
  const hours = Math.round(expectedHours(ageYears, candidate.aircraftClass, balance) * utilisation);
  const cycles = cyclesForHours(hours, candidate.aircraftClass, balance);

  // Options are added one at a time and anything the build rules refuse is
  // simply skipped. Reimplementing C.6's conflict table here would be a second
  // copy of it, and the second copy is the one that goes stale.
  const buildType = {
    designation: candidate.designation,
    availableOptionIds: candidate.availableOptionIds,
  };
  const wanted = optionCount(rng);
  const available = [...candidate.availableOptionIds];
  const chosen: string[] = [];
  for (let i = 0; i < wanted && available.length > 0; i += 1) {
    const pick = intBetween(rng, 0, available.length - 1);
    const [id] = available.splice(pick, 1);
    if (id === undefined) continue;
    const trial = resolveOptions({
      type: buildType,
      catalogue: input.optionCatalogue,
      optionIds: [...chosen, id],
    });
    if (trial.ok) chosen.push(id);
  }

  const resolved = resolveOptions({
    type: buildType,
    catalogue: input.optionCatalogue,
    optionIds: chosen,
  });
  const options = resolved.ok ? resolved.options : [];

  const valuation = valueUsedAirframe(
    {
      aircraftClass: candidate.aircraftClass,
      listPriceMinor: candidate.listPriceMinor,
      monthlyLeaseRateMinor: candidate.monthlyLeaseRateMinor,
      ageYears,
      hours,
      options,
    },
    balance,
  );
  if (valuation === null) return null;

  const lifetime = listingLifetimeDays(valuation.configuration.unusualness, balance);

  return {
    slotIndex: input.slotIndex,
    generationIndex: generation,
    typeDesignation: candidate.designation,
    builtAt,
    hours,
    cycles,
    buildOptionIds: options.map((option) => option.id),
    // M4-03's fold, not a second one. C.6 is explicit that everything
    // downstream reads only `effective_spec`, and a used airframe that computed
    // its own would be the first exception to that.
    effectiveSpec: computeEffectiveSpec({ baseSpec: candidate.baseSpec, options }),
    valuation,
    expiresAt: new Date(input.gameNow.getTime() + lifetime * MS_PER_DAY),
    locationIndex: intBetween(rng, 0, input.locationCount - 1),
  };
}
