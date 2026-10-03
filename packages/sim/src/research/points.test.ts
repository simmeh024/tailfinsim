import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, type ResearchPointsFormula } from '@tailfin/shared';

import { createRng } from '../random';

import { researchPointsForFlight, researchPointsPerDay } from './points';

/**
 * §10.3's research points (M9-05).
 *
 * Two claims are worth proving, and both are the issue's: that crediting each
 * flight as it settles adds up to the design's per-**day** formula, and that a
 * large airline with no academy earns nothing however much it flies.
 */

const FORMULA = ECONOMY_CONFIG_V1.research.pointsFormula;

describe('researchPointsForFlight', () => {
  it('sums over a game day to exactly §10.3’s per-day formula', () => {
    // A day of mixed flying: many sectors of different lengths. The per-flight
    // credit is linear in block hours, so the day's sum is the formula's.
    const rng = createRng(92);
    for (let trial = 0; trial < 50; trial += 1) {
      const academyLevelSum = Math.floor(rng() * 16);
      const sectors = 1 + Math.floor(rng() * 200);
      let earned = 0;
      let blockHours = 0;
      for (let i = 0; i < sectors; i += 1) {
        const blockMinutes = 25 + rng() * 900;
        earned += researchPointsForFlight({ academyLevelSum, blockMinutes }, FORMULA);
        blockHours += blockMinutes / 60;
      }
      const day = researchPointsPerDay({ academyLevelSum, fleetBlockHours: blockHours }, FORMULA);
      expect(earned).toBeCloseTo(day, 6);
    }
  });

  it('gives a large airline with no academy nothing at all (issue #92’s second criterion)', () => {
    // 90 aircraft at 12 block hours a day, every sector of it, for a year.
    let earned = 0;
    for (let day = 0; day < 360; day += 1) {
      for (let aircraft = 0; aircraft < 90; aircraft += 1) {
        for (let sector = 0; sector < 6; sector += 1) {
          earned += researchPointsForFlight({ academyLevelSum: 0, blockMinutes: 120 }, FORMULA);
        }
      }
    }
    expect(earned).toBe(0);
  });

  it('earns a short sector a fraction of a point rather than nothing', () => {
    // 50 minutes at a Training Room: 1 × 1 × (0.83 ÷ 8) ≈ 0.104.
    const points = researchPointsForFlight({ academyLevelSum: 1, blockMinutes: 50 }, FORMULA);
    expect(points).toBeGreaterThan(0.1);
    expect(points).toBeLessThan(0.11);
  });

  it('scales with each term of the formula and with nothing else', () => {
    const base = researchPointsForFlight({ academyLevelSum: 2, blockMinutes: 240 }, FORMULA);
    expect(researchPointsForFlight({ academyLevelSum: 4, blockMinutes: 240 }, FORMULA)).toBe(
      base * 2,
    );
    expect(researchPointsForFlight({ academyLevelSum: 2, blockMinutes: 480 }, FORMULA)).toBe(
      base * 2,
    );
    const retuned: ResearchPointsFormula = {
      academyStaffQuality: FORMULA.academyStaffQuality * 3,
      scalingFactorHours: FORMULA.scalingFactorHours,
    };
    expect(researchPointsForFlight({ academyLevelSum: 2, blockMinutes: 240 }, retuned)).toBe(
      base * 3,
    );
  });

  it('refuses a negative or fractional level sum, and negative block time', () => {
    expect(() =>
      researchPointsForFlight({ academyLevelSum: -1, blockMinutes: 60 }, FORMULA),
    ).toThrow();
    expect(() =>
      researchPointsForFlight({ academyLevelSum: 1.5, blockMinutes: 60 }, FORMULA),
    ).toThrow();
    expect(() =>
      researchPointsForFlight({ academyLevelSum: 1, blockMinutes: -5 }, FORMULA),
    ).toThrow();
  });
});

describe('researchPointsPerDay at the shipped balance’s three anchors', () => {
  // The table in `SHIPPED_RESEARCH_BALANCE`'s comment, held to the numbers.
  it('pays a small airline with a Training Room five points a day', () => {
    expect(researchPointsPerDay({ academyLevelSum: 1, fleetBlockHours: 5 * 8 }, FORMULA)).toBe(5);
  });

  it('pays a mid-sized airline 187.5 and a large one 1,620', () => {
    expect(researchPointsPerDay({ academyLevelSum: 5, fleetBlockHours: 30 * 10 }, FORMULA)).toBe(
      187.5,
    );
    expect(researchPointsPerDay({ academyLevelSum: 12, fleetBlockHours: 90 * 12 }, FORMULA)).toBe(
      1_620,
    );
  });

  it('pays the large airline nothing without an academy', () => {
    expect(researchPointsPerDay({ academyLevelSum: 0, fleetBlockHours: 90 * 12 }, FORMULA)).toBe(0);
  });

  it('lets a Training Room reach a tier-1 node in weeks, and binds a large airline by the build', () => {
    const tier1 = ECONOMY_CONFIG_V1.research.nodes.cost_index_sop;
    const small = researchPointsPerDay({ academyLevelSum: 1, fleetBlockHours: 40 }, FORMULA);
    const daysToFirstNode = tier1.researchPoints / small;
    expect(daysToFirstNode).toBeGreaterThanOrEqual(7);
    expect(daysToFirstNode).toBeLessThanOrEqual(42);

    // A large airline earns a tier-2 node's points in well under a day, so the
    // build weeks — not the points — are what pace it.
    const tier2 = ECONOMY_CONFIG_V1.research.nodes.continuous_descent;
    const large = researchPointsPerDay({ academyLevelSum: 12, fleetBlockHours: 1_080 }, FORMULA);
    expect(tier2.researchPoints / large).toBeLessThan(1);
    expect(tier2.buildWeeks * 7).toBeGreaterThan(tier2.researchPoints / large);
  });
});
