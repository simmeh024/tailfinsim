import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXECUTIVE_CANDIDATES, type ExecutiveFloorState } from '@tailfin/shared';

import { ExecutiveSuitePage } from './ExecutiveSuitePage';

/**
 * The C-Suite roster (§9.1 follow-up, Phase 2).
 *
 * The two rules the brief asked for: an executive office holds anyone, and a
 * candidate is **locked** when there is no free office to put them in. So these
 * drive the page's fetch with a mutable floor and assert the market opens and
 * locks with the office count — hiring fills a seat and locks the rest; letting go
 * frees it again.
 */

const [first, second] = EXECUTIVE_CANDIDATES;

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

function renderCSuite(): void {
  render(
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
  });

  it('opens the whole market while there is a free office', async () => {
    renderCSuite();
    expect(await screen.findByText(first!.name)).toBeTruthy();
    // A free office means every candidate is hireable; none is locked.
    expect(screen.getByRole('button', { name: `Hire ${first!.name.split(' ')[0]!}` })).toBeTruthy();
    expect(screen.queryByText('No free office')).toBeNull();
  });

  it('fills the office on a hire and locks the rest of the market', async () => {
    renderCSuite();
    const hire = await screen.findByRole('button', {
      name: `Hire ${first!.name.split(' ')[0]!}`,
    });
    fireEvent.click(hire);

    // The hired card flips to "Let go"...
    await waitFor(() => expect(screen.getByRole('button', { name: 'Let go' })).toBeTruthy());
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
});
