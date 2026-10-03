import { describe, expect, it } from 'vitest';

import { ACADEMY_LEVELS } from './academy';
import { ECONOMY_CONFIG_V1, EconomyConfig, ResearchBalance } from './economy-config';
import { EFFICIENCY_QUANTITIES } from './efficiency';
import {
  RESEARCH_BRANCH_DEFINITIONS,
  RESEARCH_BRANCHES,
  RESEARCH_NODE_IDS,
  RESEARCH_NODES,
  researchNodesInBranch,
  researchPrerequisite,
} from './research';
import { academyLevelForResearchTier } from './research-contract';

/**
 * §10.3's tree as a table (M9-05).
 *
 * The tests worth having are about the table's shape, because the shape is what
 * the gating, the prerequisites and the readout all assume: six branches of four
 * tiers, the MVP's tiers released and nothing above them, and every effect a
 * cost, a duration or a learning rate — never demand.
 */

describe('RESEARCH_NODES', () => {
  it('is six branches of four tiers, one node per cell', () => {
    expect(RESEARCH_NODES).toHaveLength(24);
    expect(new Set(RESEARCH_NODES.map((node) => node.id)).size).toBe(24);
    expect([...RESEARCH_NODE_IDS].sort()).toEqual(RESEARCH_NODES.map((node) => node.id).sort());
    for (const branch of RESEARCH_BRANCHES) {
      expect(researchNodesInBranch(branch).map((node) => node.tier)).toEqual([1, 2, 3, 4]);
    }
    expect(RESEARCH_BRANCH_DEFINITIONS.map((row) => row.branch)).toEqual([...RESEARCH_BRANCHES]);
  });

  it('releases tiers 1 and 2, and nothing above them (issue #92: "MVP ships tiers 1-2")', () => {
    for (const node of RESEARCH_NODES) {
      expect(node.released, node.id).toBe(node.tier <= 2);
    }
  });

  it('gives every released node at least one thing it makes better', () => {
    for (const node of RESEARCH_NODES.filter((row) => row.released)) {
      expect(node.targets.length, node.id).toBeGreaterThan(0);
    }
  });

  it('targets only §10.4’s six efficiency quantities and crew XP — never demand', () => {
    // §10.4: "Boosts are operational efficiency, never demand or money
    // directly." A target outside this set is a redesign, not a new node.
    const allowed = new Set<string>([...EFFICIENCY_QUANTITIES, 'crewXp']);
    for (const node of RESEARCH_NODES) {
      for (const target of node.targets)
        expect(allowed.has(target), `${node.id} → ${target}`).toBe(true);
    }
    expect(Object.keys(ECONOMY_CONFIG_V1.boosts.ceilings).sort()).toEqual(
      [...EFFICIENCY_QUANTITIES].sort(),
    );
  });

  it('chains each tier to the one below it in the same branch', () => {
    for (const node of RESEARCH_NODES) {
      const prerequisite = researchPrerequisite(node.id);
      if (node.tier === 1) {
        expect(prerequisite).toBeNull();
      } else {
        expect(prerequisite?.branch).toBe(node.branch);
        expect(prerequisite?.tier).toBe(node.tier - 1);
      }
    }
  });
});

describe('academyLevelForResearchTier', () => {
  it('reads §10.1’s own "Research tier" column', () => {
    expect([1, 2, 3, 4].map((tier) => academyLevelForResearchTier(tier).level)).toEqual([
      1, 3, 4, 5,
    ]);
    expect(academyLevelForResearchTier(2).name).toBe('Flight Academy');
  });

  it('agrees with every academy level’s ceiling', () => {
    for (const row of ACADEMY_LEVELS) {
      // The level that opens a tier is the lowest one whose ceiling reaches it,
      // so every level opens at least its own tier and no level below the
      // opener does.
      expect(academyLevelForResearchTier(row.researchTier).level).toBeLessThanOrEqual(row.level);
    }
  });
});

// ---------------------------------------------------------------------------
// The balance (EconomyConfig.research)
// ---------------------------------------------------------------------------

const SHIPPED = ECONOMY_CONFIG_V1.research;

/** A deep copy of the shipped research balance to break on purpose. */
function draftResearch(): Record<string, unknown> & {
  nodes: Record<string, { effects: Record<string, number> }>;
} {
  return JSON.parse(JSON.stringify(SHIPPED)) as Record<string, unknown> & {
    nodes: Record<string, { effects: Record<string, number> }>;
  };
}

/** §10.4's own stacking: multiplicative, before any ceiling. */
function stacked(fractions: readonly number[]): number {
  return 1 - fractions.reduce((remaining, fraction) => remaining * (1 - fraction), 1);
}

