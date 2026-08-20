/**
 * The product is the itinerary, not the flight (M3-07, App. A.14).
 *
 * A.2–A.9 model a single city pair served by direct operators. Hub-and-spoke is
 * one of the two grand strategies in this design — §8.2's banks, App. B.6's 5×
 * gate cost, §17.3's alliance feed — and A.14 is blunt about what happens
 * without this module: *"none of that has any maths behind it."*
 *
 * ## One asymmetry does all the work
 *
 * A.14 gives three numbers — business 0.9, leisure 0.35, VFR 0.30 — and then
 * says what they are for:
 *
 * > *"Business travellers hate connections; leisure travellers will accept one
 * > for a cheaper fare. That single asymmetry is why hub carriers chase
 * > business traffic and point-to-point LCCs chase leisure."*
 *
 * A business traveller's 0.9 penalty is nearly a full point of utility against
 * a β_price of 1.1, so a connection costs about what an 80% fare premium costs.
 * For leisure at 0.35 against a β_price of 3.0, it is worth roughly a 12%
 * discount. The two strategies fall out of that gap rather than being
 * legislated.
 *
 * ## Why the enumeration is bounded
 *
 * Every one-stop over ~4,000 airports is O(n³) and impossible. A.14's three
 * restrictions are all implemented here:
 *
 * - **candidate hubs are only where the operator bases aircraft**, capped at
 *   {@link ItineraryConfig.maxHubs} (A.14 says ≤ 10 per airline) — and the cap
 *   is enforced by throwing rather than by silently truncating, because a
 *   quietly dropped hub is a route that mysteriously stops selling;
 * - **only city pairs with a real demand pool** are evaluated, which this module
 *   enforces structurally by taking one origin and destination per call rather
 *   than a network;
 * - **cached per schedule change**, for which {@link scheduleFingerprint} gives
 *   a key. The cache itself belongs to the server — `packages/sim` holds no
 *   state (invariant 2) — but the thing that makes caching *correct*, a
 *   fingerprint that changes exactly when the schedule does, belongs here with
 *   the model that defines what a schedule change means.
 *
 * Legs are indexed by endpoint on the way in, so a pair costs
 * `hubs × arrivals(H) × departures(H)` rather than a scan of the network.
 *
 * ## Why banks pay for themselves
 *
 * The property A.14 calls the strongest argument in the design: connections at
 * a hub scale with the **square** of the aircraft on the ground together, since
 * every arrival can feed every departure. Twelve aircraft in one bank offer
 * ~132 possible connections; twelve rolling through the day offer a handful.
 * That is the same decision as B.6's 5× gate bill, seen from the revenue side —
 * and it is emergent here rather than asserted, because the enumeration really
 * does pair every arrival with every departure inside the connect window.
 */

import type { DemandSegment } from '@tailfin/shared';

import { haversineNm } from '../distance';

import type { Operator } from './logit';

/** Somewhere an itinerary touches. */
export interface Place {
  icao: string;
  latitude: number;
  longitude: number;
  /**
   * Minimum connect time at this airport, in minutes.
   *
   * A.14 notes it is *"longer for terminal changes and immigration"*. The
   * terminal part is modelled separately, per connection, because it depends on
   * which two flights meet rather than on the airport; this is the floor.
   */
  mctMinutes?: number;
}

/** One operated leg, as an itinerary sees it. */
export interface ItineraryLeg {
  id: string;
  originIcao: string;
  destinationIcao: string;
  /** Minutes from the cycle anchor, matching `ScheduledLeg.departureMinute`. */
  departureMinute: number;
  /** Off-blocks plus block time — `arrivalMinute()` in the schedule module. */
  arrivalMinute: number;
  distanceNm: number;
  seatsAvailable: number;
  fareMinor: number;
  /** A.3's 0–1 product composite for this leg. */
  productScore: number;
  /**
   * Which terminal the leg uses, where it is known.
   *
   * A connection changes terminal when two legs name different ones. Unknown on
   * either side means no change is charged — inventing a penalty from missing
   * data would make every airport without terminal modelling look worse.
   */
  terminal?: string;
}

