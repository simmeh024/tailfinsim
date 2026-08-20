/**
 * Which cabin they bought (M3-06, App. A.6).
 *
 * A.2–A.5 sized a route's market, split it between operators and cleared it
 * against capacity — all of it treating a passenger as a passenger. A.6 says
 * that is not enough:
 *
 * > *"Run the logit **per cabin class**, not just per route. Each class has its
 * > own fare, its own seat count, and draws from a segment mix weighted toward
 * > that class."*
 *
 * ## Segment is not cabin
 *
 * `DemandSegment`'s own note in `@tailfin/shared` draws the distinction this
 * module runs on: *"a business traveller often sits in economy; the segment is
 * why they are flying, the cabin is what they bought."*
 *
 * So the mix here is a **propensity**: given a business traveller, what are the
 * chances they buy each cabin. Each segment's row sums to 1, because everybody
 * buys exactly one seat. That constraint is what makes the roll-up exact — the
 * second acceptance criterion — rather than something to be reconciled
 * afterwards.
 *
 * ## Why this makes the cabin builder matter
 *
 * A.6 again: *"a 1-2-1 business cabin only pays off where the business segment
 * pool is deep enough to fill it. Fit the cabin to the route, not to your
 * ego."*
 *
 * That falls out of the propensities rather than being enforced. On a
 * leisure-heavy route the business-cabin pool is small because leisure
 * travellers overwhelmingly buy economy, so a big premium cabin has nothing to
 * fill it with — and the breakdown says exactly that, segment by segment,
 * rather than reporting a bad load factor with no cause.
 *
 * ## Two different ways a cabin can go unsold
 *
 * Worth separating, because they are different mistakes by the player:
 *
 * - **Nobody offers it.** Demand for a cabin no operator sells is not lost — it
 *   **cascades to the next cabin down**. A route flown entirely by all-economy
 *   aircraft still carries everybody; they just all sit in economy. Losing that
 *   demand would make an all-economy market smaller than the same market with
 *   one token business seat, which is nonsense.
 * - **It is offered and full.** That is A.5's spill, and it stays *within the
 *   cabin*: a passenger denied a business seat is not automatically moved to
 *   economy. Whether they should be — a downgrade — is a real question and a
 *   separate one; modelling it here would quietly turn every spilled premium
 *   passenger into an economy booking and flatter the cabin that failed.
 */

import { CABIN_ORDER, type CabinClass, type DemandSegment } from '@tailfin/shared';

import { allocateCapacity, type CapacityResult } from './capacity';
import { computeShares, type LogitConfig, type Operator, type ShareResult } from './logit';
import { DEMAND_SEGMENTS } from './modulation';

/**
 * Balance numbers: what fraction of each segment buys each cabin.
 *
 * Every segment's row sums to 1 — a passenger buys one seat — and
 * {@link assertMixSums} enforces it rather than trusting a hand-edited table.
 */
export interface ClassMixConfig {
  propensity: Record<DemandSegment, Record<CabinClass, number>>;
}

export const DEFAULT_CLASS_MIX: ClassMixConfig = {
  propensity: {
    /**
     * The segment that buys the front of the aircraft — and still mostly does
     * not. Even on business travel most tickets are economy, because most
     * companies do not pay for anything else on a short sector. The 18% in
     * business class is what makes a premium cabin viable at all, and it is
     * concentrated on exactly the routes where the business *segment* is deep.
     */
    business: { first: 0.02, business: 0.18, premium_economy: 0.2, economy: 0.6 },
    /**
     * A.2: leisure *"cares about price, price, price"*. The premium propensity
     * is a rounding error, and that is the whole mechanic behind A.6's warning
     * — a big business cabin on a holiday route has almost nobody to sell to.
     */
    leisure: { first: 0.001, business: 0.019, premium_economy: 0.06, economy: 0.92 },
    /**
     * Flying home to see family, and paying for it themselves. Even more
     * economy-bound than leisure, and nobody flies first to visit their mother.
     */
    vfr: { first: 0, business: 0.01, premium_economy: 0.04, economy: 0.95 },
  },
};

/** Version tag. A load has to stay explicable after a retune (invariant 4). */
export const CLASS_MIX_CONFIG_VERSION = 'v1' as const;

/** What one operator sells in one cabin. */
export interface CabinOffer {
  seats: number;
  fareMinor: number;
  /**
   * A.3's `ProductScore` for this cabin specifically.
   *
   * Optional, falling back to the operator's overall score. A cabin-level
   * product is really M6-08's and M6-09's to produce — the cabin builder and
   * the seat catalogue — and this is the seam it arrives through rather than a
   * stub pretending to be one.
   */
  productScore?: number;
}

