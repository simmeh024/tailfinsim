/**
 * Who gets the passengers (M3-03, App. A.3–A.4, A.8–A.9).
 *
 * A.2 sized the market; this decides how it splits. It is the arbiter of the
 * whole game — every route decision a player makes is ultimately a bet on this
 * function — and A.1 sets four requirements it has to meet at once:
 * explainable, deterministic, no dominant strategy, cheap to compute.
 *
 * A **segmented multinomial logit** meets all four, and the third one is the
 * reason the segments exist. The same three airlines produce almost opposite
 * outcomes in leisure and business, because the coefficients differ by an order
 * of magnitude between them: leisure weights price at 3.0 and product at 0.8,
 * business does very nearly the reverse. Nobody wins everywhere, and that falls
 * out of the coefficients rather than being enforced by a rule.
 *
 * ## Exactly decomposable, which is the point
 *
 * Share is a ratio of exponentials, so the difference between two operators'
 * utilities is the sum of their per-term differences — no residual, no
 * approximation. A.9 is emphatic about what that buys:
 *
 * > *"The waterfall isn't an approximation of the result — it **is** the
 * > result."*
 *
 * So this module returns the terms, not just the answer. `decomposeAgainst`
 * produces A.9's table directly, and M3-10's waterfall reads it rather than
 * recomputing anything. A player who loses a route can be shown exactly why,
 * which is CONTRIBUTING invariant 4 and §14.1's no-dead-end-numbers rule at the
 * one place in the game where it matters most.
 *
 * ## Softmax, computed the stable way
 *
 * `exp(U)` overflows for a large enough utility, and utilities are sums of
 * config-tuned coefficients — nothing stops a retune producing one. Subtracting
 * the maximum utility before exponentiating is algebraically identical (the
 * constant cancels in the ratio) and cannot overflow, because the largest
 * exponent becomes exactly 0. It costs one pass and removes a whole class of
 * failure that would otherwise appear only after a balance change.
 *
 * ## What is not here
 *
 * Spill and recapture are A.5 and M3-05: this returns *demand*, which is not
 * bookings — an operator can be allocated more passengers than it has seats,
 * and resolving that is deliberately a later step. Connection enumeration is
 * A.14 and M3-07. `SchedFit` is M3-04. Loyalty and Alliance are post-MVP.
 *
 * All four appear in A.3's formula, so all four are accepted as inputs and
 * default to zero. That way M3-04 supplies a `schedFit` rather than changing
 * this signature, and a post-MVP loyalty term is a coefficient rather than a
 * rewrite.
 */

import type { DemandSegment } from '@tailfin/shared';

import { DEMAND_SEGMENTS } from './modulation';

/**
 * A.3's coefficients for one segment.
 *
 * A.3 calls these *"the entire game balance"* and says outright that they
 * belong in a config file that can be tuned live, never hard-coded — which is
 * CONTRIBUTING invariant 3, arrived at independently.
 */
export interface SegmentBetas {
  /** How much a fare premium hurts. Leisure 3.0, business 1.1 — the master dial (A.11). */
  price: number;
  /** How much a better cabin helps. */
  product: number;
  /** Applied to `ln(frequency)`, so the fifth daily departure buys less than the fourth. */
  frequency: number;
  /** How much matching the segment's preferred departure times helps (M3-04). */
  schedule: number;
  /** How much being reliable helps. */
  reputation: number;
  /**
   * Frequent-flyer stickiness (App. E.5). Post-MVP, so zero.
   *
   * Present as a coefficient rather than absent so that turning loyalty on is a
   * config change. A.3's formula has the term; the balance table does not yet
   * give it a number.
   */
  loyalty: number;
}

export interface LogitConfig {
  beta: Record<DemandSegment, SegmentBetas>;
}

