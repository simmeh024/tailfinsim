import {
  RESEARCH_NODES,
  type EfficiencyQuantity,
  type ResearchBalance,
  type ResearchEffectTarget,
  type ResearchNodeId,
} from '@tailfin/shared';

import type { EfficiencyBoost, SourceBoosts } from '../economy/boosts';

/**
 * What completed research is worth, as a §10.4 boost source (M9-05).
 *
 * The `doctrine` source `resolveEfficiencyBoosts` takes. This function hands
 * over **unstacked** boosts and nothing else: stacking them against each other,
 * against skills and Training Captains, and clipping the result at §10.4's
 * ceiling is the resolver's job, done once for every source. A caller cannot
 * apply research without going through the cap, because nothing here gives one
 * out — the same structural rule M9-03's skills follow.
 *
 * ## Not wired into settlement yet
 *
 * M9-05 computes the boost and stops. Applying doctrine to flights is M9-06,
 * which also brings §10.4's third rule — *"Doctrine lapses if you stop funding
 * it"* — through the `strength` parameter below. Until then every complete node
 * is at full strength and nothing reads the result on a flight.
 */

export interface DoctrineBoosts {
  /** Per §10.4 quantity, one boost per complete node that targets it. */
  efficiency: SourceBoosts;
  /**
   * Added to the rate crew earn XP (Crew Development), as a fraction: 0.1 is
   * ten percent more. **Summed, not capped here** — M9-04's combined XP cap
   * clamps it with the Training Captains' share, the way the resolver clamps
   * the efficiency quantities.
   */
  crewXp: number;
}

function isEfficiencyQuantity(target: ResearchEffectTarget): target is EfficiencyQuantity {
  return target !== 'crewXp';
}

/**
 * The doctrine an airline holds, as boosts.
 *
 * `strength(nodeId)` scales a node's effect, 0-1. M9-06 plugs upkeep decay in
 * here — a doctrine whose funding has lapsed is worth less — and M9-05 leaves
 * it at the default of full strength. A strength outside 0-1 is refused rather
 * than clamped: a strength above 1 would be a lever that multiplies doctrine
 * past what the world's balance says it is worth.
 *
 * Only **released** nodes contribute, and only through the effects the world's
 * balance gives them — an unreleased node has none by the schema's own rule,
 * and is skipped here as well so that a node nobody may complete can never
 * reach a flight by any route.
 */
export function doctrineBoosts(
  completeNodeIds: Iterable<ResearchNodeId>,
  balance: ResearchBalance,
  strength: (nodeId: ResearchNodeId) => number = () => 1,
): DoctrineBoosts {
  const complete = new Set(completeNodeIds);
  const efficiency: Partial<Record<EfficiencyQuantity, EfficiencyBoost[]>> = {};
  let crewXp = 0;

  // The catalogue's order, not the caller's: the same set yields the same list.
  for (const node of RESEARCH_NODES) {
    if (!complete.has(node.id) || !node.released) continue;

    const scale = strength(node.id);
    if (!Number.isFinite(scale) || scale < 0 || scale > 1) {
      throw new Error(`Doctrine strength for ${node.id} must be 0-1, got ${String(scale)}`);
    }

    const effects = balance.nodes[node.id].effects;
    for (const target of node.targets) {
      const fraction = (effects[target] ?? 0) * scale;
      if (fraction <= 0) continue;
      if (isEfficiencyQuantity(target)) {
        (efficiency[target] ??= []).push({ id: `research:${node.id}`, fraction });
      } else {
        crewXp += fraction;
      }
    }
  }

  return { efficiency, crewXp };
}