/** An operator, and what it is selling in each cabin. */
export interface ClassOperator extends Omit<Operator, 'fareMinor'> {
  cabins: Partial<Record<CabinClass, CabinOffer>>;
}

/** Where one cabin's market came from, and what happened to it. */
export interface CabinOutcome {
  cabin: CabinClass;
  /** Passengers in the market for this cabin, after any cascade. */
  pool: number;
  /**
   * Which segments that pool came from.
   *
   * The "shows why" half of the first acceptance criterion: a business cabin
   * that fills poorly on a holiday route should be explicable as *"leisure is
   * 70% of this route and 2% of them buy business"*, not as a bad number.
   */
  poolBySegment: Record<DemandSegment, number>;
  /** Demand this cabin inherited because no operator sells the cabin above it. */
  cascadedIn: number;
  /** How the logit split this cabin's market. `null` when nobody sells it. */
  shares: ShareResult | null;
  /** How that cleared against the seats on offer. `null` when nobody sells it. */
  capacity: CapacityResult | null;
}

/** One operator's result in one cabin. */
export interface OperatorCabinLoad {
  cabin: CabinClass;
  seats: number;
  fareMinor: number;
  /** Passengers carried. Fractional — see the note on rounding below. */
  passengers: number;
  /** Turned away from this cabin (A.5). */
  spilled: number;
  loadFactor: number;
  /** `passengers × fareMinor`, unrounded. M3-08 turns this into money on a flight. */
  revenueMinor: number;
}

export interface ClassAllocation {
  byCabin: readonly CabinOutcome[];
  /**
   * Per operator, per cabin — the shape a flight's load is built from.
   *
   * Figures are fractional, as everywhere else in the demand chain. Turning a
   * day's allocation into an integer `FlightLoad` for one departure is M3-08's
   * booking curve; rounding here and dividing afterwards would compound twice.
   */
  byOperator: Record<string, OperatorCabinLoad[]>;
  /** Every cabin's pool, summed. Equals the segment pools in, by construction. */
  totalPool: number;
  totalBooked: number;
  totalSpilled: number;
  totalLost: number;
}

/**
 * Every segment's propensities must sum to 1.
 *
 * Checked rather than assumed: this is a hand-edited balance table, and a row
 * summing to 0.98 would quietly delete 2% of the market with no symptom beyond
 * demand being slightly lower than it should be — the hardest kind of bug to
 * notice, because nothing looks wrong.
 */
export function assertMixSums(config: ClassMixConfig = DEFAULT_CLASS_MIX): void {
  for (const segment of DEMAND_SEGMENTS) {
    const row = config.propensity[segment];
    const total = CABIN_ORDER.reduce((sum, cabin) => sum + row[cabin], 0);
    if (Math.abs(total - 1) > 1e-9) {
      throw new Error(`${segment} cabin propensities sum to ${String(total)}, not 1`);
    }
    for (const cabin of CABIN_ORDER) {
      if (!Number.isFinite(row[cabin]) || row[cabin] < 0) {
        throw new Error(`${segment}/${cabin} propensity must be zero or more`);
      }
    }
  }
}

/** The cabins at least one operator is actually selling. */
function cabinsOnOffer(operators: readonly ClassOperator[]): Set<CabinClass> {
  const offered = new Set<CabinClass>();
  for (const operator of operators) {
    for (const cabin of CABIN_ORDER) {
      const offer = operator.cabins[cabin];
      if (offer && offer.seats > 0) offered.add(cabin);
    }
  }
  return offered;
}

/**
 * Split the day's demand into cabin markets, cascading what nobody sells.
 *
 * Walks front to back so an unsold cabin's demand lands in the next one down,
 * and an unsold *economy* — an aircraft with no cabin at all — has nowhere to
 * go and is simply not in the market.
 */