/**
 * A.3's starting coefficients, verbatim.
 *
 * The ordering across the row is the whole model. Leisure weights price nearly
 * four times as heavily as business does, and business weights product nearly
 * three times as heavily as leisure — which is why an LCC takes 65% of leisure
 * on the A.8 route while a legacy carrier takes 41% of business *at double the
 * fare*.
 *
 * VFR gets its own column here, as A.3 specifies. A.8's *totals* line models
 * VFR on the leisure betas instead, and says so; `logit.test.ts` reproduces
 * both and shows the difference is the config rather than the engine.
 */
export const DEFAULT_LOGIT: LogitConfig = {
  beta: {
    //        price  product  freq  sched  rep   loyalty
    business: {
      price: 1.1,
      product: 2.2,
      frequency: 1.6,
      schedule: 1.0,
      reputation: 1.4,
      loyalty: 0,
    },
    leisure: {
      price: 3.0,
      product: 0.8,
      frequency: 0.9,
      schedule: 0.4,
      reputation: 0.5,
      loyalty: 0,
    },
    vfr: { price: 2.4, product: 0.6, frequency: 0.8, schedule: 0.4, reputation: 0.7, loyalty: 0 },
  },
};

/** Version tag. A share has to stay explicable after a retune (invariant 4). */
export const LOGIT_CONFIG_VERSION = 'v1' as const;

/** One operator's offer on one route, for one in-game day. */
export interface Operator {
  /** Stable identity — an airline id in the server, anything unique in a test. */
  id: string;
  /** The fare being charged, in integer minor units. */
  fareMinor: number;
  /** Daily departures. At least one, or the operator is not in this market. */
  frequency: number;
  /** A.3's 0–1 composite: seat product, pitch, IFE, catering, crew service. */
  productScore: number;
  /** §15's compound reputation, 0.00–1.00. */
  reputation: number;
  /** How well departure times suit the segment (M3-04). Per segment, because business and leisure want different things. */
  schedFit?: Partial<Record<DemandSegment, number>>;
  /** Frequent-flyer stickiness (App. E.5). Post-MVP. */
  loyalty?: number;
  /** Codeshare/feed bonus (§17). Post-MVP. Enters utility directly, not through a beta. */
  alliance?: Partial<Record<DemandSegment, number>>;
  /**
   * One-stop penalty (§8.2, A.14). M3-07.
   *
   * Subtracted directly rather than scaled by a coefficient, as A.3 writes it —
   * the segment difference lives in the penalty itself, because business is
   * penalised heavily and leisure mildly.
   */
  connectionPenalty?: Partial<Record<DemandSegment, number>>;
}

/**
 * Every term that produced one utility, kept separate.
 *
 * This is not diagnostics bolted on afterwards — it is what makes A.9's
 * waterfall exact. The sum of these is the utility, checked by test.
 */
export interface UtilityTerms {
  price: number;
  product: number;
  frequency: number;
  schedule: number;
  reputation: number;
  loyalty: number;
  alliance: number;
  connectionPenalty: number;
}

export interface OperatorShare {
  operatorId: string;
  /** Operator fare ÷ market average fare. 1.0 means charging exactly the market rate. */
  priceRel: number;
  terms: UtilityTerms;
  /** The sum of `terms`. */
  utility: number;
  /** This operator's share of the segment, 0–1. Shares within a segment sum to 1. */
  share: number;
  /**
   * Passengers who want this operator today.
   *
   * **Demand, not bookings.** A.5 is explicit that the two differ, and spill is
   * M3-05's to resolve — this figure can exceed the seats on offer.
   */
  passengers: number;
}

export interface SegmentResult {
  segment: DemandSegment;
  /** The segment's share of the day's pool, from M3-02. */
  pool: number;
  operators: readonly OperatorShare[];
}

export interface ShareResult {
  /** The mean fare across operators, in minor units — the denominator of `PriceRel`. */
  marketFareMinor: number;
  bySegment: Record<DemandSegment, SegmentResult>;
  /** Each operator's passengers summed across every segment. */
  totalPassengers: Record<string, number>;
}

export interface ShareInputs {
  operators: readonly Operator[];
  /**
   * Today's pool per segment, from M3-02's `modulateDemand`.
   *
   * Taken per segment rather than as a total plus a mix, because that is what
   * modulation produces and re-deriving the mix from it would lose precision
   * for no gain.
   */
  segmentPools: Record<DemandSegment, number>;
}