export interface ItineraryConfig {
  /** A.14's `base(segment)`, verbatim. */
  basePenalty: Record<DemandSegment, number>;
  /**
   * A.14's λ: extra penalty per hour of connection beyond the minimum.
   *
   * Not a published figure — A.14 names the term and leaves the coefficient
   * open. At 0.25 a three-hour connection over a 45-minute MCT costs a business
   * traveller 0.9 + 0.56 ≈ 1.46, about half again what the connection itself
   * costs, which keeps a long layover clearly worse than a tight one without
   * swamping the base.
   */
  lambdaPerHour: number;
  /** Added when the two legs use different terminals. Also not published. */
  terminalChangePenalty: number;
  /** A.14: connection time ≤ 6 h. */
  maxConnectMinutes: number;
  /** A.14: total detour ≤ 1.35 × great circle. */
  maxDetourRatio: number;
  /** A.14: candidate hubs are where the operator bases aircraft, ≤ 10. */
  maxHubs: number;
  /** Used when an airport states no MCT of its own. */
  defaultMctMinutes: number;
}

export const DEFAULT_ITINERARY: ItineraryConfig = {
  // The three numbers A.14 publishes, and the whole mechanic.
  basePenalty: { business: 0.9, leisure: 0.35, vfr: 0.3 },
  lambdaPerHour: 0.25,
  terminalChangePenalty: 0.3,
  maxConnectMinutes: 6 * 60,
  maxDetourRatio: 1.35,
  maxHubs: 10,
  defaultMctMinutes: 45,
};

/** Version tag. A share has to stay explicable after a retune (invariant 4). */
export const ITINERARY_CONFIG_VERSION = 'v1' as const;

/** A valid one-stop, and every figure that made it valid. */
export interface Itinerary {
  hubIcao: string;
  first: ItineraryLeg;
  second: ItineraryLeg;
  /** Wheels-on at the hub to off-blocks again. */
  connectMinutes: number;
  /** The floor it had to clear. */
  mctMinutes: number;
  /** Flown distance ÷ great circle. 1.0 would be a straight line through the hub. */
  detourRatio: number;
  totalDistanceNm: number;
  terminalChange: boolean;
  /** Seats available on the tighter of the two legs — an itinerary is one booking. */
  seatsAvailable: number;
}

/** Why a candidate was refused, for the pairs that produced none. */
export type ItineraryRejection =
  'no-such-connection' | 'below-mct' | 'connection-too-long' | 'detour-too-far' | 'no-seats';

function mctOf(hub: Place, config: ItineraryConfig): number {
  return hub.mctMinutes ?? config.defaultMctMinutes;
}

/**
 * Every valid one-stop from A to B, over the operator's own hubs.
 *
 * Pure and deterministic: the same schedule always enumerates the same
 * itineraries, in the same order.
 */
export function enumerateItineraries(
  input: {
    origin: Place;
    destination: Place;
    /** Where the operator bases aircraft. A.14 caps this at ten. */
    hubs: readonly Place[];
    legs: readonly ItineraryLeg[];
    /** Seats one booking needs on both legs. Defaults to one. */
    seatsNeeded?: number;
  },
  config: ItineraryConfig = DEFAULT_ITINERARY,
): Itinerary[] {
  const { origin, destination, hubs, legs } = input;
  const seatsNeeded = input.seatsNeeded ?? 1;

  if (hubs.length > config.maxHubs) {
    // Loudly, not by truncation: a silently dropped hub is a route that
    // mysteriously stops selling, and A.14's whole cost argument rests on this
    // set staying small.
    throw new Error(
      `An airline may connect over at most ${String(config.maxHubs)} hubs, got ${String(hubs.length)}`,
    );
  }
  if (origin.icao === destination.icao) {
    throw new Error('An itinerary needs two different endpoints');
  }

  const greatCircle = haversineNm(
    origin.latitude,
    origin.longitude,
    destination.latitude,
    destination.longitude,
  );

  // Index by endpoint so a pair costs hubs × arrivals × departures rather than
  // a scan of the whole network. This is the difference between A.14's bounded
  // enumeration and the O(n³) it warns about.
  const arrivalsAt = new Map<string, ItineraryLeg[]>();
  const departuresFrom = new Map<string, ItineraryLeg[]>();
  for (const leg of legs) {
    if (leg.originIcao === origin.icao) {
      const list = arrivalsAt.get(leg.destinationIcao);
      if (list) list.push(leg);
      else arrivalsAt.set(leg.destinationIcao, [leg]);
    }
    if (leg.destinationIcao === destination.icao) {
      const list = departuresFrom.get(leg.originIcao);
      if (list) list.push(leg);
      else departuresFrom.set(leg.originIcao, [leg]);
    }
  }

  const found: Itinerary[] = [];

  for (const hub of hubs) {
    if (hub.icao === origin.icao || hub.icao === destination.icao) continue;

    const inbound = arrivalsAt.get(hub.icao);
    const outbound = departuresFrom.get(hub.icao);
    if (!inbound || !outbound) continue;

    const mct = mctOf(hub, config);

    // Every arrival against every departure — which is exactly why a bank of
    // twelve aircraft offers ~132 connections and twelve rolling offer a handful.
    for (const first of inbound) {
      for (const second of outbound) {
        const connectMinutes = second.departureMinute - first.arrivalMinute;
        if (connectMinutes < mct) continue;
        if (connectMinutes > config.maxConnectMinutes) continue;

        const totalDistanceNm = first.distanceNm + second.distanceNm;
        const detourRatio = greatCircle === 0 ? Infinity : totalDistanceNm / greatCircle;
        if (detourRatio > config.maxDetourRatio) continue;

        const seatsAvailable = Math.min(first.seatsAvailable, second.seatsAvailable);
        if (seatsAvailable < seatsNeeded) continue;

        found.push({
          hubIcao: hub.icao,
          first,
          second,
          connectMinutes,
          mctMinutes: mct,
          detourRatio,
          totalDistanceNm,
          terminalChange:
            first.terminal !== undefined &&
            second.terminal !== undefined &&
            first.terminal !== second.terminal,
          seatsAvailable,
        });
      }
    }
  }

  // Sorted so the result does not depend on hub or leg ordering — the same
  // schedule must enumerate identically every time (invariant 2).
  found.sort(
    (a, b) =>
      a.first.departureMinute - b.first.departureMinute ||
      a.second.departureMinute - b.second.departureMinute ||
      a.hubIcao.localeCompare(b.hubIcao),
  );
  return found;
}

