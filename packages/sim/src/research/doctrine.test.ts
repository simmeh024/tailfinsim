import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, EFFICIENCY_QUANTITIES, RESEARCH_NODES } from '@tailfin/shared';

import { resolveEfficiencyBoosts, type SourceBoosts } from '../economy/boosts';

import { doctrineBoosts } from './doctrine';

/**
 * Completed research as §10.4's `doctrine` source (M9-05).
 *
 * What matters is that the boosts arrive **unstacked and uncapped**, so the
 * resolver — the one place §10.4's ceiling is applied — is the only thing that
 * can turn them into a reduction.
 */

const BALANCE = ECONOMY_CONFIG_V1.research;
const RELEASED = RESEARCH_NODES.filter((node) => node.released).map((node) => node.id);

describe('doctrineBoosts', () => {
  it('gives nothing for nothing researched', () => {
    expect(doctrineBoosts([], BALANCE)).toEqual({ efficiency: {}, crewXp: 0 });
  });

  it('hands over each complete node’s effects as its own boost, at face value', () => {
    const boosts = doctrineBoosts(['cost_index_sop', 'continuous_descent'], BALANCE);
    expect(boosts.efficiency.fuelBurn).toEqual([
      { id: 'research:cost_index_sop', fraction: 0.015 },
      { id: 'research:continuous_descent', fraction: 0.018 },
    ]);
    expect(boosts.efficiency.blockTime).toEqual([
      { id: 'research:continuous_descent', fraction: 0.016 },
    ]);
    expect(boosts.crewXp).toBe(0);
  });

  it('sums Crew Development into an XP rate rather than an efficiency', () => {
    const boosts = doctrineBoosts(['efficient_conversion', 'cadet_pipeline'], BALANCE);
    expect(boosts.crewXp).toBeCloseTo(0.1, 12);
    expect(boosts.efficiency).toEqual({});
  });

  it('scales every effect by its node’s strength, for M9-06’s upkeep to plug into', () => {
    const half = doctrineBoosts(['boarding_sop', 'efficient_conversion'], BALANCE, () => 0.5);
    expect(half.efficiency.turnaroundTime).toEqual([
      { id: 'research:boarding_sop', fraction: 0.0175 },
    ]);
    expect(half.crewXp).toBeCloseTo(0.02, 12);

    const lapsed = doctrineBoosts(['boarding_sop'], BALANCE, () => 0);
    expect(lapsed.efficiency).toEqual({});
  });

  it('refuses a strength outside 0-1 rather than letting it multiply doctrine', () => {
    expect(() => doctrineBoosts(['boarding_sop'], BALANCE, () => 1.5)).toThrow();
    expect(() => doctrineBoosts(['boarding_sop'], BALANCE, () => -0.1)).toThrow();
  });

  it('ignores a node outside the release, even if it were somehow complete', () => {
    const unreleased = RESEARCH_NODES.filter((node) => !node.released).map((node) => node.id);
    expect(doctrineBoosts(unreleased, BALANCE)).toEqual({ efficiency: {}, crewXp: 0 });
  });

  it('is the same whatever order the complete nodes arrive in', () => {
    const forward = doctrineBoosts(RELEASED, BALANCE);
    const backward = doctrineBoosts([...RELEASED].reverse(), BALANCE);
    expect(backward).toEqual(forward);
  });

  it('never passes a §10.4 ceiling through the resolver, with every node and a maxed source', () => {
    // Every released node complete, plus a skills source that alone sits at
    // each ceiling: the resolver must still clip at the ceiling.
    const doctrine = doctrineBoosts(RELEASED, BALANCE).efficiency;
    const ceilings = ECONOMY_CONFIG_V1.boosts.ceilings;
    const skills: SourceBoosts = {};
    for (const quantity of EFFICIENCY_QUANTITIES) {
      skills[quantity] = [{ id: `skills:${quantity}`, fraction: ceilings[quantity] }];
    }
    const resolved = resolveEfficiencyBoosts({ doctrine, skills });
    for (const quantity of EFFICIENCY_QUANTITIES) {
      expect(resolved[quantity].fraction, quantity).toBeLessThanOrEqual(ceilings[quantity]);
      expect(resolved[quantity].capped, quantity).toBe(true);
      // And research alone stays below the ceiling: it never fills one by itself.
      expect(resolved[quantity].bySource.doctrine, quantity).toBeLessThan(ceilings[quantity]);
    }
  });
});
