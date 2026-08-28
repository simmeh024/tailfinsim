import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXECUTIVE_CANDIDATES, type ExecutiveFloorState } from '@tailfin/shared';

import { CSUITE_CANDIDATES } from './csuite-roster';
import { rosterDayIndex, rotatingExecutiveRoster, ROSTER_SIZE } from './csuite-rotation';
import { ExecutiveSuitePage } from './ExecutiveSuitePage';

/**
 * The C-Suite roster (§9.1 follow-up, Phase 2/3).
 *
 * The two office rules the brief asked for — any office holds anyone, and a
 * candidate is **locked** when no office is free — plus the Phase 3 additions:
 * the market is a **rotating ten**, not the whole roster, and a 24-hour refresh
 * timer sits at the top. The clock is frozen so the shortlist is deterministic;
 * the tests then reach for the first two of *that day's* shortlist rather than
 * the first two of the catalogue.
 */

// A fixed instant so the daily rotation — and the countdown — are deterministic.
const FIXED_NOW = Date.UTC(2026, 7, 28, 9, 0, 0);
const shortlist = rotatingExecutiveRoster(
  CSUITE_CANDIDATES,
  rosterDayIndex(FIXED_NOW),
  ROSTER_SIZE,
);
const [first, second] = shortlist;

function baseFloor(): ExecutiveFloorState {
  return {
    unlocked: true,
    officesUnlocked: 1,
    unlockCostMinor: 10_000_000_000,
    revenueGateMinor: 5_000_000_000,
    monthlyRevenueMinor: 6_000_000_000,
    nextOffice: null,
    hires: [],
  };
}

function renderCSuite(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/c-suite']}>
      <Routes>
        <Route path="/c-suite" element={<ExecutiveSuitePage />} />
        <Route path="/headquarters" element={<div>Headquarters</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the C-Suite page', () => {
  let floor: ExecutiveFloorState;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    floor = baseFloor();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? 'GET';
        const json = (): Promise<Response> =>
          Promise.resolve(new Response(JSON.stringify(floor), { status: 200 }));
        if (url === '/api/office/executive' && method === 'GET') return json();
        if (url === '/api/office/executive/hires' && method === 'POST') {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            candidateId: string;
          };
          const c = EXECUTIVE_CANDIDATES.find((x) => x.id === body.candidateId)!;
          floor = {
            ...floor,
            hires: [
              ...floor.hires,
              {
                candidateId: c.id,
                candidateName: c.name,
                monthlySalaryMinor: c.monthlySalaryMinor,
                hiredAt: '2024-10-20T00:00:00.000Z',
              },
            ],
          };
          return json();
        }
        if (url.startsWith('/api/office/executive/hires/') && method === 'DELETE') {
          const id = decodeURIComponent(url.slice('/api/office/executive/hires/'.length));
          floor = { ...floor, hires: floor.hires.filter((h) => h.candidateId !== id) };
          return json();
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a 24-hour refresh timer at the top', async () => {
    renderCSuite();
    const timer = await screen.findByRole('timer');
    expect(timer.textContent).toContain('Roster refreshes in');
    // A whole-seconds HH:MM:SS countdown.
    expect(timer.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('offers a rotating shortlist of ten, not the whole roster', async () => {
    const { container } = renderCSuite();
    await screen.findByText(first!.name);
    expect(container.querySelectorAll('.hq-card')).toHaveLength(ROSTER_SIZE);
    expect(ROSTER_SIZE).toBeLessThan(CSUITE_CANDIDATES.length);
  });

  it('shows each executive’s role and standing boost', async () => {
    renderCSuite();
    const card = (await screen.findByText(first!.name)).closest('li')!;
    expect(within(card).getByText(first!.role)).toBeTruthy();
    expect(within(card).getByText(first!.boost.label)).toBeTruthy();
  });

  it('opens the whole market while there is a free office', async () => {
    renderCSuite();
    expect(await screen.findByText(first!.name)).toBeTruthy();
    // A free office means every shortlisted candidate is hireable; none is locked.
    expect(screen.getByRole('button', { name: `Hire ${first!.name.split(' ')[0]!}` })).toBeTruthy();
    expect(screen.queryByText('No free office')).toBeNull();
  });

  it('fills the office on a hire, locks the rest, and sums the boost in play', async () => {
    renderCSuite();
    const hire = await screen.findByRole('button', {
      name: `Hire ${first!.name.split(' ')[0]!}`,
    });
    fireEvent.click(hire);

    // The hired card flips to "Let go"...
    await waitFor(() => expect(screen.getByRole('button', { name: 'Let go' })).toBeTruthy());
    // ...the boost the hire brings is now summed into "Boosts in play"...
    expect(screen.getByText('Boosts in play')).toBeTruthy();
    // ...and with the only office taken, everyone else is locked.
    const secondCard = screen.getByText(second!.name).closest('li')!;
    const secondButton = within(secondCard).getByRole('button');
    expect(secondButton.textContent).toBe('No free office');
    expect(secondButton).toHaveProperty('disabled', true);
  });

  it('re-opens the market when a member is let go', async () => {
    floor = {
      ...baseFloor(),
      hires: [
        {
          candidateId: first!.id,
          candidateName: first!.name,
          monthlySalaryMinor: first!.monthlySalaryMinor,
          hiredAt: '2024-10-20T00:00:00.000Z',
        },
      ],
    };
    renderCSuite();

    const letGo = await screen.findByRole('button', { name: 'Let go' });
    fireEvent.click(letGo);

    // The freed office puts the second candidate back within reach.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: `Hire ${second!.name.split(' ')[0]!}` }),
      ).toBeTruthy(),
    );
  });

  it('keeps a hired executive visible even when they rotate out of the shortlist', async () => {
    // Someone employed who is not on today's shortlist must still be lettable-go.
    const offlist = CSUITE_CANDIDATES.find((c) => !shortlist.some((s) => s.id === c.id))!;
    floor = {
      ...baseFloor(),
      hires: [
        {
          candidateId: offlist.id,
          candidateName: offlist.name,
          monthlySalaryMinor: offlist.monthlySalaryMinor,
          hiredAt: '2024-10-20T00:00:00.000Z',
        },
      ],
    };
    const { container } = renderCSuite();

    const card = (await screen.findByText(offlist.name)).closest('li')!;
    expect(within(card).getByRole('button', { name: 'Let go' })).toBeTruthy();
    // The shortlist's ten, plus the one hired executive from outside it.
    expect(container.querySelectorAll('.hq-card')).toHaveLength(ROSTER_SIZE + 1);
  });
});
