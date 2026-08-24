import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrewBaseView, CrewResponse } from '@tailfin/shared';

import { ContextSelectionProvider, useContextSelection } from '../shell/context-selection';

import { CrewPage } from './CrewPage';

import type { ReactNode } from 'react';

/**
 * Stands in for the shell's context panel.
 *
 * The provider stores a selection; `AppShell` is what renders it. A page test
 * that mounted the whole shell to see the panel would be a shell test, so this
 * renders the same two things the panel does — the title and the body — and
 * nothing else.
 */
function ContextProbe(): ReactNode {
  const { selection } = useContextSelection();
  if (selection === null) return null;
  return (
    <aside aria-label="Context">
      <h2>{selection.title}</h2>
      {selection.body}
    </aside>
  );
}

/**
 * The Crew operations centre (M5-01, M5-02, §9.2).
 *
 * Three claims are worth more than the rest and each has a test that fails if it
 * stops being true:
 *
 *   - **the page never overstates the simulation.** Coverage is a *minimum
 *     requirement*, never "all flights covered today", and an airline with
 *     nothing to cover gets a dash rather than 100%;
 *   - **no crew member has a name.** M5-01: *"if they have to hand-roster 400
 *     flight attendants, the feature has failed"*;
 *   - **nothing on the page decides anything.** Every figure is the server's, and
 *     an action calls the existing mutation rather than a new one.
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

function base(overrides: Partial<CrewBaseView> = {}): CrewBaseView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    airportIcao: 'EHAM',
    status: 'open',
    openedAt: '2024-10-20T00:00:00.000Z',
    pools: [],
    conversions: [],
    duty: [],
    ...overrides,
  };
}

function state(overrides: Partial<CrewResponse> = {}): CrewResponse {
  return {
    bases: [],
    fragmentation: { families: [], totalAvailable: 0, largestFamilyAvailable: 0, strandedHeads: 0 },
    demand: { rows: [], totalRequired: 0, metRequired: 0, covered: true, uncoveredFamilies: [] },
    families: ['A320neo', '737 MAX', 'ATR 72'],
    costs,
    ...overrides,
  };
}

function pool(over: Partial<CrewResponse['bases'][number]['pools'][number]> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    family: 'A320neo',
    rank: 'captain' as const,
    headcount: 4,
    unavailable: 0,
    onDuty: 0,
    reserve: 0,
    available: 4,
    ...over,
  };
}

/** An airline short of captains on one family and comfortable on another. */
const MIXED = state({
  bases: [
    base({
      pools: [
        pool({ id: 'p1', family: 'A320neo', rank: 'captain', headcount: 4, available: 4 }),
        pool({
          id: 'p2',
          family: 'ATR 72',
          rank: 'captain',
          headcount: 3,
          unavailable: 1,
          onDuty: 1,
          reserve: 1,
          available: 1,
        }),
      ],
    }),
  ],
  fragmentation: {
    families: ['A320neo', 'ATR 72'],
    totalAvailable: 5,
    largestFamilyAvailable: 4,
    strandedHeads: 1,
  },
  demand: {
    rows: [
      { family: 'A320neo', rank: 'captain', required: 2, available: 4, delta: 2 },
      { family: 'ATR 72', rank: 'captain', required: 3, available: 1, delta: -2 },
    ],
    totalRequired: 5,
    metRequired: 3,
    covered: false,
    uncoveredFamilies: [],
  },
});

function respondWith(value: CrewResponse | null, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      // The page also asks for the world clock. Answering 404 exercises the
      // branch where progress cannot be computed, which is the honest default.
      if (typeof path === 'string' && path.includes('/api/world/clock')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        } as Response);
      }
      return Promise.resolve({
        ok: value !== null && status === 200,
        status: value === null ? 409 : status,
        json: () => Promise.resolve(value ?? { code: 'active_world_required', message: 'no' }),
      } as Response);
    }),
  );
}

