import { describe, expect, it } from 'vitest';

import {
  RESEARCH_NODES,
  ResearchEffectTarget,
  ResearchRefusal,
  type ResearchEffectTarget as Target,
} from '@tailfin/shared';

import {
  RESEARCH_EFFECT_LABELS,
  academyHeldInWords,
  academyRequirement,
  catalogueTargets,
  effectInWords,
  formatGameWeeks,
  formatPercent,
  formatPoints,
  gameDaysRemaining,
  isResearchRefusal,
  progressFraction,
  remainingInWords,
} from './research-presentation';

/**
 * The research tree's words (M9-05).
 *
 * Pure folds, so they are tested as functions: what a player reads for each
 * effect, each refusal and each countdown. Instants are derived from one
 * anchor, never written as dates that can expire.
 */

const ANCHOR = Date.UTC(2025, 0, 1);
const DAY = 86_400_000;
const at = (days: number): string => new Date(ANCHOR + days * DAY).toISOString();

describe('effects', () => {
  it('names every target a node can make better', () => {
    // A seventh efficiency quantity or a new target in the contract with no
    // label would render as "undefined" on a card.
    for (const target of ResearchEffectTarget.options) {
      expect(RESEARCH_EFFECT_LABELS[target]).toMatch(/\S/);
    }
  });

  it('reads as the change a player feels', () => {
    expect(effectInWords({ target: 'fuelBurn', fraction: 0.015 })).toBe('−1.5% fuel burn');
    expect(effectInWords({ target: 'turnaroundTime', fraction: 0.04 })).toBe('−4% turnaround time');
    expect(effectInWords({ target: 'incidentRate', fraction: 0.1 })).toBe(
      '−10% incident and delay rate',
    );
    // Crew XP is a rate research adds to, so it carries a plus; "XP" keeps its capitals.
    expect(effectInWords({ target: 'crewXp', fraction: 0.05 })).toBe('+5% crew XP');
  });

  it('trims trailing zeros from a percentage and keeps a real second decimal', () => {
    expect(formatPercent(0.04)).toBe('4%');
    expect(formatPercent(0.0125)).toBe('1.25%');
    expect(formatPercent(0.07)).toBe('7%');
  });

  it('reads an unreleased node’s targets from the catalogue', () => {
    expect(catalogueTargets('fleet_performance_optimisation')).toEqual<Target[]>([
      'fuelBurn',
      'blockTime',
    ]);
    // A capability with no modelled effect has none, rather than a guessed one.
    expect(catalogueTargets('etops_authority')).toEqual([]);
    expect(RESEARCH_NODES.filter((node) => !node.released).length).toBeGreaterThan(0);
  });
});

describe('research points', () => {
  it('shows one decimal everywhere, rounded down', () => {
    expect(formatPoints(120)).toBe('120.0');
    expect(formatPoints(42.56)).toBe('42.5');
    // Never rounded up to a cost the balance cannot meet.
    expect(formatPoints(119.96)).toBe('119.9');
    expect(formatPoints(1234.5)).toBe('1,234.5');
    expect(formatPoints(0)).toBe('0.0');
  });

  it('does not show a slow airline as earning nothing', () => {
    // §10.3: a small academy earns slowly, not never.
    expect(formatPoints(0.04)).toBe('< 0.1');
  });
});

describe('the academy requirement', () => {
  it('states the facility and its level, as the acceptance criterion words it', () => {
    expect(
      academyRequirement({ requiredAcademyName: 'Flight Academy', requiredAcademyLevel: 3 }),
    ).toBe('Requires a Flight Academy — academy level 3');
  });

  it('takes "an" before a vowel', () => {
    expect(
      academyRequirement({ requiredAcademyName: 'Elite Centre', requiredAcademyLevel: 5 }),
    ).toBe('Requires an Elite Centre — academy level 5');
  });

  it('says what the airline holds, including nothing', () => {
    expect(academyHeldInWords(0)).toBe('You have no commissioned academy');
    expect(academyHeldInWords(2)).toBe('Your highest academy is level 2');
  });
});

describe('refusal codes', () => {
  it('recognises every code in the contract and nothing else', () => {
    for (const code of ResearchRefusal.options) expect(isResearchRefusal(code)).toBe(true);
    expect(isResearchRefusal('airline_required')).toBe(false);
    expect(isResearchRefusal('toString')).toBe(false);
  });
});

describe('game-time countdowns', () => {
  it('counts whole game days, rounded up, from the world clock', () => {
    expect(gameDaysRemaining(at(0), at(18))).toBe(18);
    expect(gameDaysRemaining(at(0), at(0.25))).toBe(1);
    expect(gameDaysRemaining(at(3), at(1))).toBe(0);
    expect(gameDaysRemaining('not a date', at(1))).toBeNull();
  });

  it('says weeks and days in the world’s calendar', () => {
    expect(remainingInWords(18)).toBe('2 game weeks, 4 game days remaining');
    expect(remainingInWords(14)).toBe('2 game weeks remaining');
    expect(remainingInWords(1)).toBe('1 game day remaining');
    expect(remainingInWords(7)).toBe('1 game week remaining');
    expect(remainingInWords(0)).toBe('Due to complete');
  });

  it('pluralises a build time', () => {
    expect(formatGameWeeks(1)).toBe('1 game week');
    expect(formatGameWeeks(4)).toBe('4 game weeks');
  });

  it('measures progress between the start and the end, clamped', () => {
    expect(progressFraction(at(-10), at(18), at(0))).toBeCloseTo(10 / 28);
    expect(progressFraction(at(0), at(10), at(20))).toBe(1);
    expect(progressFraction(at(0), at(10), at(-5))).toBe(0);
    expect(progressFraction(at(10), at(10), at(5))).toBeNull();
  });
});
