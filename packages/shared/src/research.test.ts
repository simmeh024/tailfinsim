import { describe, expect, it } from 'vitest';

import { ACADEMY_LEVELS } from './academy';
import { ECONOMY_CONFIG_V1 } from './economy-config';
import { EFFICIENCY_QUANTITIES } from './efficiency';
import {
  academyLevelForResearchTier,
  RESEARCH_BRANCH_DEFINITIONS,
  RESEARCH_BRANCHES,
  RESEARCH_NODE_IDS,
  RESEARCH_NODES,
  researchNodesInBranch,
  researchPrerequisite,
} from './research';

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
