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
  crewXpInWords,
  doctrineTrend,
  doctrineTrendInWords,
  durationInWords,
  effectAtStrength,
  effectInWords,
  formatGameWeeks,
  formatPercent,
  formatPoints,
  formatStrength,
  fundingFailureInWords,
  gameDaysRemaining,
  isResearchRefusal,
  progressFraction,
  remainingInWords,
} from './research-presentation';

/**
 * The research tree's words (M9-05, and M9-06's doctrine).
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

describe('doctrine (M9-06)', () => {
  const upkeep = 1_200_000;

  it('reads the trend from funding and whether the strength has settled', () => {
    expect(
      doctrineTrend({ funded: true, strength: 1, monthlyUpkeepMinor: upkeep, settlesAt: null }),
    ).toBe('full');
    expect(
      doctrineTrend({ funded: true, strength: 0.4, monthlyUpkeepMinor: upkeep, settlesAt: at(9) }),
    ).toBe('recovering');
    expect(
      doctrineTrend({ funded: false, strength: 0.6, monthlyUpkeepMinor: upkeep, settlesAt: at(9) }),
    ).toBe('lapsing');
    expect(
      doctrineTrend({ funded: false, strength: 0, monthlyUpkeepMinor: upkeep, settlesAt: null }),
    ).toBe('lapsed');
  });

  it('says how long a lapse or a recovery has left, in the world’s calendar', () => {
    const lapsing = { funded: false, strength: 0.6, monthlyUpkeepMinor: upkeep, settlesAt: at(21) };
    expect(doctrineTrendInWords(lapsing, at(0))).toBe('Lapsing — fully lapsed in 3 game weeks');
    expect(doctrineTrendInWords(lapsing, at(18))).toBe('Lapsing — fully lapsed in 3 game days');
    expect(doctrineTrendInWords(lapsing, at(30))).toBe('Lapsing — fully lapsed now');

    const recovering = { ...lapsing, funded: true, settlesAt: at(10) };
    expect(doctrineTrendInWords(recovering, at(0))).toBe(
      'Recovering — full strength in 1 game week, 3 game days',
    );
    expect(doctrineTrendInWords({ ...lapsing, strength: 0, settlesAt: null }, at(0))).toBe(
      'Fully lapsed — resume funding to rebuild it',
    );
    expect(doctrineTrendInWords({ ...recovering, strength: 1, settlesAt: null }, at(0))).toBe(
      'Full strength',
    );
  });

  it('spells a span of game days', () => {
    expect(durationInWords(18)).toBe('2 game weeks, 4 game days');
    expect(durationInWords(7)).toBe('1 game week');
    expect(durationInWords(1)).toBe('1 game day');
  });

  it('shows each effect at the strength in force, beside the full figure', () => {
    expect(effectAtStrength({ target: 'fuelBurn', fraction: 0.015 }, 0.6)).toBe(
      '−0.9% fuel burn of −1.5%',
    );
    expect(effectAtStrength({ target: 'crewXp', fraction: 0.05 }, 0.4)).toBe('+2% crew XP of +5%');
    expect(effectAtStrength({ target: 'turnaroundTime', fraction: 0.04 }, 1)).toBe(
      '−4% turnaround time of −4%',
    );
    // At nothing, words rather than "−0%".
    expect(effectAtStrength({ target: 'fuelBurn', fraction: 0.015 }, 0)).toBe(
      'None of −1.5% fuel burn',
    );
    expect(formatStrength(0.637)).toBe('64%');
  });

  it('names the crew XP cap every time the bonus is shown', () => {
    expect(crewXpInWords({ doctrine: 0.094, cap: 0.6 })).toBe(
      'Crew Development doctrine: +9.4% crew XP (shares a 60% cap with Training Captains)',
    );
    expect(crewXpInWords({ doctrine: 0, cap: 0.6 })).toBe(
      'Crew Development doctrine: no crew XP bonus in force. Its bonus shares a 60% cap with Training Captains.',
    );
  });

  it('puts a refused funding change in words', () => {
    const node = { name: 'Boarding SOP' };
    expect(fundingFailureInWords({ status: 409, code: 'not_complete', message: 'x' }, node)).toBe(
      'Not changed. Boarding SOP is still being researched, so there is no doctrine to fund until it completes.',
    );
    expect(fundingFailureInWords({ status: 404, code: 'not_found', message: 'x' }, node)).toBe(
      'Not changed. Your airline has not researched Boarding SOP, so it has no doctrine to fund.',
    );
    expect(
      fundingFailureInWords({ status: 400, code: 'invalid_input', message: 'Bad body' }, node),
    ).toBe('Not changed. Bad body');
  });
});
