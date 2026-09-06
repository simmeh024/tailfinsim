import {
  PRODUCT_SCORE_TERM_OF_CATEGORY,
  PRODUCT_SCORE_TERMS,
  SERVICE_CATEGORIES,
  selectedTier,
  type CabinClass,
  type ProductScoreTerm,
  type ServiceBalance,
  type ServicePackageContent,
} from '@tailfin/shared';

import { categoryScore } from './bands';

/**
 * `ProductScore` — the one composite, assembled once (M8-04, App. D.6, §6.4).
 *
 * ```
 * ProductScore = w_seat·seat + w_service·band_position(package, execution)
 *              + w_ife·ife + w_ground·ground
 * ```
 *
 * > Weights differ by cabin class: seat product dominates in business and first,
 * > service and price dominate in economy.
 *
 * This is the number App. A.3's utility takes as `β_prod(s) · ProductScore(i)`,
 * and M8-04's second acceptance criterion is that **nothing else computes one**.
 * `product-score-source.test.ts` is the guard on that: it scans the repository
 * for another module deriving a product score, so a second one cannot appear the
 * way the first hardcoded `0.6` did.
 *
 * ## The four terms, and where the categories go
 *
 * App. D.6 names four terms; M8-03 built seven catalogue categories. The mapping
 * is `PRODUCT_SCORE_TERM_OF_CATEGORY` in `@tailfin/shared`, and it is identity
 * rather than balance — which category *is* the in-flight-entertainment term is
 * not a number anyone tunes. The **weights** are per cabin class and live in the
 * economy config, which is the criterion "weights per class are config, not
 * code" stated as a place rather than a promise.
 *
 * ## A term with no source is renormalised away, not scored zero
 *
 * `seat` is §6.4's comfort score, and
 * [M6-09](https://github.com/simmeh024/tailfinsim/issues/65) owns the model that
 * produces it. Until then callers pass `null`, and its weight is **redistributed
 * across the terms that do have a source** rather than multiplied by zero.
 *
 * The difference is the whole airline. Scoring an unbuilt seat model as 0 would
 * cap every carrier in the game at `1 − w_seat` — which in business, where the
 * appendix says seat product dominates, is most of the available score. Every
 * airline would look bad at once, uniformly, for a reason none of them could
 * act on, and the service spending this milestone exists to make worthwhile
 * would be buying a fraction of a number nobody could move. Renormalising says
 * instead: judge them on what the game can currently see.
 */

/** What a cabin's product is made of, each 0–1 and each nullable. */
export type ProductScoreInputs = Readonly<Partial<Record<ProductScoreTerm, number | null>>>;

/** One term's contribution, so a payback table can say where the score came from. */
export interface ProductScoreContribution {
  term: ProductScoreTerm;
  /** The term's own 0–1 value. */
  value: number;
  /** The weight actually applied, after any renormalisation. */
  weight: number;
  /** `value × weight` — what this term put into the total. */
  contribution: number;
}

export interface ProductScoreResult {
  /** 0–1. The number App. A.3's utility multiplies by `β_prod`. */
  score: number;
  contributions: ProductScoreContribution[];
  /** Terms with no source yet, whose weight was redistributed. */
  absent: ProductScoreTerm[];
}

function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The catalogue's contribution to each of App. D.6's terms, for one cabin.
 *
 * Several categories map onto the `service` term — catering, amenities,
 * atmosphere, retail and the baggage policy — and they are averaged rather than
 * summed, because each is already a 0–1 band position and a sum of five of them
 * is not a score. Averaging keeps `service` on the same scale as `ife` and
 * `ground`, which is what makes the per-cabin weights comparable.
 */
export function packageTermScores(
  balance: ServiceBalance,
  content: ServicePackageContent,
  cabin: CabinClass,
  execution: number,
): Record<ProductScoreTerm, number | null> {
  const selection = content.perClass[cabin] ?? {};
  const totals = new Map<ProductScoreTerm, { sum: number; count: number }>();

  for (const category of SERVICE_CATEGORIES) {
    const term = PRODUCT_SCORE_TERM_OF_CATEGORY[category];
    const score = categoryScore(balance, category, selectedTier(selection, category), execution);
    const running = totals.get(term) ?? { sum: 0, count: 0 };
    running.sum += score;
    running.count += 1;
    totals.set(term, running);
  }

  const terms = {} as Record<ProductScoreTerm, number | null>;
  for (const term of PRODUCT_SCORE_TERMS) {
    const running = totals.get(term);
    // `seat` has no category feeding it — it is §6.4's, not App. D's — so it
    // comes back null and the caller supplies it or does not.
    terms[term] = running === undefined || running.count === 0 ? null : running.sum / running.count;
  }
  return terms;
}

/**
 * Assemble the score for one cabin.
 *
 * Weights come from the world's pinned economy config, per cabin class. They sum
 * to 1 by schema refinement, so the result is on 0–1 without a division — and
 * when a term is absent the surviving weights are rescaled to sum to 1 again,
 * which is what keeps that true.
 */
export function productScore(
  balance: ServiceBalance,
  cabin: CabinClass,
  inputs: ProductScoreInputs,
): ProductScoreResult {
  const weights = balance.productScoreWeights[cabin];

  const present: { term: ProductScoreTerm; value: number; weight: number }[] = [];
  const absent: ProductScoreTerm[] = [];
  for (const term of PRODUCT_SCORE_TERMS) {
    const raw = inputs[term];
    if (raw === undefined || raw === null) {
      absent.push(term);
      continue;
    }
    present.push({ term, value: unit(raw), weight: weights[term] });
  }

  const available = present.reduce((sum, entry) => sum + entry.weight, 0);
  if (present.length === 0 || available <= 0) {
    return { score: 0, contributions: [], absent };
  }

  const contributions = present.map(({ term, value, weight }) => {
    const rescaled = weight / available;
    return { term, value, weight: rescaled, contribution: value * rescaled };
  });

  return {
    score: unit(contributions.reduce((sum, entry) => sum + entry.contribution, 0)),
    contributions,
    absent,
  };
}

/**
 * The whole chain in one call: a package, an execution, a seat score → a number.
 *
 * The convenience the rest of the codebase should reach for, so nowhere else has
 * to know that `service` is an average of five categories or that an absent term
 * is renormalised rather than zeroed.
 */
export function productScoreForPackage(
  balance: ServiceBalance,
  args: {
    content: ServicePackageContent;
    cabin: CabinClass;
    execution: number;
    /** §6.4's comfort score, or null until M6-09 produces one. */
    seat: number | null;
  },
): ProductScoreResult {
  const terms = packageTermScores(balance, args.content, args.cabin, args.execution);
  return productScore(balance, args.cabin, { ...terms, seat: args.seat });
}