/**
 * The market's average fare — the denominator of `PriceRel`.
 *
 * A plain mean across operators, which is what A.8 computes: three fares of
 * €95, €69 and €140 give €101.33, and every `PriceRel` in the worked example
 * follows from it.
 *
 * A capacity- or frequency-weighted mean would arguably model the real market
 * better, since a twice-daily operator sets the price a passenger actually sees
 * more than a weekly one does. A.8 fixes the unweighted form, so that is what
 * this implements; A.11 lists the tuning levers and this is not among them, so
 * changing it would be a model change rather than a retune and belongs in its
 * own issue.
 */
export function marketFare(operators: readonly Operator[]): number {
  if (operators.length === 0) {
    throw new Error('A market needs at least one operator');
  }
  return operators.reduce((total, o) => total + o.fareMinor, 0) / operators.length;
}

function assertOperators(operators: readonly Operator[]): void {
  if (operators.length === 0) {
    throw new Error('A market needs at least one operator');
  }

  const seen = new Set<string>();
  for (const o of operators) {
    if (seen.has(o.id)) {
      throw new Error(`Duplicate operator ${o.id} in the same market`);
    }
    seen.add(o.id);

    if (!Number.isFinite(o.fareMinor) || o.fareMinor <= 0) {
      throw new Error(`Operator ${o.id} must charge a positive fare, got ${String(o.fareMinor)}`);
    }
    // `ln(0)` is -Infinity, which would silently give a zero share rather than
    // an error. An operator with no departures is not in this market at all and
    // should not have been passed in.
    if (!Number.isFinite(o.frequency) || o.frequency < 1) {
      throw new Error(`Operator ${o.id} must fly at least once, got ${String(o.frequency)}`);
    }
    if (!Number.isFinite(o.productScore) || o.productScore < 0 || o.productScore > 1) {
      throw new Error(`Operator ${o.id} product score must be 0–1, got ${String(o.productScore)}`);
    }
    if (!Number.isFinite(o.reputation) || o.reputation < 0 || o.reputation > 1) {
      throw new Error(`Operator ${o.id} reputation must be 0–1, got ${String(o.reputation)}`);
    }
  }
}

/**
 * A.3's utility for one operator in one segment, term by term.
 *
 * Exported because the decomposition is a first-class output, not an internal
 * step — M3-10's waterfall and any "why am I losing" surface read these.
 */
export function utilityTerms(
  operator: Operator,
  segment: DemandSegment,
  priceRel: number,
  config: LogitConfig = DEFAULT_LOGIT,
): UtilityTerms {
  const beta = config.beta[segment];

  return {
    price: -beta.price * priceRel,
    product: beta.product * operator.productScore,
    frequency: beta.frequency * Math.log(operator.frequency),
    schedule: beta.schedule * (operator.schedFit?.[segment] ?? 0),
    reputation: beta.reputation * operator.reputation,
    loyalty: beta.loyalty * (operator.loyalty ?? 0),
    alliance: operator.alliance?.[segment] ?? 0,
    connectionPenalty: -(operator.connectionPenalty?.[segment] ?? 0),
  };
}

/** The sum of the terms, which is the utility. */
export function totalUtility(terms: UtilityTerms): number {
  return (
    terms.price +
    terms.product +
    terms.frequency +
    terms.schedule +
    terms.reputation +
    terms.loyalty +
    terms.alliance +
    terms.connectionPenalty
  );
}

/**
 * A.4's softmax, computed by subtracting the maximum utility first.
 *
 * Algebraically identical — the constant cancels top and bottom — and it cannot
 * overflow, because the largest exponent is exactly 0. See the module note.
 */
function softmax(utilities: readonly number[]): number[] {
  const max = Math.max(...utilities);
  const weights = utilities.map((u) => Math.exp(u - max));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => w / total);
}