function renderPage(): void {
  render(
    <ContextSelectionProvider>
      <CrewPage />
      <ContextProbe />
    </ContextSelectionProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('what the page claims', () => {
  it('calls coverage a minimum requirement, never a day of flights', async () => {
    respondWith(MIXED);
    renderPage();

    /*
     * The wording is load-bearing. Required is one departure per aeroplane owned
     * — a floor. Duty and rest are modelled as of M5-02; rostering is not, so
     * the page cannot say anything about "today's flights" and must not try.
     */
    expect(await screen.findByText(/Below minimum requirement/)).toBeInTheDocument();
    expect(screen.queryByText(/all flights covered/i)).not.toBeInTheDocument();
  });

  it('keeps the floor explanation on the page, not buried in a tooltip', async () => {
    respondWith(MIXED);
    renderPage();
    // `textContent` rather than a text matcher: the sentence is broken up by a
    // `<strong>`, which testing-library treats as three separate text nodes.
    const table = await screen.findByRole('table', { name: /Required is/ });
    const caption = table.querySelector('caption')?.textContent ?? '';
    expect(caption).toMatch(/one departure per aeroplane you own/i);
    expect(caption).toMatch(/floor, not a roster/i);
    expect(caption).toMatch(/rostering is not/i);
  });

  it('shows a dash rather than 100% when there is nothing to cover', async () => {
    // A new airline requires nothing. "0%" and "100%" are both claims about an
    // airline that has nothing to be ready for.
    respondWith(state());
    renderPage();
    expect(await screen.findByText('Nothing to cover yet')).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });

  it('says coverage is unknown when the crew API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/unknown/i);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});

describe('coverage', () => {
  it('groups by family and marks the short one', async () => {
    respondWith(MIXED);
    renderPage();

    const table = await screen.findByRole('table', { name: /Required is/ });
    expect(within(table).getByText('A320neo')).toBeInTheDocument();
    expect(within(table).getByText('ATR 72')).toBeInTheDocument();
    expect(within(table).getByText('short')).toBeInTheDocument();
  });

  it('says surplus, exact and shortage in words as well as colour', async () => {
    respondWith(
      state({
        demand: {
          rows: [
            { family: 'A320neo', rank: 'captain', required: 2, available: 4, delta: 2 },
            { family: 'A320neo', rank: 'first_officer', required: 2, available: 2, delta: 0 },
            { family: 'A320neo', rank: 'cabin_crew', required: 4, available: 1, delta: -3 },
          ],
          totalRequired: 8,
          metRequired: 5,
          covered: false,
          uncoveredFamilies: [],
        },
      }),
    );
    renderPage();

    // App. H.7: a red cell and a green cell are the same cell to a good
    // proportion of players.
    const table = await screen.findByRole('table', { name: /Required is/ });
    expect(within(table).getByText('+2')).toBeInTheDocument();
    expect(within(table).getByText('Exact')).toBeInTheDocument();
    expect(within(table).getByText('-3')).toBeInTheDocument();
  });

  it('counts the ranks that are short, not the heads', async () => {
    respondWith(MIXED);
    renderPage();
    const shortages = await screen.findByText('1 rank below its minimum');
    expect(shortages).toBeInTheDocument();
  });
});

describe('commonality', () => {
  it('reports where the crew are, without inventing a score', async () => {
    respondWith(MIXED);
    renderPage();

    // 4 of 5 available crew are on the largest family. The percentage is that
    // division and nothing else — there is no penalty coefficient behind it.
    expect(await screen.findByText('80%')).toBeInTheDocument();
    expect(screen.getByText(/4 of 5 available crew/)).toBeInTheDocument();
    expect(screen.getByText(/Mixed fleet: focused/)).toBeInTheDocument();
    expect(screen.getByText(/Not a penalty/)).toBeInTheDocument();
  });

  it('says so plainly when one family covers everything', async () => {
    respondWith(
      state({
        bases: [base({ pools: [pool()] })],
        fragmentation: {
          families: ['A320neo'],
          totalAvailable: 4,
          largestFamilyAvailable: 4,
          strandedHeads: 0,
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('Single family')).toBeInTheDocument();
  });
});

describe('the base table', () => {
  it('shows duty and standby beside training, because the fixes differ', async () => {
    respondWith(MIXED);
    renderPage();

    const table = await screen.findByRole('table', { name: 'Crew at EHAM' });
    const headers = [...table.querySelectorAll('th[scope="col"]')].map((th) => th.textContent);
    expect(headers).toEqual(['Rank', 'On strength', 'Training', 'On duty', 'Standby', 'Available']);
  });

  it('filters to shortages using the server’s own verdict', async () => {
    respondWith(MIXED);
    renderPage();

    await screen.findByRole('table', { name: 'Crew at EHAM' });
    fireEvent.click(screen.getByLabelText('Shortages only'));

    const table = screen.getByRole('table', { name: 'Crew at EHAM' });
    // Only the ATR captains are short. A filter that disagreed with the coverage
    // table above would be worse than no filter.
    expect(within(table).getByText('ATR 72')).toBeInTheDocument();
    expect(within(table).queryByText('A320neo')).not.toBeInTheDocument();
  });

  it('offers a base to open when there are none', async () => {
    respondWith(state());
    renderPage();
    expect(await screen.findByText(/No crew bases yet/)).toBeInTheDocument();
  });
});

describe('the context panel', () => {
  it('fills when a coverage row is chosen, without navigating', async () => {
    respondWith(MIXED);
    renderPage();

    const table = await screen.findByRole('table', { name: /Required is/ });
    const rows = within(table).getAllByRole('button', { name: /Captain/ });
    fireEvent.click(rows[0]!);

    await waitFor(() => {
      expect(screen.getByText('Minimum required')).toBeInTheDocument();
    });
    expect(screen.getByText(/Rated on/)).toBeInTheDocument();
  });

  it('shows no forecast, because there is no forecast', async () => {
    respondWith(MIXED);
    renderPage();
    const table = await screen.findByRole('table', { name: /Required is/ });
    fireEvent.click((within(table).getAllByRole('button', { name: /Captain/ })[0] ?? null)!);

    await waitFor(() => {
      expect(screen.getByText('Minimum required')).toBeInTheDocument();
    });
    /*
     * A "next 7 days" strip would need schedule-aware crew demand, which does
     * not exist — and a fabricated one would be the most convincing wrong number
     * on the page.
     */
    expect(screen.queryByText(/next 7 days/i)).not.toBeInTheDocument();
  });

  it('is reachable by keyboard, because a row is not a widget', async () => {
    respondWith(MIXED);
    renderPage();
    const table = await screen.findByRole('table', { name: /Required is/ });
    const button = within(table).getAllByRole('button', { name: /Captain/ })[0];
    expect(button?.tagName).toBe('BUTTON');
  });
});

describe('actions', () => {
  it('calls the existing hire mutation', async () => {
    const fetchMock = vi.fn((path: string) => {
      if (path.includes('/api/world/clock')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MIXED),
      } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Hire crew/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Hire crew' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([p]) => p === '/api/crew/hires')).toBe(true);
    });
  });

  it('calls the existing conversion and base mutations', async () => {
    const fetchMock = vi.fn((path: string) => {
      if (path.includes('/api/world/clock')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(MIXED),
      } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Convert rating/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start conversion' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([p]) => p === '/api/crew/conversions')).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: /Open crew base/ }));
    fireEvent.change(screen.getByLabelText('Airport'), { target: { value: 'EGLL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open base' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([p]) => p === '/api/crew/bases')).toBe(true);
    });
  });

  it('opens one form at a time rather than showing them all', async () => {
    respondWith(MIXED);
    renderPage();

    // The previous page kept every form expanded and spent most of a screen on
    // controls nobody was using.
    expect(await screen.findByRole('button', { name: /Hire crew/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Heads')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Hire crew/ }));
    expect(screen.getByLabelText('Heads')).toBeInTheDocument();
  });
});

describe('the invariant that outlives every redesign', () => {
  it('never names a person, in any table on the page', async () => {
    respondWith(MIXED);
    renderPage();
    await screen.findByRole('table', { name: 'Crew at EHAM' });

    /*
     * M5-01: *"if they have to hand-roster 400 flight attendants, the feature
     * has failed."* Every control moves a number. The surest way to make
     * hand-rostering inevitable later is to ship something today that looks like
     * a name — so no table may grow a column for one.
     */
    for (const table of screen.getAllByRole('table')) {
      const headers = [...table.querySelectorAll('th[scope="col"]')].map((th) =>
        (th.textContent ?? '').toLowerCase(),
      );
      expect(headers).not.toContain('name');
      expect(headers).not.toContain('crew member');
    }
  });

  it('offers every rank the enum holds, not the three the old page knew', async () => {
    respondWith(MIXED);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Hire crew/ }));
    const options = [...screen.getByLabelText('Rank').querySelectorAll('option')].map(
      (option) => option.textContent,
    );
    expect(options).toHaveLength(9);
    expect(options).toContain('Training Captain');
    expect(options).toContain('Cabin Service Manager');
  });
});