function poolsByCabin(
  segmentPools: Record<DemandSegment, number>,
  offered: ReadonlySet<CabinClass>,
  config: ClassMixConfig,
): Map<CabinClass, { pool: number; bySegment: Record<DemandSegment, number>; cascaded: number }> {
  const result = new Map<
    CabinClass,
    { pool: number; bySegment: Record<DemandSegment, number>; cascaded: number }
  >();

  let carriedBySegment: Record<DemandSegment, number> = {
    business: 0,
    leisure: 0,
    vfr: 0,
  };

  for (const cabin of CABIN_ORDER) {
    const bySegment = {} as Record<DemandSegment, number>;
    let cascaded = 0;

    for (const segment of DEMAND_SEGMENTS) {
      const own = segmentPools[segment] * config.propensity[segment][cabin];
      bySegment[segment] = own + carriedBySegment[segment];
      cascaded += carriedBySegment[segment];
    }

    if (offered.has(cabin)) {
      result.set(cabin, {
        pool: DEMAND_SEGMENTS.reduce((sum, s) => sum + bySegment[s], 0),
        bySegment,
        cascaded,
      });
      carriedBySegment = { business: 0, leisure: 0, vfr: 0 };
    } else {
      // Nobody sells it, so it falls to the next cabin down rather than
      // vanishing. See the module note on why this is not the same as spill.
      carriedBySegment = bySegment;
    }
  }

  return result;
}

/**
 * Allocate a day's demand across cabins, operators and seats (A.6).
 *
 * Runs A.3–A.4's share model and A.5's capacity clearing once per cabin, on
 * that cabin's own pool, fares and seats. Pure and deterministic like the rest
 * of the chain.
 */
export function allocateByClass(
  inputs: {
    operators: readonly ClassOperator[];
    segmentPools: Record<DemandSegment, number>;
  },
  config: ClassMixConfig = DEFAULT_CLASS_MIX,
  logitConfig?: LogitConfig,
): ClassAllocation {
  assertMixSums(config);

  const { operators, segmentPools } = inputs;
  for (const segment of DEMAND_SEGMENTS) {
    const pool = segmentPools[segment];
    if (!Number.isFinite(pool) || pool < 0) {
      throw new Error(`${segment} pool must be zero or more, got ${String(pool)}`);
    }
  }

  const offered = cabinsOnOffer(operators);
  const pools = poolsByCabin(segmentPools, offered, config);

  const byCabin: CabinOutcome[] = [];
  const byOperator: Record<string, OperatorCabinLoad[]> = Object.fromEntries(
    operators.map((o) => [o.id, [] as OperatorCabinLoad[]]),
  );

  let totalPool = 0;
  let totalBooked = 0;
  let totalSpilled = 0;
  let totalLost = 0;

  for (const cabin of CABIN_ORDER) {
    const market = pools.get(cabin);
    if (!market) continue;

    const sellers = operators.filter((o) => {
      const offer = o.cabins[cabin];
      return offer !== undefined && offer.seats > 0;
    });

    totalPool += market.pool;

    // The cabin's own logit: same model, this cabin's fares and this cabin's
    // slice of each segment.
    const shares = computeShares(
      {
        operators: sellers.map((o) => {
          const offer = o.cabins[cabin];
          if (!offer) throw new Error(`${o.id} lost its ${cabin} cabin mid-allocation`);
          return {
            id: o.id,
            fareMinor: offer.fareMinor,
            frequency: o.frequency,
            productScore: offer.productScore ?? o.productScore,
            reputation: o.reputation,
            schedFit: o.schedFit,
            loyalty: o.loyalty,
            alliance: o.alliance,
            connectionPenalty: o.connectionPenalty,
          } satisfies Operator;
        }),
        segmentPools: market.bySegment,
      },
      logitConfig,
    );

    const capacity = allocateCapacity(
      sellers.map((o) => {
        const offer = o.cabins[cabin];
        if (!offer) throw new Error(`${o.id} lost its ${cabin} cabin mid-allocation`);
        const demand = shares.totalPassengers[o.id] ?? 0;
        return {
          id: o.id,
          demand,
          seats: offer.seats,
          share: market.pool === 0 ? 1 / sellers.length : demand / market.pool,
        };
      }),
    );

    for (const row of capacity.operators) {
      const offer = operators.find((o) => o.id === row.operatorId)?.cabins[cabin];
      if (!offer) continue;
      byOperator[row.operatorId]?.push({
        cabin,
        seats: row.seats,
        fareMinor: offer.fareMinor,
        passengers: row.booked,
        spilled: row.spilled,
        loadFactor: row.loadFactor,
        revenueMinor: row.booked * offer.fareMinor,
      });
    }

    totalBooked += capacity.totalBooked;
    totalSpilled += capacity.totalSpilled;
    totalLost += capacity.lostDemand;

    byCabin.push({
      cabin,
      pool: market.pool,
      poolBySegment: market.bySegment,
      cascadedIn: market.cascaded,
      shares,
      capacity,
    });
  }

  return { byCabin, byOperator, totalPool, totalBooked, totalSpilled, totalLost };
}