describe('EconomyConfig.research', () => {
  it('prices every node explicitly, tiers 3 and 4 included (issue #92: "no placeholders")', () => {
    for (const node of RESEARCH_NODES) {
      const row = SHIPPED.nodes[node.id];
      expect(row.researchPoints, node.id).toBeGreaterThan(0);
      expect(Number.isInteger(row.researchPoints), node.id).toBe(true);
      expect(row.cashCostMinor, node.id).toBeGreaterThan(0);
      expect(row.buildWeeks, node.id).toBeGreaterThan(0);
    }
    expect(Object.keys(SHIPPED.nodes).sort()).toEqual([...RESEARCH_NODE_IDS].sort());
  });

  it('makes each tier dearer and slower than the one below it, in every branch', () => {
    for (const branch of RESEARCH_BRANCHES) {
      const rows = researchNodesInBranch(branch).map((node) => SHIPPED.nodes[node.id]);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.researchPoints).toBeGreaterThan(rows[i - 1]!.researchPoints);
        expect(rows[i]!.cashCostMinor).toBeGreaterThan(rows[i - 1]!.cashCostMinor);
        expect(rows[i]!.buildWeeks).toBeGreaterThan(rows[i - 1]!.buildWeeks);
      }
    }
  });

  it('gives a released node exactly the effects its catalogue entry targets', () => {
    for (const node of RESEARCH_NODES) {
      const keys = Object.keys(SHIPPED.nodes[node.id].effects).sort();
      expect(keys, node.id).toEqual(node.released ? [...node.targets].sort() : []);
    }
  });

  it('fills about 40% of each §10.4 ceiling with a branch’s two released tiers', () => {
    // Skills already reach about half of each ceiling with one veteran (M9-03).
    // Research must leave the cap to the resolver rather than reach it alone.
    const ceilings = ECONOMY_CONFIG_V1.boosts.ceilings;
    for (const quantity of EFFICIENCY_QUANTITIES) {
      const fractions = RESEARCH_NODES.filter((node) => node.released).flatMap((node) => {
        const fraction = SHIPPED.nodes[node.id].effects[quantity];
        return fraction === undefined ? [] : [fraction];
      });
      const share = stacked(fractions) / ceilings[quantity];
      expect(share, quantity).toBeGreaterThanOrEqual(0.35);
      expect(share, quantity).toBeLessThanOrEqual(0.45);
    }
  });

  it('keeps crew XP from research well under M9-04’s combined cap', () => {
    const crewXp = RESEARCH_NODES.filter((node) => node.released).reduce(
      (total, node) => total + (SHIPPED.nodes[node.id].effects.crewXp ?? 0),
      0,
    );
    expect(crewXp).toBeGreaterThan(0);
    expect(crewXp).toBeLessThanOrEqual(0.12);
  });

  it('has no field a payment could use to shorten a build or buy a point', () => {
    // §10.3: "You cannot buy RP. You cannot rush it." Held by absence: the only
    // fields are the formula, and per node a price, a wait and an effect.
    expect(Object.keys(SHIPPED).sort()).toEqual(['nodes', 'pointsFormula', 'upkeep']);
    // M9-06's upkeep: what a completed doctrine costs to keep, and how fast it
    // lapses and recovers. A cost and two periods — none of them turns money into
    // points or makes a build shorter.
    expect(Object.keys(SHIPPED.upkeep).sort()).toEqual([
      'lapseWeeks',
      'monthlyFractionOfCashCost',
      'recoveryWeeks',
    ]);
    expect(Object.keys(SHIPPED.pointsFormula).sort()).toEqual([
      'academyStaffQuality',
      'scalingFactorHours',
    ]);
    for (const node of RESEARCH_NODES) {
      expect(Object.keys(SHIPPED.nodes[node.id]).sort(), node.id).toEqual([
        'buildWeeks',
        'cashCostMinor',
        'effects',
        'researchPoints',
      ]);
    }
  });

  it('refuses an effect on a quantity the catalogue does not give that node', () => {
    // A fuel effect on Boarding SOP would be a redesign of §10.3's table arriving
    // through a balance row.
    const draft = draftResearch();
    draft.nodes.boarding_sop!.effects.fuelBurn = 0.01;
    expect(ResearchBalance.safeParse(draft).success).toBe(false);
  });

  it('refuses a released node with an effect missing', () => {
    const draft = draftResearch();
    delete draft.nodes.continuous_descent!.effects.blockTime;
    expect(ResearchBalance.safeParse(draft).success).toBe(false);
  });

  it('refuses any effect on a node outside this release', () => {
    const draft = draftResearch();
    draft.nodes.in_house_training_captains!.effects.crewXp = 0.05;
    expect(ResearchBalance.safeParse(draft).success).toBe(false);
  });

  it('refuses a payload missing a node, or naming one the tree does not have', () => {
    const missing = draftResearch();
    delete missing.nodes.reduced_aog;
    expect(ResearchBalance.safeParse(missing).success).toBe(false);

    const extra = draftResearch();
    extra.nodes.free_research = { ...extra.nodes.reduced_aog!, effects: {} };
    expect(ResearchBalance.safeParse(extra).success).toBe(false);
  });

  it('refuses a zero cost, a zero wait and an effect of 100%', () => {
    for (const mutate of [
      (draft: ReturnType<typeof draftResearch>) => {
        (draft.nodes.cost_index_sop as unknown as { researchPoints: number }).researchPoints = 0;
      },
      (draft: ReturnType<typeof draftResearch>) => {
        (draft.nodes.cost_index_sop as unknown as { cashCostMinor: number }).cashCostMinor = 0;
      },
      (draft: ReturnType<typeof draftResearch>) => {
        (draft.nodes.cost_index_sop as unknown as { buildWeeks: number }).buildWeeks = 0;
      },
      (draft: ReturnType<typeof draftResearch>) => {
        draft.nodes.cost_index_sop!.effects.fuelBurn = 1;
      },
    ]) {
      const draft = draftResearch();
      mutate(draft);
      expect(ResearchBalance.safeParse(draft).success).toBe(false);
    }
  });

  it('is filled in for a payload written before research existed', () => {
    // CLAUDE.md: a new EconomyConfig section must arrive with a default, or every
    // pinned world's settlement throws on the first read after the deploy.
    const { research: _research, ...beforeResearchExisted } = ECONOMY_CONFIG_V1;
    const parsed = EconomyConfig.parse(JSON.parse(JSON.stringify(beforeResearchExisted)));
    expect(parsed.research).toEqual(SHIPPED);
  });
});