/**
 * A.14's `ConnectionPenalty = base(segment) + λ·(connect − MCT) + terminalChange`.
 *
 * Subtracted from utility by the logit rather than multiplied by a coefficient,
 * because the segment difference already lives in `base` — which is why A.3
 * writes the term outside the βs.
 */
export function connectionPenalty(
  itinerary: Itinerary,
  segment: DemandSegment,
  config: ItineraryConfig = DEFAULT_ITINERARY,
): number {
  const excessHours = Math.max(0, itinerary.connectMinutes - itinerary.mctMinutes) / 60;
  return (
    config.basePenalty[segment] +
    config.lambdaPerHour * excessHours +
    (itinerary.terminalChange ? config.terminalChangePenalty : 0)
  );
}

/** Distance-weighted mean of the two legs' product scores. */
function combinedProduct(itinerary: Itinerary): number {
  const total = itinerary.totalDistanceNm;
  if (total === 0) return (itinerary.first.productScore + itinerary.second.productScore) / 2;
  return (
    (itinerary.first.productScore * itinerary.first.distanceNm +
      itinerary.second.productScore * itinerary.second.distanceNm) /
    total
  );
}

/**
 * Fold an operator's valid connections into **one** competitor for A.3's logit.
 *
 * A.14: *"The itinerary enters the A.3 logit as one competitor"* — price the
 * sum of leg fares less a connection discount, product the weighted mean,
 * frequency the daily count of valid connections.
 *
 * Where several connections exist, the penalty taken is the **best** of them,
 * not the average. A passenger books the connection that suits them; having
 * three others is convenience, and convenience is already priced by A.3's
 * `ln(Frequency)`. Averaging would charge them for the bad options they were
 * never going to take — the same reasoning M3-04 applies to a bank of
 * departures.
 */
export function asConnectingCompetitor(
  input: {
    id: string;
    itineraries: readonly Itinerary[];
    reputation: number;
    /** What the operator knocks off for accepting a connection, in minor units. */
    connectionDiscountMinor?: number;
    schedFit?: Operator['schedFit'];
    loyalty?: number;
    alliance?: Operator['alliance'];
  },
  config: ItineraryConfig = DEFAULT_ITINERARY,
): Operator {
  const { itineraries } = input;
  if (itineraries.length === 0) {
    throw new Error(`${input.id} has no valid connections to compete with`);
  }

  const discount = input.connectionDiscountMinor ?? 0;
  const fares = itineraries.map((i) => i.first.fareMinor + i.second.fareMinor - discount);
  const fareMinor = fares.reduce((sum, f) => sum + f, 0) / fares.length;
  if (fareMinor <= 0) {
    throw new Error(`${input.id} discounts its connection below zero`);
  }

  const productScore =
    itineraries.reduce((sum, i) => sum + combinedProduct(i), 0) / itineraries.length;

  const penalty = {} as Record<DemandSegment, number>;
  for (const segment of ['business', 'leisure', 'vfr'] as const) {
    penalty[segment] = Math.min(...itineraries.map((i) => connectionPenalty(i, segment, config)));
  }

  return {
    id: input.id,
    fareMinor,
    // A.14: "frequency = daily valid connections at H".
    frequency: itineraries.length,
    productScore,
    reputation: input.reputation,
    schedFit: input.schedFit,
    loyalty: input.loyalty,
    alliance: input.alliance,
    connectionPenalty: penalty,
  };
}

