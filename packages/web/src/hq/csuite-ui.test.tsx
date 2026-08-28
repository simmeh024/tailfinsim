import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXECUTIVE_CANDIDATES, type ExecutiveFloorState } from '@tailfin/shared';

import { fetchExecutiveFloor } from './api';
import { CSUITE_CANDIDATES } from './csuite-roster';
import { rosterDayIndex, rotatingExecutiveRoster, ROSTER_SIZE } from './csuite-rotation';
import { ExecutiveSuitePage } from './ExecutiveSuitePage';
import { HqLayoutPanel } from './HqLayoutPanel';

import type { OwnAirlineShellContext } from '../shell/AppShell';
import type { ReactNode } from 'react';

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
            officeIndex?: number;
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
                officeIndex: body.officeIndex ?? floor.hires.length,
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
          officeIndex: 0,
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
          officeIndex: 0,
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

/**
 * Hiring and firing from the executive floor plan, just like the ground floor.
 *
 * The plan lives in the shell's context panel; clicking an office opens the
 * C-Suite page's drawer on it. Panel and page share one shell-owned floor state,
 * so a hire from the plan shows up in the roster and vice versa. This mounts both
 * halves the way the shell does and drives the plan exactly as a player would.
 */
const [planFirst] = shortlist;

function baseCtx(): OwnAirlineShellContext {
  return {
    ownAirline: null,
    ownAirlineLoading: false,
    ownAirlineError: false,
    replaceOwnAirline: () => undefined,
    reloadOwnAirline: () => Promise.resolve(),
    office: null,
    replaceOffice: () => undefined,
    reloadOffice: () => Promise.resolve(),
    selectedOffice: null,
    selectOffice: () => undefined,
    execFloor: null,
    replaceExecFloor: () => undefined,
    reloadExecFloor: () => Promise.resolve(),
    selectedExecOffice: null,
    selectExecOffice: () => undefined,
  };
}

function ExecShellHarness(): ReactNode {
  const [execFloor, setExecFloor] = useState<ExecutiveFloorState | null>(null);
  const [selectedExecOffice, setSelectedExecOffice] = useState<number | null>(null);
  useEffect(() => {
    void fetchExecutiveFloor().then(setExecFloor);
  }, []);
  const ctx: OwnAirlineShellContext = {
    ...baseCtx(),
    execFloor,
    replaceExecFloor: setExecFloor,
    selectedExecOffice,
    selectExecOffice: setSelectedExecOffice,
  };
  const noop = (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true });
  return (
    <>
      <HqLayoutPanel
        office={null}
        onSelectSeat={() => undefined}
        initialFloor="executive"
        execFloor={execFloor}
        onUnlockExecFloor={noop}
        onOpenExecOffice={noop}
        selectedExecOffice={selectedExecOffice}
        onSelectExecOffice={setSelectedExecOffice}
      />
      <Outlet context={ctx} />
    </>
  );
}

describe('the executive floor plan', () => {
  let floor: ExecutiveFloorState;

  function renderWithPlan(): void {
    render(
      <MemoryRouter initialEntries={['/c-suite']}>
        <Routes>
          <Route element={<ExecShellHarness />}>
            <Route path="/c-suite" element={<ExecutiveSuitePage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    // One open, empty office — so the plan shows exactly one clickable room.
    floor = {
      unlocked: true,
      officesUnlocked: 1,
      unlockCostMinor: 10_000_000_000,
      revenueGateMinor: 5_000_000_000,
      monthlyRevenueMinor: 6_000_000_000,
      nextOffice: null,
      hires: [],
    };
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
            officeIndex?: number;
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
                officeIndex: body.officeIndex ?? floor.hires.length,
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

  it('hires into an office by clicking the empty room, then shows the occupant', async () => {
    renderWithPlan();
    // The one open office is an empty, clickable room on the plan.
    const room = await screen.findByRole('button', { name: /Executive Office 01, Vacant/i });
    fireEvent.click(room);

    // Its drawer opens; hire the first shortlisted executive from it.
    const dialog = await screen.findByRole('dialog', { name: /Staff Executive Office 01/i });
    const given = planFirst!.name.split(' ')[0]!;
    fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`Hire ${given}`) }));

    // The drawer closes and the roster now offers to let the new hire go.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Executive Office 01/i })).toBeNull(),
    );
    expect(await screen.findByRole('button', { name: 'Let go' })).toBeTruthy();
  });

  it('puts the hire in the office you clicked, not the first free one', async () => {
    floor = { ...floor, officesUnlocked: 3 };
    renderWithPlan();
    // Offices 01 and 02 are empty; hire into office 03 specifically.
    fireEvent.click(await screen.findByRole('button', { name: /Executive Office 03, Vacant/i }));
    const dialog = await screen.findByRole('dialog', { name: /Staff Executive Office 03/i });
    const given = planFirst!.name.split(' ')[0]!;
    fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`Hire ${given}`) }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Executive Office 03/i })).toBeNull(),
    );
    // The occupant is in office 03; office 01 is still an empty "+ Hire".
    const office3 = screen.getByRole('button', { name: /Executive Office 03, Staffed/i });
    expect(within(office3).getByText(planFirst!.name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Executive Office 01, Vacant/i })).toBeTruthy();
  });

  it('fires the occupant by clicking a staffed room', async () => {
    floor = {
      ...floor,
      hires: [
        {
          candidateId: planFirst!.id,
          candidateName: planFirst!.name,
          monthlySalaryMinor: planFirst!.monthlySalaryMinor,
          officeIndex: 0,
          hiredAt: '2024-10-20T00:00:00.000Z',
        },
      ],
    };
    renderWithPlan();

    // The staffed room opens a manage drawer with a Let go control.
    const room = await screen.findByRole('button', { name: /Executive Office 01, Staffed/i });
    fireEvent.click(room);
    const dialog = await screen.findByRole('dialog', { name: /Manage Executive Office 01/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Let go' }));

    // The office empties again — the room goes back to a hireable "+ Hire".
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Executive Office 01, Vacant/i })).toBeTruthy(),
    );
  });
});