/**
 * Split one day's demand between competing operators (A.3–A.4).
 *
 * Pure and deterministic, as A.1 requires: the same market on the same day
 * always produces the same split. Randomness in this game lives in disruption
 * events, never here — *"players must be able to plan."*
 */
export function computeShares(
  inputs: ShareInputs,
  config: LogitConfig = DEFAULT_LOGIT,
): ShareResult {
  const { operators, segmentPools } = inputs;
  assertOperators(operators);

  const fare = marketFare(operators);
  const priceRel = new Map(operators.map((o) => [o.id, o.fareMinor / fare]));

  const bySegment = {} as Record<DemandSegment, SegmentResult>;
  const totalPassengers: Record<string, number> = Object.fromEntries(
    operators.map((o) => [o.id, 0]),
  );

  for (const segment of DEMAND_SEGMENTS) {
    const pool = segmentPools[segment];
    if (!Number.isFinite(pool) || pool < 0) {
      throw new Error(`${segment} pool must be zero or more, got ${String(pool)}`);
    }

    const terms = operators.map((o) => utilityTerms(o, segment, priceRel.get(o.id) ?? 1, config));
    const utilities = terms.map(totalUtility);
    const shares = softmax(utilities);

    const rows: OperatorShare[] = operators.map((o, i) => {
      const share = shares[i] ?? 0;
      return {
        operatorId: o.id,
        priceRel: priceRel.get(o.id) ?? 1,
        terms: terms[i] ?? utilityTerms(o, segment, 1, config),
        utility: utilities[i] ?? 0,
        share,
        passengers: pool * share,
      };
    });

    for (const row of rows) {
      totalPassengers[row.operatorId] = (totalPassengers[row.operatorId] ?? 0) + row.passengers;
    }

    bySegment[segment] = { segment, pool, operators: rows };
  }

  return { marketFareMinor: fare, bySegment, totalPassengers };
}

/** One line of A.9's waterfall: how much of the gap this factor explains. */
export interface FactorGap {
  factor: keyof UtilityTerms;
  /** Subject's term minus the rival's. Negative means the rival is better on this factor. */
  delta: number;
}

export interface Decomposition {
  subjectId: string;
  rivalId: string;
  segment: DemandSegment;
  /** Ordered by absolute size, so the biggest cause of the gap reads first. */
  factors: readonly FactorGap[];
  /** The sum of `factors`, and exactly the utility gap — no residual. */
  netDelta: number;
  /**
   * `exp(netDelta)`, which is the ratio of the two shares.
   *
   * A.9's closing line: a net gap of −0.988 gives 0.372, and 24.3% ÷ 65.4% is
   * that same 0.372. The waterfall *is* the result.
   */
  shareRatio: number;
}

/**
 * A.9's "why am I losing" table for one segment.
 *
 * Because share is a ratio of exponentials, the utility gap decomposes exactly:
 * no residual term, no approximation, and the sum of the rows reproduces the
 * share ratio precisely. That property is the reason the model was chosen, so
 * it is asserted in the tests rather than assumed.
 */
export function decomposeAgainst(
  result: ShareResult,
  segment: DemandSegment,
  subjectId: string,
  rivalId: string,
): Decomposition {
  const rows = result.bySegment[segment].operators;
  const subject = rows.find((r) => r.operatorId === subjectId);
  const rival = rows.find((r) => r.operatorId === rivalId);

  if (!subject) throw new Error(`No operator ${subjectId} in this market`);
  if (!rival) throw new Error(`No operator ${rivalId} in this market`);

  const keys = Object.keys(subject.terms) as (keyof UtilityTerms)[];
  const factors = keys
    .map((factor) => ({ factor, delta: subject.terms[factor] - rival.terms[factor] }))
    // Zero-delta factors are noise in a waterfall — two operators with no
    // alliance bonus should not produce a row saying so.
    .filter((f) => f.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const netDelta = factors.reduce((sum, f) => sum + f.delta, 0);

  return {
    subjectId,
    rivalId,
    segment,
    factors,
    netDelta,
    shareRatio: Math.exp(netDelta),
  };
}
