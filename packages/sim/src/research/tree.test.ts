import { describe, expect, it } from 'vitest';

import {
  ECONOMY_CONFIG_V1,
  RESEARCH_NODES,
  researchNode,
  type ResearchNodeId,
} from '@tailfin/shared';

import {
  activeResearchProject,
  completeResearchNodeIds,
  isResearchComplete,
  researchCompletesAt,
  researchNodeState,
  type ResearchNodeFacts,
} from './tree';

/**
 * The research node state machine (M9-05, §10.3).
 *
 * The order of the refusals is the design, so most of these tests are about
 * which reason wins when several apply — the button and the 409 have to name
 * the one thing the player can actually do next.
 */

const BALANCE = ECONOMY_CONFIG_V1.research;
/** An injected instant. Everything else is derived from it, never from a clock. */
const NOW = new Date(Date.UTC(2031, 5, 1, 12));
const DAY_MS = 24 * 60 * 60 * 1_000;

function facts(id: ResearchNodeId, overrides: Partial<ResearchNodeFacts> = {}): ResearchNodeFacts {
  const row = BALANCE.nodes[id];
  return {
    node: researchNode(id),
    cost: { researchPoints: row.researchPoints, cashCostMinor: row.cashCostMinor },
    completeNodeIds: new Set(),
    activeNodeId: null,
    highestAcademyLevel: 5,
    pointsBalance: 1_000_000,
    cashMinor: 10_000_000_000,
    ...overrides,
  };
}

describe('researchNodeState', () => {
  it('opens a tier-1 node to an airline with a Training Room and the means to pay', () => {
    expect(researchNodeState(facts('cost_index_sop', { highestAcademyLevel: 1 }))).toEqual({
      status: 'available',
      refusal: null,
      startRefusal: null,
    });
  });

  it('locks every node at an airline with no commissioned academy, naming the academy', () => {
    for (const node of RESEARCH_NODES) {
      const state = researchNodeState(facts(node.id, { highestAcademyLevel: 0 }));
      expect(state.status, node.id).toBe('locked');
      expect(state.startRefusal, node.id).toBe('academy_level');
    }
  });

  it('gates tier 2 on a Flight Academy (level 3), not on a Training Centre', () => {
    const complete = new Set<ResearchNodeId>(['cost_index_sop']);
    expect(
      researchNodeState(
        facts('continuous_descent', { highestAcademyLevel: 2, completeNodeIds: complete }),
      ).startRefusal,
    ).toBe('academy_level');
    expect(
      researchNodeState(
        facts('continuous_descent', { highestAcademyLevel: 3, completeNodeIds: complete }),
      ).startRefusal,
    ).toBeNull();
  });

  it('refuses tiers 3 and 4 as not released even to a Centre of Excellence', () => {
    // Issue #92: visible, priced, and refused. Every prerequisite complete, so
    // nothing but the release can be the reason.
    const everything = new Set(RESEARCH_NODES.filter((n) => n.released).map((n) => n.id));
    for (const node of RESEARCH_NODES.filter((n) => !n.released)) {
      const state = researchNodeState(
        facts(node.id, { highestAcademyLevel: 5, completeNodeIds: everything }),
      );
      expect(state, node.id).toEqual({
        status: 'locked',
        refusal: 'not_released',
        startRefusal: 'not_released',
      });
    }
  });

  it('names the academy, not the release, when a tier-3 node is out of reach', () => {
    // "Locked tiers show the facility level required" — the more useful answer.
    expect(
      researchNodeState(facts('tankering_doctrine', { highestAcademyLevel: 3 })).startRefusal,
    ).toBe('academy_level');
  });

  it('wants the tier below in the same branch first', () => {
    expect(researchNodeState(facts('parallel_servicing')).startRefusal).toBe('prerequisite');
    // Another branch's tier 1 does not count.
    expect(
      researchNodeState(
        facts('parallel_servicing', { completeNodeIds: new Set(['cost_index_sop']) }),
      ).startRefusal,
    ).toBe('prerequisite');
    expect(
      researchNodeState(facts('parallel_servicing', { completeNodeIds: new Set(['boarding_sop']) }))
        .startRefusal,
    ).toBeNull();
  });

  it('runs one project at a time, airline-wide, and leaves the node available', () => {
    expect(researchNodeState(facts('boarding_sop', { activeNodeId: 'cost_index_sop' }))).toEqual({
      status: 'available',
      refusal: 'project_running',
      startRefusal: 'project_running',
    });
  });

  it('marks the running node in progress and a finished one complete, with nothing to start', () => {
    expect(researchNodeState(facts('boarding_sop', { activeNodeId: 'boarding_sop' }))).toEqual({
      status: 'in_progress',
      refusal: 'already_in_progress',
      startRefusal: null,
    });
    expect(
      researchNodeState(facts('boarding_sop', { completeNodeIds: new Set(['boarding_sop']) })),
    ).toEqual({ status: 'complete', refusal: 'already_complete', startRefusal: null });
  });

  it('puts points before cash, because cash cannot buy them', () => {
    expect(
      researchNodeState(facts('line_efficiency', { pointsBalance: 99.999, cashMinor: 0 }))
        .startRefusal,
    ).toBe('insufficient_points');
    expect(
      researchNodeState(facts('line_efficiency', { pointsBalance: 100, cashMinor: 2_999_999 }))
        .startRefusal,
    ).toBe('insufficient_funds');
    expect(
      researchNodeState(facts('line_efficiency', { pointsBalance: 100, cashMinor: 3_000_000 }))
        .startRefusal,
    ).toBeNull();
  });

  it('refuses a cash-rich airline with no points, however rich', () => {
    const state = researchNodeState(
      facts('cost_index_sop', { pointsBalance: 0, cashMinor: Number.MAX_SAFE_INTEGER }),
    );
    expect(state.startRefusal).toBe('insufficient_points');
  });

  it('applies the locks before the one-at-a-time rule and the purse', () => {
    const state = researchNodeState(
      facts('signature_service', {
        highestAcademyLevel: 1,
        activeNodeId: 'cost_index_sop',
        pointsBalance: 0,
        cashMinor: 0,
      }),
    );
    expect(state.startRefusal).toBe('academy_level');
  });
});

