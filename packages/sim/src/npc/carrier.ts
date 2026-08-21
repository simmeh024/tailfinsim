import {
  CABIN_ORDER,
  type CabinClass,
  type DemandSegment,
  ECONOMY_CONFIG_V1,
  type EconomyConfig,
  type NpcArchetype,
} from '@tailfin/shared';

import type { CabinOffer, ClassOperator } from '../demand/class-allocation';

/**
 * What an NPC carrier offers, and what it decides (M3-12, §24).
 *
 * §24 calls this MVP-blocking and says why: *"500 players cannot populate 4,000
 * airports. Without AI incumbents the world is empty and the demand model has
 * nothing to compete against."*
 *
 * ## The rule that shapes every function here
 *
 * *"NPCs obey exactly the same rules as players — same demand model, same
 * costs, no cheating."* That is the third acceptance criterion, and it is why
 * this module computes **nothing of its own**. An NPC's fare is drawn against
 * the same `routeVariableCostPerSeatMinor` a player's fare floor is drawn
 * against; its share is decided by the same `allocateByClass`; its coefficients
 * are a section of the same versioned `EconomyConfig`. There is no NPC discount,
 * no NPC cost table and no NPC demand path.
 *
 * The only thing an NPC has that a player does not is a function that decides
 * for it — which is the definition of an NPC rather than an advantage.
 *
 * ## Why fares are a markup on cost rather than a price
 *
 * A fixed price per archetype would be wrong at both ends of the distance
 * curve: cheap on a transatlantic sector and extortionate on a 200 nm hop. A
 * markup on per-seat variable cost scales correctly by construction, and it
 * cannot breach A.10's floor, because the floor is a share of the same number.
 *
 * ## Determinism
 *
 * Everything here is pure. Where a choice needs randomness — which country gets
 * a carrier, which of two equally good markets to enter — the caller passes a
 * seeded `Rng` derived from the world's own seed, so a world replays identically
 * (invariant 2, and M13-01's harness).
 */

export type NpcBalance = EconomyConfig['npc'];
export type NpcArchetypeProfile = NpcBalance['archetypes'][NpcArchetype];

/** The shipped NPC balance. A slice of the seed, like every other `DEFAULT_*`. */
export const DEFAULT_NPC: NpcBalance = ECONOMY_CONFIG_V1.npc;

/** Version tag. A market position has to stay explicable after a retune (invariant 4). */
export const NPC_CONFIG_VERSION = 'v1' as const;

/** How many seats an archetype puts on one departure, across all cabins. */
export function seatsPerDeparture(profile: NpcArchetypeProfile): number {
  return CABIN_ORDER.reduce((total, cabin) => total + profile.seatsByCabin[cabin], 0);
}

/**
 * How often this archetype would fly a market of this size.
 *
 * Sized to the share it is aiming at rather than to the whole market, so two
 * carriers on one pair do not each plan for all of it. Always at least one — a
 * carrier that decided to fly a route zero times has not entered it, and that
 * is `decideEntry`'s call rather than this one's.
 */
export function frequencyFor(
  profile: NpcArchetypeProfile,
  dailyPassengers: number,
  seats = seatsPerDeparture(profile),
): number {
  if (seats <= 0) return 1;
  const wanted = (dailyPassengers * profile.targetShare) / seats;
  return Math.max(1, Math.min(profile.maxFrequency, Math.round(wanted)));
}

/**
 * The fare this archetype charges, given what the sector costs it per seat.
 *
 * Floored at A.10's floor rather than at the markup, so a thin market cannot
 * push an NPC into selling below the price a player would be refused at. The
 * floor is the *same* number the player-facing route editor enforces.
 */
export function fareFor(
  profile: NpcArchetypeProfile,
  variableCostPerSeatMinor: number,
  floorMinor: number,
): number {
  return Math.max(floorMinor, Math.ceil(variableCostPerSeatMinor * profile.fareMarkup));
}

/**
 * The cabins this archetype sells on this route, at this fare.
 *
 * Cabins above economy are priced as multiples of the economy fare, in the
 * proportions A.6's propensities imply are sellable — a business seat that cost
 * the same as an economy seat would be bought by everyone and would make the
 * per-class allocation meaningless.
 */