/** One leg's cut of a booked itinerary. */
export interface ProratedLeg {
  legId: string;
  shareMinor: number;
  /** `distance × productScore` — the weight that earned it. */
  weight: number;
}

/**
 * Split a booked fare across the legs by **distance × leg product weight** (A.14).
 *
 * *"So the operator of the long premium leg earns more of it."* The same formula
 * divides revenue across a codeshare boundary (§17.4), which is why it is a
 * function of the legs rather than of one airline's books.
 *
 * **The parts sum to the whole, exactly.** Proportional shares of an integer
 * almost never divide evenly, and rounding each independently loses or invents
 * a unit — which on a revenue split is a reconciliation failure, not a rounding
 * detail. Largest remainder: floor everything, then hand the leftover units to
 * the legs with the largest fractional parts, so the total is preserved by
 * construction rather than checked afterwards.
 */
export function prorate(fareMinor: number, itinerary: Itinerary): ProratedLeg[] {
  if (!Number.isFinite(fareMinor) || fareMinor < 0 || !Number.isInteger(fareMinor)) {
    throw new Error(`A fare must be whole minor units, got ${String(fareMinor)}`);
  }

  const legs = [itinerary.first, itinerary.second];
  const weights = legs.map((leg) => leg.distanceNm * leg.productScore);
  const total = weights.reduce((sum, w) => sum + w, 0);

  // Degenerate but representable: two zero-distance or zero-product legs. An
  // even split is the only defensible answer and beats dividing by zero.
  const shares =
    total > 0 ? weights.map((w) => (fareMinor * w) / total) : weights.map(() => fareMinor / 2);

  const floors = shares.map((s) => Math.floor(s));
  let remaining = fareMinor - floors.reduce((sum, f) => sum + f, 0);

  // Ordered by fractional part, then by leg id so a tie resolves identically
  // every run rather than by array order.
  const order = shares
    .map((share, index) => ({ index, fraction: share - floors[index]! }))
    .sort((a, b) => b.fraction - a.fraction || legs[a.index]!.id.localeCompare(legs[b.index]!.id));

  const result = floors.slice();
  for (const { index } of order) {
    if (remaining <= 0) break;
    result[index] = result[index]! + 1;
    remaining -= 1;
  }

  return legs.map((leg, index) => ({
    legId: leg.id,
    shareMinor: result[index]!,
    weight: weights[index]!,
  }));
}

/**
 * A key that changes exactly when the schedule does.
 *
 * A.14 requires itineraries to be *"cached per schedule change, not recomputed
 * per query"*. The cache belongs to the server — nothing here holds state — but
 * what makes caching *correct* is a key that moves when, and only when, the
 * inputs to the enumeration move. That is a property of this model, so it lives
 * with it.
 *
 * Covers every field the enumeration reads. Seats are in it because a leg
 * filling up can invalidate a connection, which is a real invalidation and the
 * easiest one to forget.
 */
export function scheduleFingerprint(legs: readonly ItineraryLeg[]): string {
  const parts = legs
    .map((leg) =>
      [
        leg.id,
        leg.originIcao,
        leg.destinationIcao,
        leg.departureMinute,
        leg.arrivalMinute,
        leg.seatsAvailable,
        leg.fareMinor,
        leg.productScore,
        leg.terminal ?? '',
      ].join(':'),
    )
    // Sorted, so the key depends on the schedule rather than on the order rows
    // came back from a query.
    .sort();

  // FNV-1a: short, stable across processes, and enough for a cache key — this
  // guards against staleness, not against an adversary.
  let hash = 0x811c9dc5;
  const source = parts.join('|');
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
