import { describe, expect, it } from 'vitest';

import {
  BOOST_SOURCES,
  type BoostSource,
  ECONOMY_CONFIG_V1,
  EFFICIENCY_QUANTITIES,
  type EfficiencyQuantity,
} from '@tailfin/shared';

import { createRng, type Rng } from '../random';

import {
  appliedBoosts,
  EFFICIENCY_CEILINGS,
  type EfficiencyBoost,
  emptyBoosts,
  resolveEfficiencyBoosts,
  type SourceBoosts,
} from './boosts';

/**
 * §10.4's central resolver (M9-06).
 *
 * The acceptance criterion this file owns: *"Stacking every source never
 * exceeds a cap — property-tested."* So most of it is a property test: seeded,
 * so a failure reproduces, and wide, so it searches the corners a hand-written
 * example would never think to visit — hundreds of boosts on one quantity, a
 * ceiling of zero, a world that has raised a ceiling to the top of the schema.
 */

const QUANTITIES: readonly EfficiencyQuantity[] = EFFICIENCY_QUANTITIES;

function randomBoosts(rng: Rng, count: number, label: string): EfficiencyBoost[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${label}:${String(index)}`,
    // [0, 0.95): the whole legal range short of the edge stackEfficiencyBoosts
    // refuses, and heavy enough that a handful of these clears any ceiling.
    fraction: rng() * 0.95,
  }));
}

function randomSources(rng: Rng): Partial<Record<BoostSource, SourceBoosts>> {
  const sources: Partial<Record<BoostSource, SourceBoosts>> = {};
  for (const source of BOOST_SOURCES) {
    if (rng() < 0.15) continue; // a source an airline does not hold at all
    const own: SourceBoosts = {};
    for (const quantity of QUANTITIES) {
      if (rng() < 0.25) continue; // a quantity this source does not touch
      // Mostly a few, occasionally a great many: a large roster is the realistic
      // way an airline puts hundreds of boosts on one quantity.
      const count = rng() < 0.1 ? Math.floor(rng() * 300) : Math.floor(rng() * 6);
      own[quantity] = randomBoosts(rng, count, `${source}:${quantity}`);
    }
    sources[source] = own;
  }
  return sources;
}

function randomCeilings(rng: Rng): Record<EfficiencyQuantity, number> {
  const ceilings = {} as Record<EfficiencyQuantity, number>;
  for (const quantity of QUANTITIES) {
    const roll = rng();
    // The shipped table most of the time, the schema's two edges some of it.
    ceilings[quantity] =
      roll < 0.1 ? 0 : roll < 0.2 ? 1 : roll < 0.6 ? EFFICIENCY_CEILINGS[quantity] : rng();
  }
  return ceilings;
}

describe('resolveEfficiencyBoosts — the property §10.4 calls non-negotiable', () => {
  it('never lets any combination of sources exceed a ceiling', () => {
    const rng = createRng(0x10_4c_a9);
    for (let trial = 0; trial < 2_000; trial += 1) {
      const sources = randomSources(rng);
      const ceilings = randomCeilings(rng);
      const resolved = resolveEfficiencyBoosts(sources, ceilings);

      for (const quantity of QUANTITIES) {
        const result = resolved[quantity];
        expect(result.fraction).toBeGreaterThanOrEqual(0);
        expect(result.fraction).toBeLessThanOrEqual(ceilings[quantity]);
        expect(result.fraction).toBe(Math.min(result.uncapped, ceilings[quantity]));
        expect(result.capped).toBe(result.uncapped > ceilings[quantity]);
        // A share of a cost, never more than the cost. Mathematically the stack
        // never reaches 1; three hundred boosts near 95% do round to it in
        // floating point, which is why the bound here is inclusive.
        expect(result.uncapped).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is monotone: another boost never makes an airline worse off', () => {
    const rng = createRng(0x60_0d);
    for (let trial = 0; trial < 500; trial += 1) {
      const sources = randomSources(rng);
      const before = resolveEfficiencyBoosts(sources);
      const quantity = QUANTITIES[Math.floor(rng() * QUANTITIES.length)] ?? 'fuelBurn';
      const source = BOOST_SOURCES[Math.floor(rng() * BOOST_SOURCES.length)] ?? 'skills';
      const extra = { id: 'extra', fraction: rng() * 0.5 };
      const after = resolveEfficiencyBoosts({
        ...sources,
        [source]: {
          ...sources[source],
          [quantity]: [...(sources[source]?.[quantity] ?? []), extra],
        },
      });
      expect(after[quantity].fraction).toBeGreaterThanOrEqual(before[quantity].fraction);
    }
  });

  it('has diminishing returns before the cap: the stack is less than the sum', () => {
    const rng = createRng(0xd1_5c);
    for (let trial = 0; trial < 500; trial += 1) {
      const boosts = randomBoosts(rng, 2 + Math.floor(rng() * 5), 'dr');
      const sum = boosts.reduce((total, boost) => total + boost.fraction, 0);
      const resolved = resolveEfficiencyBoosts(
        { skills: { fuelBurn: boosts } },
        { ...EFFICIENCY_CEILINGS, fuelBurn: 1 },
      );
      expect(resolved.fuelBurn.uncapped).toBeLessThanOrEqual(sum + 1e-12);
    }
  });

  it('caps the airline, not each source: three sources at the ceiling still give the ceiling', () => {
    // The failure the resolver exists to make impossible. Each source alone
    // reaches the fuel ceiling; capping them one at a time and adding would give
    // 24%. Together they give 8%.
    const atCeiling = [{ id: 'a', fraction: EFFICIENCY_CEILINGS.fuelBurn }];
    const resolved = resolveEfficiencyBoosts({
      skills: { fuelBurn: atCeiling },
      trainingCaptains: { fuelBurn: atCeiling },
      doctrine: { fuelBurn: atCeiling },
    });
    expect(resolved.fuelBurn.fraction).toBe(EFFICIENCY_CEILINGS.fuelBurn);
    expect(resolved.fuelBurn.capped).toBe(true);
    for (const source of BOOST_SOURCES) {
      expect(resolved.fuelBurn.bySource[source]).toBeCloseTo(EFFICIENCY_CEILINGS.fuelBurn, 12);
    }
  });
});

describe('resolveEfficiencyBoosts — the shape', () => {
  it('resolves all six quantities even when no source holds anything', () => {
    const resolved = resolveEfficiencyBoosts({});
    expect(Object.keys(resolved).sort()).toEqual([...QUANTITIES].sort());
    for (const quantity of QUANTITIES) {
      expect(resolved[quantity]).toMatchObject({ fraction: 0, uncapped: 0, capped: false });
      expect(appliedBoosts(resolved[quantity])).toEqual([]);
    }
  });

  it('reads the world’s own ceilings, so a retune moves the cap without a deploy', () => {
    const sources = { doctrine: { maintenanceCost: [{ id: 'm', fraction: 0.1 }] } };
    expect(resolveEfficiencyBoosts(sources).maintenanceCost.fraction).toBeCloseTo(0.1, 12);
    const tightened = { ...EFFICIENCY_CEILINGS, maintenanceCost: 0.05 };
    expect(resolveEfficiencyBoosts(sources, tightened).maintenanceCost).toMatchObject({
      fraction: 0.05,
      capped: true,
    });
  });

  it('defaults to §10.4’s shipped ceilings', () => {
    const resolved = resolveEfficiencyBoosts({});
    for (const quantity of QUANTITIES) {
      expect(resolved[quantity].ceiling).toBe(ECONOMY_CONFIG_V1.boosts.ceilings[quantity]);
    }
  });

  it('hands a consumer exactly the resolved fraction, as one boost', () => {
    const resolved = resolveEfficiencyBoosts({
      skills: { turnaroundTime: [{ id: 's', fraction: 0.05 }] },
      doctrine: { turnaroundTime: [{ id: 'd', fraction: 0.04 }] },
    });
    expect(appliedBoosts(resolved.turnaroundTime)).toEqual([
      { id: 'resolved:turnaroundTime', fraction: resolved.turnaroundTime.fraction },
    ]);
  });

  it('keys its six quantities exactly as the economy config keys its ceilings', () => {
    // A seventh ceiling added to the config without being added to the shared
    // vocabulary would be a quantity nothing could ever resolve.
    expect(Object.keys(ECONOMY_CONFIG_V1.boosts.ceilings).sort()).toEqual([...QUANTITIES].sort());
    expect(Object.keys(emptyBoosts()).sort()).toEqual([...QUANTITIES].sort());
  });
});
