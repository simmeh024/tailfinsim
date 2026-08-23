import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CrewResponse } from '@tailfin/shared';

import { CrewPage } from './CrewPage';

/**
 * The Crew page (M5-01, §9.2).
 *
 * Two acceptance criteria are visible here rather than in the server, and this
 * is where they are held:
 *
 *   - *"the player interacts with pool sizes and policies, never with individual
 *     rosters"* — so the page must not grow a person, ever;
 *   - *"a mixed fleet visibly fragments the crew pool and reduces availability"*
 *     — and **visibly** is the word, because §9.2's complaint is that
 *     fragmentation is quiet.
 */

const costs: CrewResponse['costs'] = {
  baseOpeningMinor: 3_000_000,
  hireFlightDeckMinor: 400_000,
  hireCabinMinor: 100_000,
  conversionPerHeadMinor: 200_000,
  conversionDurationDays: 14,
  weeklyHiringCapacity: 12,
};

function state(overrides: Partial<CrewResponse> = {}): CrewResponse {
  return {
    bases: [],
    fragmentation: {
      families: [],
      totalAvailable: 0,
      largestFamilyAvailable: 0,
      strandedHeads: 0,
    },
    costs,
    ...overrides,
  };
}

function respondWith(value: CrewResponse | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: value !== null,
        status: value === null ? 409 : 200,
        json: () => Promise.resolve(value ?? { code: 'active_world_required', message: 'no' }),
      } as Response),
    ),
  );
}

const mixedFleet = state({
  bases: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      airportIcao: 'EHAM',
      status: 'open',
      openedAt: '2024-10-20T00:00:00.000Z',
      pools: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          family: 'A320neo',
          rank: 'captain',
          headcount: 6,
          unavailable: 2,
          available: 4,
        },
        {
          id: '00000000-0000-4000-8000-000000000011',
          family: '737 MAX',
          rank: 'captain',
          headcount: 3,
          unavailable: 0,
          available: 3,
        },
      ],
      conversions: [
        {
          id: '00000000-0000-4000-8000-000000000020',
          fromFamily: 'A320neo',
          toFamily: '737 MAX',
          rank: 'captain',
          heads: 2,
          startedAt: '2024-10-20T00:00:00.000Z',
          completesAt: '2024-11-03T00:00:00.000Z',
        },
      ],
    },
  ],
  fragmentation: {
    families: ['737 MAX', 'A320neo'],
    totalAvailable: 7,
    largestFamilyAvailable: 4,
    strandedHeads: 3,
  },
});

describe('the crew page', () => {
  it('leads with what a mixed fleet is costing', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    // The numbers, not a mood: "3 cannot fly it" is the acceptance criterion
    // made visible, where a coloured badge would not be. Asserted on the
    // sentence rather than the bare digits, because "4" is also an availability
    // cell and matching that would pass for the wrong reason.
    // and asserting on a bare number would pass for the wrong reason.
    const headline = await screen.findByText(/cannot fly it/);
    expect(headline.textContent).toContain('7');
    expect(headline.textContent).toContain('4');
    expect(headline.textContent).toContain('3');
  });

  it('says fragmentation is not a penalty, because it is not one', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    // A figure that reads as a fine invites "how do I avoid the fine?", and the
    // answer is not a payment — it is flying one family.
    expect(await screen.findByText(/Not a penalty/)).toBeInTheDocument();
  });

  it('shows crew in training as still on strength', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    const rows = await screen.findAllByRole('row');
    const a320 = rows.find((row) => row.textContent?.includes('A320neo'));
    // 6 on strength, 2 in a classroom, 4 available. Netting them off would hide
    // the entire point of a conversion taking a fortnight.
    expect(a320?.textContent).toContain('6');
    expect(a320?.textContent).toContain('2');
    expect(a320?.textContent).toContain('4');
  });

  it('never names a person', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);
    await screen.findByText(/cannot fly it/);

    /*
     * The guard on the acceptance criterion. Every column is a count, a rank or
     * a family — the moment one is an identity, the page has started down the
     * road the issue exists to prevent.
     *
     * Asserted on the columns rather than by grepping the page for words like
     * "roster": the first version did that and failed on this page's own copy,
     * which says a conversion costs fourteen days *off the roster*. Prose about
     * rostering is fine; a column of people is not.
     */
    const table = screen.getAllByRole('table')[0];
    const headers = [...(table?.querySelectorAll('th') ?? [])].map((th) => th.textContent);
    expect(headers).toEqual(['Family', 'Rank', 'On strength', 'In training', 'Available']);

    // And nothing renders an identifier. A pool id reaching the page would be
    // the first crack in "counts, never people".
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('tells a player with no airline what to do first', async () => {
    respondWith(null);
    render(<CrewPage />);
    expect(await screen.findByText(/Found an airline first/)).toBeInTheDocument();
  });

  it('says an airline with no crew cannot schedule', async () => {
    respondWith(state());
    render(<CrewPage />);
    // The consequence of the legality rule, said where a player will meet it
    // rather than only in a refusal after they try.
    expect(await screen.findByText(/cannot put one on the books/)).toBeInTheDocument();
  });
});
