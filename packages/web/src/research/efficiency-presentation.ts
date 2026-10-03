import {
  BOOST_SOURCES,
  type BoostSource,
  EFFICIENCY_QUANTITY_LABELS,
  type EfficiencyQuantityReadout,
} from '@tailfin/shared';

/**
 * How §10.4's six efficiency quantities read on the page (M9-06).
 *
 * Pure, so the arithmetic the bar draws is tested without a renderer.
 */

/** What each source is called where the player reads it. */
export const BOOST_SOURCE_LABELS: Record<BoostSource, string> = {
  skills: 'Crew skills',
  trainingCaptains: 'Training Captains',
  doctrine: 'Doctrine',
};

/** A reduction as the player reads it: `0.032` → `−3.2%`. Zero is `0%`, not `−0%`. */
export function formatReduction(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  const percent = fraction * 100;
  const places = percent < 10 ? 1 : 0;
  return `−${percent.toFixed(places)}%`;
}

export interface SourceShare {
  source: BoostSource;
  label: string;
  /** This source's own stack, alone and before the ceiling. */
  alone: number;
  /** Its share of what is actually applied, so the shares sum to `fraction`. */
  applied: number;
}

/**
 * Each source's share of what the ceiling let through.
 *
 * The sources stack **multiplicatively** — `1 − total = Π(1 − sᵢ)` — so their
 * own figures do not add up to the total, and drawing them side by side at face
 * value would draw a bar longer than the boost. Logarithms turn the product
 * into a sum: `−ln(1 − total) = Σ −ln(1 − sᵢ)`, so each source's share of the
 * stack is exactly `−ln(1 − sᵢ) / Σ −ln(1 − sⱼ)`. That share of the applied
 * fraction is what the source is drawn as, which makes the segments sum to the
 * figure printed beside them — before the ceiling or after it.
 */
export function sourceShares(readout: EfficiencyQuantityReadout): SourceShare[] {
  const weights = BOOST_SOURCES.map((source) => {
    const alone = readout.bySource[source];
    // `log1p` keeps the precision a 1% boost needs; the clamp keeps a source that
    // rounded to the whole cost finite. A source holding nothing weighs exactly 0.
    const weight = alone > 0 ? -Math.log1p(-Math.min(alone, 1 - 1e-12)) : 0;
    return { source, alone, weight };
  });
  const total = weights.reduce((sum, row) => sum + row.weight, 0);
  return weights.map(({ source, alone, weight }) => ({
    source,
    label: BOOST_SOURCE_LABELS[source],
    alone,
    applied: total > 0 ? (readout.fraction * weight) / total : 0,
  }));
}

/** How full the bar is: the applied fraction against the ceiling, 0–1. */
export function ceilingFill(readout: EfficiencyQuantityReadout): number {
  if (readout.ceiling <= 0) return 0;
  return Math.min(1, readout.fraction / readout.ceiling);
}

/**
 * The one sentence a quantity needs beyond its number.
 *
 * At the ceiling the sentence is the decision a player can act on — *"another
 * boost here buys nothing"* — rather than a bar that has silently stopped moving.
 */
export function quantitySummary(readout: EfficiencyQuantityReadout): string {
  const label = EFFICIENCY_QUANTITY_LABELS[readout.quantity].toLowerCase();
  if (readout.fraction <= 0) return `Nothing reduces ${label} yet.`;
  if (readout.capped) {
    return (
      `At the ${formatReduction(readout.ceiling)} ceiling: your sources would give ` +
      `${formatReduction(readout.uncapped)}, so another boost here buys nothing.`
    );
  }
  return `${formatReduction(readout.fraction)} of a ${formatReduction(readout.ceiling)} ceiling.`;
}
