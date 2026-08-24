import { describe, expect, it } from 'vitest';

import type { CrewResponse } from '@tailfin/shared';

import {
  bannerPriorityRanks,
  commonalitySummary,
  coverageSummary,
  familyCoverage,
  headcountSummary,
} from './crew-presentation';

/**
 * The Crew page's presentation folds (§21).
 *
 * Worth their own tests because they are the part that can be quietly wrong: a
 * table rendering `row.delta` is hard to break, and a coverage percentage that
 * divides by zero on a new airline is easy to — and renders as `NaN%` in the
 * largest text on the page.
 *
 * They are also where the line lives. Everything here regroups, counts or
 * divides figures the server already decided. Nothing works out what an
 * aeroplane needs; if a test here ever has to assert *"a 180-seat cabin needs
 * four"*, the rule has leaked into the browser.
 */

const costs: CrewResponse['costs'] = {
  baseOpeningMinor: 3_000_000,
  hireFlightDeckMinor: 400_000,
  hireCabinMinor: 100_000,
  conversionPerHeadMinor: 200_000,
  conversionDurationDays: 14,
  weeklyHiringCapacity: 12,
  monthlyPayrollMinor: 6_500_000,
  hotelPerHeadPerNightMinor: 15_000,
};

function state(overrides: Partial<CrewResponse> = {}): CrewResponse {
  return {
    bases: [],
    fragmentation: { families: [], totalAvailable: 0, largestFamilyAvailable: 0, strandedHeads: 0 },
    demand: { rows: [], totalRequired: 0, metRequired: 0, covered: true, uncoveredFamilies: [] },
    families: [],
    costs,
    ...overrides,
  };
}

describe('coverage', () => {
  it('is the met fraction of the requirement, not of the headcount', () => {
    /*
     * Totals hide a per-rank shortage: an airline with a surplus of cabin crew
     * and no captains sums to "enough people" and can fly nothing. `metRequired`
     * is the server's answer to that; this only divides it.
     */
    const summary = coverageSummary(
      state({
        demand: {
          rows: [],
          totalRequired: 8,
          metRequired: 6,
          covered: false,
          uncoveredFamilies: [],
        },
      }),
    );
    expect(summary.percent).toBe(75);
    expect(summary.covered).toBe(false);
  });

  it('reports no percentage at all when nothing is required', () => {
    // Not 0% and not 100%. An empty airline has nothing to be ready for, and
    // both numbers would be a claim about it.
    const summary = coverageSummary(state());
    expect(summary.percent).toBeNull();
    expect(summary.ratio).toBe(1);
  });

  it('never exceeds 100%, however much surplus there is', () => {
    const summary = coverageSummary(
      state({
        demand: {
          rows: [],
          totalRequired: 2,
          metRequired: 9,
          covered: true,
          uncoveredFamilies: [],
        },
      }),
    );
    expect(summary.percent).toBe(100);
  });

  it('counts short ranks rather than short heads', () => {
    const summary = coverageSummary(
      state({
        demand: {
          rows: [
            { family: 'A320neo', rank: 'captain', required: 4, available: 1, delta: -3 },
            { family: 'A320neo', rank: 'purser', required: 1, available: 0, delta: -1 },
            { family: 'A320neo', rank: 'cabin_crew', required: 2, available: 5, delta: 3 },
          ],
          totalRequired: 7,
          metRequired: 3,
          covered: false,
          uncoveredFamilies: [],
        },
      }),
    );
    // "2 ranks below minimum" is actionable; "short 4 people" is not.
    expect(summary.shortages).toBe(2);
  });
});

describe('headcount', () => {
  it('sums the pools but takes availability from the server', () => {
    const crew = state({
      bases: [
        {
          id: 'b1',
          airportIcao: 'EHAM',
          status: 'open',
          openedAt: '2024-10-20T00:00:00.000Z',
          conversions: [],
          duty: [],
          morale: null,
          pools: [
            {
              id: 'p1',
              family: 'A320neo',
              rank: 'captain',
              headcount: 6,
              unavailable: 2,
              onDuty: 1,
              reserve: 2,
              sick: 0,
              available: 3,
            },
          ],
        },
      ],
      fragmentation: {
        families: ['A320neo'],
        totalAvailable: 3,
        largestFamilyAvailable: 3,
        strandedHeads: 0,
      },
    });

    const heads = headcountSummary(crew);
    expect(heads.onStrength).toBe(6);
    expect(heads.inTraining).toBe(2);
    expect(heads.onDuty).toBe(1);
    expect(heads.reserve).toBe(2);
    // Not re-derived. "Available" is the server's rule and it has changed once
    // already — M5-02 added on-duty crew to what it subtracts.
    expect(heads.available).toBe(3);
  });
});