export function cabinsFor(
  profile: NpcArchetypeProfile,
  economyFareMinor: number,
): Partial<Record<CabinClass, CabinOffer>> {
  const multiple: Record<CabinClass, number> = {
    economy: 1,
    premium_economy: 1.6,
    business: 3.2,
    first: 5.5,
  };

  const cabins: Partial<Record<CabinClass, CabinOffer>> = {};
  for (const cabin of CABIN_ORDER) {
    const seats = profile.seatsByCabin[cabin];
    if (seats > 0) {
      cabins[cabin] = { seats, fareMinor: Math.ceil(economyFareMinor * multiple[cabin]) };
    }
  }
  return cabins;
}

/** What a carrier already sells on one market, as the demand model sees it. */
export interface NpcOffer {
  operatorId: string;
  frequency: number;
  economyFareMinor: number;
  cabins: Partial<Record<CabinClass, CabinOffer>>;
}

/**
 * One NPC as a competitor in A.3's logit.
 *
 * The same `ClassOperator` shape a player's own offer is converted to, which is
 * the point: `allocateByClass` cannot tell them apart, and nothing downstream
 * of it needs to.
 */
export function asOperator(offer: NpcOffer, profile: NpcArchetypeProfile): ClassOperator {
  return {
    id: offer.operatorId,
    frequency: offer.frequency,
    productScore: profile.productScore,
    reputation: profile.reputation,
    cabins: offer.cabins,
  };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** What a carrier knows about one market when it decides. */
export interface MarketView {
  originIcao: string;
  destinationIcao: string;
  greatCircleNm: number;
  dailyPassengers: number;
  /** The segment mix, from `demand_pool`. Decides how much a charter wants it. */
  segments: Record<DemandSegment, number>;
  /** Operators already selling the pair, this carrier excluded. */
  incumbents: number;
  /** Per-seat variable cost of flying it, from the shared fare-floor model. */
  variableCostPerSeatMinor: number;
  /** A.10's floor for this route. */
  floorMinor: number;
}

export type EntryVerdict =
  | {
      enter: true;
      frequency: number;
      economyFareMinor: number;
      estimatedMargin: number;
      expectedLoadFactor: number;
    }
  | { enter: false; code: EntryRefusal; estimatedMargin: number; expectedLoadFactor: number };

export type EntryRefusal = 'too-thin' | 'out-of-range' | 'margin-too-low' | 'no-viable-fare';

/**
 * The share of a market this archetype could realistically expect here.
 *
 * Two adjustments to its ambition, and both are about *fit* rather than luck.
 * Segment fit rewards a charter operator for a holiday market and penalises it
 * for a business one — its product genuinely suits one and not the other, which
 * is the same fact A.3's β coefficients express for passengers. Incumbents drag
 * it down, because a market already served has less of itself left over.
 */
export function achievableShare(
  market: MarketView,
  profile: NpcArchetypeProfile,
  behaviour: NpcBalance['behaviour'],
): number {
  const segmentFit = 1 + profile.leisureAffinity * (leisureWeight(market.segments) - 0.5) * 2;
  const drag = 1 + market.incumbents * behaviour.incumbentShareDrag;
  return Math.max(0, Math.min(1, (profile.targetShare * segmentFit) / drag));
}

/**
 * Whether this archetype wants this market.
 *
 * ## What margin means here, and the mistake it replaces
 *
 * The first version of this function computed margin as `(fare − cost) / fare`,
 * which is a **pure function of the archetype's markup** — the market did not
 * enter into it at all. An LCC at a 1.16 markup scored 0.138 on every route in
 * the world, a flag carrier 0.355 on every route in the world, and "should I
 * enter this market?" was really asking "am I a flag carrier?". It was caught
 * by a test that expected a low-cost carrier to enter a fat uncontested market
 * and found it entering nothing, anywhere, ever.
 *
 * What actually decides whether a route pays is **load factor**: seats are
 * bought by the departure and sold by the passenger, so the question is how
 * full the aircraft is. With a markup `m` over variable cost and a load factor
 * `L`, contribution margin is `1 − 1/(L·m)`. That puts the break-even load
 * factor at `1/m` — about 86% for an LCC and 65% for a flag carrier, which is
 * both the right shape and the right reason: low-cost carriers live or die on
 * how full they fly.
 *
 * So a market is attractive when it is big enough to fill the aircraft the
 * archetype would send, and unattractive when incumbents or a poor segment fit
 * mean it would fly half empty. Which is A.10's monopoly guard, arrived at
 * honestly: *"fat margins on an uncontested route visibly attract AI entrants."*
 */
export function decideEntry(
  market: MarketView,
  profile: NpcArchetypeProfile,
  behaviour: NpcBalance['behaviour'],
): EntryVerdict {
  const fare = fareFor(profile, market.variableCostPerSeatMinor, market.floorMinor);

  if (market.dailyPassengers < profile.minDailyPassengers) {
    return { enter: false, code: 'too-thin', estimatedMargin: 0, expectedLoadFactor: 0 };
  }
  if (market.greatCircleNm > profile.maxRangeNm) {
    return { enter: false, code: 'out-of-range', estimatedMargin: 0, expectedLoadFactor: 0 };
  }
  if (market.variableCostPerSeatMinor <= 0 || fare <= market.variableCostPerSeatMinor) {
    return { enter: false, code: 'no-viable-fare', estimatedMargin: 0, expectedLoadFactor: 0 };
  }

  const frequency = frequencyFor(profile, market.dailyPassengers);
  const capacity = seatsPerDeparture(profile) * frequency;
  const expectedPassengers = Math.min(
    capacity,
    market.dailyPassengers * achievableShare(market, profile, behaviour),
  );

  const loadFactor = capacity <= 0 ? 0 : expectedPassengers / capacity;
  const revenue = expectedPassengers * fare;
  const cost = capacity * market.variableCostPerSeatMinor;
  const margin = revenue <= 0 ? -1 : (revenue - cost) / revenue;

  if (margin < behaviour.entryMarginThreshold) {
    return {
      enter: false,
      code: 'margin-too-low',
      estimatedMargin: margin,
      expectedLoadFactor: loadFactor,
    };
  }

  return {
    enter: true,
    frequency,
    economyFareMinor: fare,
    estimatedMargin: margin,
    expectedLoadFactor: loadFactor,
  };
}

/** Leisure plus VFR as a share of the pool — the "holiday market" reading. */
function leisureWeight(segments: Record<DemandSegment, number>): number {
  const total = segments.business + segments.leisure + segments.vfr;
  if (total <= 0) return 0.5;
  return (segments.leisure + segments.vfr) / total;
}

/**
 * Whether a route this carrier already flies has stopped being worth flying.
 *
 * Exit needs *sustained* loss rather than one bad review, for the same reason
 * PX-10 gives reputation memory: a single review catching a market mid-season
 * would have carriers thrashing in and out of routes, which is neither
 * realistic nor readable in a decision log.
 */
export function decideExit(
  consecutiveLossReviews: number,
  behaviour: NpcBalance['behaviour'],
): boolean {
  return consecutiveLossReviews >= behaviour.exitLossReviews;
}

export interface FareMove {
  changed: boolean;
  fareMinor: number;
}

/**
 * Move a fare toward where this carrier thinks it should be.
 *
 * Two forces, and the order matters. The target is the carrier's own cost-based
 * fare, pulled part of the way toward the market average — so a carrier in an
 * expensive market drifts up and one in a cheap market drifts down, without
 * either abandoning its own economics. Then A.10's floor clamps the result,
 * because no amount of market pressure permits selling below cost.
 *
 * The deadband exists for the decision log rather than for the simulation: a
 * carrier that rewrites its fare by four minor units every week produces a log
 * nobody can read.
 */
export function decideFare(
  currentMinor: number,
  ownTargetMinor: number,
  marketAverageMinor: number,
  floorMinor: number,
  behaviour: NpcBalance['behaviour'],
): FareMove {
  const pulled =
    marketAverageMinor > 0
      ? ownTargetMinor + (marketAverageMinor - ownTargetMinor) * behaviour.fareAdjustmentRate
      : ownTargetMinor;

  const target = Math.max(floorMinor, Math.round(pulled));
  if (currentMinor <= 0) return { changed: true, fareMinor: target };

  const drift = Math.abs(target - currentMinor) / currentMinor;
  if (drift < behaviour.fareDeadband) return { changed: false, fareMinor: currentMinor };

  return { changed: true, fareMinor: target };
}
