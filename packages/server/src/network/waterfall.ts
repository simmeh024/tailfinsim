/**
 * Why you are losing (M3-10, App. A.9, §14.1).
 *
 * A.9 calls this the model's most important property:
 *
 * > *"The waterfall isn't an approximation of the result — it **is** the
 * > result. The UI shows this exact chart, and the player learns the game by
 * > reading it."*
 *
 * Because share is a ratio of exponentials, the difference between two
 * operators' utilities is the sum of their per-term differences, with no
 * residual. So there is no "other" line in this response, and one would be a
 * bug rather than a rounding allowance.
 *
 * ## Nothing is computed here
 *
 * `decomposeAgainst` in `@tailfin/sim` already produces A.9's table, and its
 * tests reproduce the published figures to the digit. This module runs the same
 * market resolution the fare preview runs, hands the result to that function,
 * and puts the answer on the wire.
 *
 * That matters for the same reason M3-09's preview does: a waterfall computed
 * differently from the market it explains would be a chart of something that
 * did not happen. There is one share model, and this reads it.
 *
 * ## All three segments, one request
 *
 * A.9's table is per segment. The interesting thing about a route is usually
 * that the answer *differs* between them — A.8's three airlines produce almost
 * opposite outcomes in business and leisure — and making the reader pay a round
 * trip to discover that hides the point.
 */

import type {
  CabinClass,
  FareWaterfallResponse,
  RouteRival,
  WaterfallSegment,
} from '@tailfin/shared';
import { allocateByClass, decomposeAgainst, DEMAND_SEGMENTS } from '@tailfin/sim';

import { selfAsOperator } from './fares';

import type { RouteEconomics, RouteRow } from './fares';

/** The operator id the player's own airline competes under, inside the model. */
export const YOU = 'you';

export type WaterfallResult =
  | { ok: true; waterfall: FareWaterfallResponse }
  | { ok: false; kind: 'no-rival'; rivals: RouteRival[] }
  | { ok: false; kind: 'unknown-rival'; rivals: RouteRival[] }
  | { ok: false; kind: 'cabin-not-contested'; cabin: CabinClass; rivals: RouteRival[] };

/** Who is selling this pair, and in which cabins. */
export function rivalsOn(economics: RouteEconomics): RouteRival[] {
  return economics.competitors.map((operator) => ({
    id: operator.id,
    cabins: Object.entries(operator.cabins)
      .filter(([, offer]) => (offer?.seats ?? 0) > 0)
      .map(([cabin]) => cabin as CabinClass),
  }));
}

/**
 * A.9's decomposition against one rival, in one cabin, for every segment.
 *
 * Refuses specifically rather than returning an empty chart. "There is nobody
 * to compare you to" and "that airline does not sell this cabin" are different
 * problems, and a waterfall with no bars answers neither.
 */
export function waterfallFor(
  row: RouteRow,
  economics: RouteEconomics,
  cabin: CabinClass,
  rivalId: string,
): WaterfallResult {
  const rivals = rivalsOn(economics);
  if (rivals.length === 0) {
    // No AI carriers yet (M3-12) and one player, so this is the honest state of
    // every route today rather than an error. A monopolist is not losing to
    // anyone, and there is nothing to decompose.
    return { ok: false, kind: 'no-rival', rivals };
  }

  const rival = rivals.find((r) => r.id === rivalId);
  if (!rival) return { ok: false, kind: 'unknown-rival', rivals };
  if (!rival.cabins.includes(cabin)) {
    // Carries the rival list like every other outcome, so the client can keep
    // its pickers on screen. A refusal that removed the only control able to
    // recover from it would be a dead end, and §14.1 has no dead ends in it.
    return { ok: false, kind: 'cabin-not-contested', cabin, rivals };
  }

  const allocation = allocateByClass({
    operators: [selfAsOperator(YOU, row.fares, economics), ...economics.competitors],
    segmentPools: economics.segmentPools,
  });

  const outcome = allocation.byCabin.find((c) => c.cabin === cabin);
  if (!outcome?.shares) return { ok: false, kind: 'cabin-not-contested', cabin, rivals };

  const bySegment: WaterfallSegment[] = DEMAND_SEGMENTS.map((segment) => {
    const gap = decomposeAgainst(outcome.shares!, segment, YOU, rivalId);
    const rows = outcome.shares!.bySegment[segment].operators;
    const you = rows.find((o) => o.operatorId === YOU);
    const them = rows.find((o) => o.operatorId === rivalId);

    return {
      segment,
      factors: gap.factors.map((f) => ({ factor: f.factor, delta: f.delta })),
      netDelta: gap.netDelta,
      shareRatio: gap.shareRatio,
      yourShare: you?.share ?? 0,
      theirShare: them?.share ?? 0,
    };
  });

  return {
    ok: true,
    // `rivals` rides along on the success path so the client can offer the
    // other comparisons without a second request. A.8's route has two, and
    // which one you are losing to is the whole question.
    waterfall: { routeId: row.id, cabin, rivalId, rivals, bySegment },
  };
}