describe('commonality', () => {
  it('is a description of where the crew are, not a score', () => {
    const summary = commonalitySummary(
      state({
        fragmentation: {
          families: ['A320neo', 'ATR 72'],
          totalAvailable: 8,
          largestFamilyAvailable: 4,
          strandedHeads: 4,
        },
      }),
    );
    // 4 of 8. There is no coefficient behind this and there must not be: crew
    // rated on one family are simply not in another's pool, and the shortfall
    // already falls out of the counting.
    expect(summary.ratio).toBe(0.5);
    expect(summary.verdict).toBe('moderate');
  });

  it('calls one family what it is', () => {
    const summary = commonalitySummary(
      state({
        bases: [
          {
            id: 'b1',
            airportIcao: 'EHAM',
            status: 'open',
            openedAt: '2024-10-20T00:00:00.000Z',
            conversions: [],
            duty: [],
            morale: null,
            pools: [
              {
                id: 'p1',
                family: 'A320neo',
                rank: 'captain',
                headcount: 4,
                unavailable: 0,
                onDuty: 0,
                reserve: 0,
                sick: 0,
                available: 4,
              },
            ],
          },
        ],
        fragmentation: {
          families: ['A320neo'],
          totalAvailable: 4,
          largestFamilyAvailable: 4,
          strandedHeads: 0,
        },
      }),
    );
    expect(summary.verdict).toBe('single');
    expect(summary.bars).toHaveLength(1);
    expect(summary.bars[0]?.share).toBe(1);
  });

  it('has no opinion about an airline with no crew', () => {
    const summary = commonalitySummary(state());
    expect(summary.ratio).toBeNull();
    expect(summary.verdict).toBe('none');
    expect(summary.bars).toEqual([]);
  });
});

describe('banner priority', () => {
  it('leads with the worst shortage', () => {
    const ranks = bannerPriorityRanks(
      state({
        demand: {
          rows: [
            { family: 'A320neo', rank: 'purser', required: 2, available: 1, delta: -1 },
            { family: 'A320neo', rank: 'captain', required: 5, available: 1, delta: -4 },
            { family: 'A320neo', rank: 'cabin_crew', required: 2, available: 9, delta: 7 },
          ],
          totalRequired: 9,
          metRequired: 4,
          covered: false,
          uncoveredFamilies: [],
        },
      }),
    );
    // The picture and the number then say the same thing.
    expect(ranks[0]).toBe('captain');
    expect(ranks).not.toContain('cabin_crew');
  });

  it('is stable, so the same state never shows a different picture', () => {
    const crew = state({
      demand: {
        rows: [
          { family: 'A320neo', rank: 'purser', required: 2, available: 1, delta: -1 },
          { family: 'ATR 72', rank: 'cadet', required: 2, available: 1, delta: -1 },
        ],
        totalRequired: 4,
        metRequired: 2,
        covered: false,
        uncoveredFamilies: [],
      },
    });
    // Ties broken by the rank's own name rather than by map iteration: a page
    // that showed a different banner on every refresh would read as random.
    expect(bannerPriorityRanks(crew)).toEqual(bannerPriorityRanks(crew));
    expect(bannerPriorityRanks(crew)[0]).toBe('cadet');
  });

  it('says nothing when nothing is wrong', () => {
    expect(bannerPriorityRanks(state())).toEqual([]);
  });
});

describe('family coverage', () => {
  it('puts the families with a problem first', () => {
    const groups = familyCoverage(
      state({
        demand: {
          rows: [
            { family: 'A320neo', rank: 'captain', required: 1, available: 4, delta: 3 },
            { family: 'ATR 72', rank: 'captain', required: 3, available: 1, delta: -2 },
          ],
          totalRequired: 4,
          metRequired: 2,
          covered: false,
          uncoveredFamilies: [],
        },
      }),
    );
    expect(groups[0]?.family).toBe('ATR 72');
    expect(groups[0]?.short).toBe(true);
    expect(groups[1]?.short).toBe(false);
  });

  it('labels each row short, exact or surplus, so colour is never the only signal', () => {
    const groups = familyCoverage(
      state({
        demand: {
          rows: [
            { family: 'A320neo', rank: 'captain', required: 2, available: 2, delta: 0 },
            { family: 'A320neo', rank: 'purser', required: 2, available: 5, delta: 3 },
            { family: 'A320neo', rank: 'cabin_crew', required: 4, available: 1, delta: -3 },
          ],
          totalRequired: 8,
          metRequired: 5,
          covered: false,
          uncoveredFamilies: [],
        },
      }),
    );
    const statuses = Object.fromEntries(
      (groups[0]?.rows ?? []).map((row) => [row.rank, row.status]),
    );
    expect(statuses).toEqual({ captain: 'exact', purser: 'surplus', cabin_crew: 'short' });
  });

  it('sorts ranks by seniority rather than alphabetically', () => {
    const groups = familyCoverage(
      state({
        demand: {
          rows: [
            { family: 'A320neo', rank: 'cabin_crew', required: 1, available: 1, delta: 0 },
            { family: 'A320neo', rank: 'captain', required: 1, available: 1, delta: 0 },
            { family: 'A320neo', rank: 'first_officer', required: 1, available: 1, delta: 0 },
          ],
          totalRequired: 3,
          metRequired: 3,
          covered: true,
          uncoveredFamilies: [],
        },
      }),
    );
    expect((groups[0]?.rows ?? []).map((row) => row.rank)).toEqual([
      'captain',
      'first_officer',
      'cabin_crew',
    ]);
  });
});