describe('research completion is lazy, on the world’s clock', () => {
  it('completes a project exactly when the game clock reaches completes_at', () => {
    const startedAt = new Date(NOW.getTime() - 10 * DAY_MS);
    const completesAt = researchCompletesAt(startedAt, 3);
    expect(completesAt.getTime() - startedAt.getTime()).toBe(21 * DAY_MS);

    expect(isResearchComplete({ completesAt }, new Date(completesAt.getTime() - 1))).toBe(false);
    expect(isResearchComplete({ completesAt }, completesAt)).toBe(true);
    expect(isResearchComplete({ completesAt }, new Date(completesAt.getTime() + DAY_MS))).toBe(
      true,
    );
  });

  it('refuses a build of less than a whole week', () => {
    expect(() => researchCompletesAt(NOW, 0)).toThrow();
    expect(() => researchCompletesAt(NOW, 1.5)).toThrow();
  });

  it('splits an airline’s projects into complete and running by the clock alone', () => {
    const projects = [
      {
        nodeId: 'cost_index_sop' as const,
        startedAt: new Date(NOW.getTime() - 40 * DAY_MS),
        completesAt: new Date(NOW.getTime() - 19 * DAY_MS),
      },
      {
        nodeId: 'boarding_sop' as const,
        startedAt: new Date(NOW.getTime() - 5 * DAY_MS),
        completesAt: new Date(NOW.getTime() + 16 * DAY_MS),
      },
    ];
    expect([...completeResearchNodeIds(projects, NOW)]).toEqual(['cost_index_sop']);
    expect(activeResearchProject(projects, NOW)?.nodeId).toBe('boarding_sop');

    // Seventeen game days later the same rows say something else, and nothing
    // had to run for them to.
    const later = new Date(NOW.getTime() + 17 * DAY_MS);
    expect([...completeResearchNodeIds(projects, later)].sort()).toEqual([
      'boarding_sop',
      'cost_index_sop',
    ]);
    expect(activeResearchProject(projects, later)).toBeNull();
  });
});
