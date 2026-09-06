import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import { serviceExecution as moraleToExecution } from '../crew/morale';

import { categoryScore, DEFAULT_SERVICE } from './bands';
import { crewToPaxRatio, serviceExecutionMultiplier } from './execution';

/**
 * App. D.1's execution multiplier, and M8-04's first acceptance criterion:
 *
 * > Poor crew morale visibly drops a Tier 5 package toward its band floor.
 *
 * "Visibly" and "toward its floor" are both testable, and both are asserted
 * against the *band* rather than against the execution number — because the band
 * is what a passenger experiences and what App. A.3 reads. The appendix's own
 * worked case is the shape: chef-designed catering served by an exhausted,
 * understaffed crew *"lands at the bottom of Tier 5 — you paid €78 a head for
 * 0.85 when you could have had 1.00"*.
 */

const EXECUTION = ECONOMY_CONFIG_V1.service.execution;
const TIER_5 = DEFAULT_SERVICE.categories.catering.tiers[5]!.scoreBand;

describe('the execution multiplier', () => {
  it('is the levers themselves when they all agree', () => {
    const result = serviceExecutionMultiplier(EXECUTION, {
      crewServiceSkill: 0.8,
      crewMorale: 0.8,
      vendorQuality: 0.8,
      crewToPaxRatio: 0.8,
    });
    expect(result.execution).toBeCloseTo(0.8, 10);
    expect(result.fromFallback).toBe(false);
    expect(result.absent).toEqual([]);
  });

  it('lets the weakest lever dominate rather than averaging it away', () => {
    // Three excellent levers and one bad one. An average would give 0.775 and
    // let the good crew paper over the caterer, which App. D.1 rules out.
    const result = serviceExecutionMultiplier(EXECUTION, {
      crewServiceSkill: 1,
      crewMorale: 1,
      vendorQuality: 0.1,
      crewToPaxRatio: 1,
    });
    const mean = (1 + 1 + 0.1 + 1) / 4;
    expect(result.execution).toBeLessThan(mean);
    expect(result.execution).toBeCloseTo(0.65 * 0.1 + 0.35 * mean, 10);
  });

  it('names every lever sitting at the floor, not just the first', () => {
    const result = serviceExecutionMultiplier(EXECUTION, {
      crewServiceSkill: 0.2,
      crewMorale: 0.2,
      vendorQuality: 0.9,
      crewToPaxRatio: 0.9,
    });
    // Two things to fix is two things to say.
    expect(result.factors.filter((factor) => factor.weakest).map((f) => f.input)).toEqual([
      'crewServiceSkill',
      'crewMorale',
    ]);
  });

  it('leaves an unbuilt system out rather than scoring it zero', () => {
    // Crew service skill is §10.2's academy and does not exist. Absent must not
    // be the same as terrible, or every airline in the game sits at its floor.
    const withoutSkill = serviceExecutionMultiplier(EXECUTION, {
      crewServiceSkill: null,
      crewMorale: 0.9,
      vendorQuality: 0.9,
      crewToPaxRatio: 0.9,
    });
    const asZero = serviceExecutionMultiplier(EXECUTION, {
      crewServiceSkill: 0,
      crewMorale: 0.9,
      vendorQuality: 0.9,
      crewToPaxRatio: 0.9,
    });
    expect(withoutSkill.execution).toBeCloseTo(0.9, 10);
    expect(withoutSkill.execution).toBeGreaterThan(asZero.execution);
    expect(withoutSkill.absent).toEqual(['crewServiceSkill']);
  });

  it('does not flatter an absent lever either', () => {
    const withoutSkill = serviceExecutionMultiplier(EXECUTION, {
      crewServiceSkill: null,
      crewMorale: 0.4,
      vendorQuality: 0.4,
      crewToPaxRatio: 0.4,
    });
    const asPerfect = serviceExecutionMultiplier(EXECUTION, {
      crewServiceSkill: 1,
      crewMorale: 0.4,
      vendorQuality: 0.4,
      crewToPaxRatio: 0.4,
    });
    expect(withoutSkill.execution).toBeLessThan(asPerfect.execution);
  });

  it('falls back to the configured reference when nothing can be measured', () => {
    const result = serviceExecutionMultiplier(EXECUTION, {});
    expect(result.execution).toBe(EXECUTION.fallback);
    expect(result.fromFallback).toBe(true);
    expect(result.factors).toEqual([]);
    expect(result.absent).toHaveLength(4);
  });

  it('never escapes 0–1 whatever it is handed', () => {
    for (const value of [-5, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = serviceExecutionMultiplier(EXECUTION, { crewMorale: value });
      expect(result.execution).toBeGreaterThanOrEqual(0);
      expect(result.execution).toBeLessThanOrEqual(1);
    }
  });
});

describe('the crew-to-passenger ratio', () => {
  it('is the crew carried against the crew the cabin needs', () => {
    expect(crewToPaxRatio(3, 6)).toBeCloseTo(0.5, 10);
    expect(crewToPaxRatio(6, 6)).toBe(1);
  });

  it('does not reward carrying more crew than the cabin is designed for', () => {
    // Above the complement is deadheads, not service.
    expect(crewToPaxRatio(12, 6)).toBe(1);
  });

  it('is a question that does not apply when the cabin needs nobody', () => {
    // A freighter is not badly served; it is not served.
    expect(crewToPaxRatio(0, 0)).toBeNull();
  });
});

describe('App. D.1’s worked case — the acceptance criterion', () => {
  /**
   * Where a Tier 5 catering package lands, given a base's morale and how the
   * rest of the operation is run.
   *
   * Morale enters through M5-03's own curve, not raw. That curve runs
   * **0.7 → 1.0**, on the stated reasoning that "even a mutinous crew delivers
   * most of what was paid for". The consequence matters for reading these
   * assertions: morale on its own can never drive execution below 0.7, so it
   * cannot reach the band floor by itself. The appendix's sentence has two
   * halves — an *"exhausted, understaffed"* crew — and it takes both.
   */
  function tier5At(morale: number, ratio = 1, vendor = 1): number {
    const execution = serviceExecutionMultiplier(EXECUTION, {
      crewMorale: moraleToExecution(morale),
      crewToPaxRatio: ratio,
      vendorQuality: vendor,
    }).execution;
    return categoryScore(DEFAULT_SERVICE, 'catering', 5, execution);
  }

  const bandWidth = TIER_5.max - TIER_5.min;

  it('drops a Tier 5 package visibly toward its floor as morale falls', () => {
    const happy = tier5At(1);
    const miserable = tier5At(0);

    // Still Tier 5 — execution never leaves the band, which is M8-03's rule and
    // the reason a badly run Tier 5 still beats a perfect Tier 4.
    for (const score of [happy, miserable]) {
      expect(score).toBeGreaterThanOrEqual(TIER_5.min);
      expect(score).toBeLessThanOrEqual(TIER_5.max);
    }
    expect(miserable).toBeLessThan(happy);
    // A fifth of the band given up to morale alone, with everything else
    // faultless. Not more, because M5-03 floors a mutinous crew at 0.7 of its
    // contribution rather than at zero — a deliberate decision there, and the
    // ceiling on what this lever can do here.
    expect(happy - miserable).toBeGreaterThan(bandWidth * 0.2);
  });

  it('lands the appendix’s exhausted, understaffed crew in the bottom half of the band', () => {
    // Both halves of App. D.1's sentence: no morale, and not enough of them —
    // against a caterer doing an ordinary job. This is the airline that paid
    // €78 a head and is not getting it.
    const midpoint = (TIER_5.min + TIER_5.max) / 2;
    expect(tier5At(0, 0.25, 0.5)).toBeLessThan(midpoint);
  });

  it('moves monotonically with morale, so the lever reads as a lever', () => {
    const scores = [0, 0.25, 0.5, 0.75, 1].map((morale) => tier5At(morale));
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });

  it('still cannot let a well-run Tier 4 beat the worst-run Tier 5', () => {
    // The band rule survives execution becoming real, which is the whole reason
    // M8-03 made it an interval rather than a multiplier.
    const perfectTier4 = categoryScore(DEFAULT_SERVICE, 'catering', 4, 1);
    expect(perfectTier4).toBeLessThan(tier5At(0, 0, 0));
  });
});
