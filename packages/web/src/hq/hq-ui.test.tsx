import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executiveCandidate,
  officeCandidate,
  type ExecutiveFloorState,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { fetchExecutiveFloor, unlockExecutiveFloor, unlockExecutiveOffice } from './api';
import { CSUITE_CANDIDATES } from './csuite-roster';
import {
  nextRefreshAt,
  rosterDayIndex,
  rotatingExecutiveRoster,
  rotatingRoster,
} from './csuite-rotation';
import { HeadquartersPage } from './HeadquartersPage';
import {
  candidateById,
  candidatesForRole,
  HQ_CANDIDATES,
  HQ_ROLES,
  SPECIALIST_CANDIDATES,
  type HqRoleId,
} from './hq-roster';
import { HqLayoutPanel, type ExpandResult } from './HqLayoutPanel';

// A fixed instant so each seat's rotating shortlist — and the countdown — are
// deterministic. The market shows four of a seat's candidates; the tests reach
// for that day's shortlist rather than assuming any particular person is on it.
const FIXED_NOW = Date.UTC(2026, 7, 28, 9, 0, 0);
const SEAT_MARKET_SIZE = 4;
function shortlistFor(role: HqRoleId): { name: string; id: string }[] {
  return rotatingRoster(candidatesForRole(role), rosterDayIndex(FIXED_NOW), SEAT_MARKET_SIZE);
}
const routePlannerShortlist = shortlistFor('route-planner');
const execShortlist = rotatingExecutiveRoster(CSUITE_CANDIDATES, rosterDayIndex(FIXED_NOW));

import type { OwnAirlineShellContext } from '../shell/AppShell';
import type { ReactNode } from 'react';

/**
 * A stand-in for the app shell that owns the interactive floor-plan.
 *
 * On the real page the plan lives in the shell's context panel, and the page
 * reads the selected office back through the outlet context to open its drawer.
 * This mounts both halves the same way — the plan and the page sharing one
 * selection — so a test can click a room and drive the drawer exactly as a
 * player does. The page still feeds `office` back through `replaceOffice`, so the
 * plan the harness renders is the office the page fetched.
 */
function ShellHarness({
  onExpand,
  cash,
}: {
  onExpand?: () => Promise<ExpandResult>;
  /** The airline's cash, when the test is exercising the affordability reading. */
  cash?: number;
}): ReactNode {
  const [office, setOffice] = useState<OfficeStateResponse | null>(null);
  const [selectedOffice, setSelectedOffice] = useState<OfficeSeatId | null>(null);
  // The shell owns the executive floor; the harness mirrors that so the panel's
  // pager and unlocks behave exactly as they do in the app.
  const [execFloor, setExecFloor] = useState<ExecutiveFloorState | null>(null);
  const [selectedExecOffice, setSelectedExecOffice] = useState<number | null>(null);
  useEffect(() => {
    void fetchExecutiveFloor().then(setExecFloor);
  }, []);
  const onUnlockExecFloor = async (): Promise<ExpandResult> => {
    const outcome = await unlockExecutiveFloor();
    if (outcome.ok) {
      setExecFloor(outcome.state);
      return { ok: true };
    }
    return { ok: false, message: outcome.failure.message };
  };
  const onOpenExecOffice = async (): Promise<ExpandResult> => {
    const outcome = await unlockExecutiveOffice();
    if (outcome.ok) {
      setExecFloor(outcome.state);
      return { ok: true };
    }
    return { ok: false, message: outcome.failure.message };
  };
  const ctx: OwnAirlineShellContext = {
    // The page reads exactly one field off this, so a test that cares about cash
    // supplies that field rather than a fabricated fifteen-field airline.
    ownAirline:
      cash === undefined
        ? null
        : ({ airline: { cash }, rebrand: null } as unknown as OwnAirlineShellContext['ownAirline']),
    ownAirlineLoading: false,
    ownAirlineError: false,
    replaceOwnAirline: () => undefined,
    reloadOwnAirline: () => Promise.resolve(),
    office,
    replaceOffice: setOffice,
    reloadOffice: () => Promise.resolve(),
    selectedOffice,
    selectOffice: setSelectedOffice,
    execFloor,
    replaceExecFloor: setExecFloor,
    reloadExecFloor: () => Promise.resolve(),
    selectedExecOffice,
    selectExecOffice: setSelectedExecOffice,
  };
  return (
    <>
      <HqLayoutPanel
        office={office}
        onExpand={onExpand}
        onSelectSeat={setSelectedOffice}
        selectedSeat={selectedOffice}
        execFloor={execFloor}
        onUnlockExecFloor={onUnlockExecFloor}
        onOpenExecOffice={onOpenExecOffice}
        selectedExecOffice={selectedExecOffice}
        onSelectExecOffice={setSelectedExecOffice}
      />
      <Outlet context={ctx} />
    </>
  );
}

function renderHq(
  onExpand: () => Promise<ExpandResult> = vi.fn().mockResolvedValue({ ok: true }),
  cash?: number,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/headquarters']}>
      <Routes>
        <Route element={<ShellHarness onExpand={onExpand} cash={cash} />}>
          <Route path="headquarters" element={<HeadquartersPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * The page on its own — no shell, so `useOutletContext` is null and it falls back
 * to local selection. It still needs a router for its links (the C-Suite button),
 * so a bare MemoryRouter wraps it without an Outlet.
 */
function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/headquarters']}>
      <HeadquartersPage />
    </MemoryRouter>,
  );
}

/**
 * Headquarters — the office hires (M5-04, §9.1).
 *
 * The page is a scaffold, so these are the invariants that keep it honest: every
 * candidate has a portrait, every role's effect is a concrete unlock, the Safety
 * & Compliance gate is present and marked, and the two rules the brief asked for
 * — greyed when unhired, colour when hired; a seat holds one person — actually
 * hold.
 */

describe('the office roster', () => {
  it('has the six MVP seats from the issue, in §9.1 order', () => {
    expect(HQ_ROLES.map((role) => role.id)).toEqual([
      'route-planner',
      'revenue-manager',
      'ops-controller',
      'chief-pilot',
      'ground-ops',
      'safety-compliance',
    ]);
  });

  it('carries a market of at least four candidates per seat, keeping the originals', () => {
    const originals: Record<string, string[]> = {
      'route-planner': ['Mara Ellison', 'Tom Bakker', 'Victor Lindqvist'],
      'revenue-manager': ['Kenji Tan', 'Sofía Reyes', 'Anders Holm'],
      'ops-controller': ['Diego Alvarez', 'Marta Silva', 'Jun Park'],
      'chief-pilot': ['Sten Halvorsen', 'Fiona Brennan', 'Grant Wexford'],
      'ground-ops': ['Nadia Kovač', 'Omar Haddad', 'Luca Moretti'],
      'safety-compliance': ['Claire Fontaine', 'Hiroshi Tanaka', 'Emma Larsson'],
    };
    for (const [role, names] of Object.entries(originals)) {
      const shown = candidatesForRole(role as HqRoleId).map((c) => c.name);
      expect(shown.length, role).toBeGreaterThanOrEqual(4);
      for (const name of names) expect(shown, role).toContain(name);
    }
    // Every candidate names a real seat and carries a portrait.
    const roleIds = new Set<string>(HQ_ROLES.map((role) => role.id));
    for (const candidate of HQ_CANDIDATES) {
      expect(roleIds.has(candidate.roleId), candidate.id).toBe(true);
      expect(candidate.portrait, candidate.id).toBeTruthy();
    }
    // Ids are unique.
    const ids = HQ_CANDIDATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('bills what it shows — every candidate salary matches the shared catalogue', () => {
    // The roster is the display; the shared catalogue is what the server bills.
    // If these drift, a card shows a price the ledger never charges.
    for (const candidate of [...HQ_CANDIDATES, ...SPECIALIST_CANDIDATES]) {
      const billed = officeCandidate(candidate.id);
      expect(billed, candidate.id).toBeDefined();
      expect(candidate.salaryPerMonthMinor, candidate.id).toBe(billed?.monthlySalaryMinor);
      expect(candidate.roleId, candidate.id).toBe(billed?.role);
    }
  });

  it("makes each seat's effect a concrete unlock, not a percentage — M5-04's rule", () => {
    for (const role of HQ_ROLES) {
      expect(role.unlock.length, role.id).toBeGreaterThan(0);
      expect(role.unlock, role.id).not.toMatch(/\d+\s?%/);
    }
  });

  it('gates long-haul only behind Safety & Compliance', () => {
    const gated = HQ_ROLES.filter((role) => role.gates !== undefined);
    expect(gated.map((role) => role.id)).toEqual(['safety-compliance']);
    expect(gated[0]?.gates?.toLowerCase()).toContain('long-haul');
  });
});

describe('the Headquarters page', () => {
  // A tiny in-memory stand-in for `/api/office`: the page reads it on mount and
  // writes to it on hire and dismiss, and the server always answers with the
  // whole office, so the mock does too.
  let hires: { seat: string; candidateId: string; candidateName: string }[] = [];
  let neutralSeats = 0;
  let offeredSpecialist = 'social-media-reputation';
  /**
   * What `POST /api/office/hires` should do instead of succeeding: an HTTP
   * answer, or `'unreachable'` for a request that never completes. Null is the
   * normal path.
   */
  let hireOutcome: { status: number; body: unknown } | 'unreachable' | null = null;
  let automation: { settings: unknown[]; tasks: unknown[] } = { settings: [], tasks: [] };
  // The panel fetches the executive floor on mount; a closed floor with no
  // revenue is the default so the pager appears and the gate reads locked.
  interface ExecHire {
    candidateId: string;
    candidateName: string;
    monthlySalaryMinor: number;
    officeIndex: number | null;
    hiredAt: string;
  }
  let execFloor = {
    unlocked: false,
    officesUnlocked: 0,
    unlockCostMinor: 10_000_000_000,
    revenueGateMinor: 5_000_000_000,
    monthlyRevenueMinor: 0,
    nextOffice: null as { index: number; costMinor: number } | null,
    hires: [] as ExecHire[],
  };

  function officeState() {
    return {
      hires: hires.map((h) => ({
        ...h,
        monthlySalaryMinor: 1_000_000,
        hiredAt: '2024-10-20T00:00:00.000Z',
      })),
      hasExtendedAuthority: hires.some((h) => h.seat === 'safety-compliance'),
      neutralSeats,
      nextExpansion: { addsSeats: 2, totalSeats: 8, costMinor: 1_000_000_000 },
      offeredSpecialist,
    };
  }

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    hires = [];
    neutralSeats = 0;
    execFloor = {
      unlocked: false,
      officesUnlocked: 0,
      unlockCostMinor: 10_000_000_000,
      revenueGateMinor: 5_000_000_000,
      monthlyRevenueMinor: 0,
      nextOffice: null,
      hires: [],
    };
    offeredSpecialist = 'social-media-reputation';
    hireOutcome = null;
    automation = { settings: [], tasks: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? 'GET';
        const ok = () =>
          Promise.resolve(new Response(JSON.stringify(officeState()), { status: 200 }));
        if (url === '/api/automation' && method === 'GET') {
          return Promise.resolve(new Response(JSON.stringify(automation), { status: 200 }));
        }
        if (url.startsWith('/api/automation/') && method === 'PUT') {
          const raw = typeof init?.body === 'string' ? init.body : '{}';
          const body = JSON.parse(raw) as { mode: string; policy: unknown };
          const system = url.slice('/api/automation/'.length);
          automation = { settings: [{ system, mode: body.mode, policy: body.policy }], tasks: [] };
          return Promise.resolve(new Response(JSON.stringify(automation), { status: 200 }));
        }
        if (url === '/api/office/executive' && method === 'GET') {
          return Promise.resolve(new Response(JSON.stringify(execFloor), { status: 200 }));
        }
        if (url === '/api/office/executive/unlock' && method === 'POST') {
          execFloor = {
            ...execFloor,
            unlocked: true,
            nextOffice: { index: 0, costMinor: 7_500_000_000 },
          };
          return Promise.resolve(new Response(JSON.stringify(execFloor), { status: 200 }));
        }
        if (url === '/api/office/executive/offices' && method === 'POST') {
          const officesUnlocked = execFloor.officesUnlocked + 1;
          execFloor = { ...execFloor, officesUnlocked, nextOffice: null };
          return Promise.resolve(new Response(JSON.stringify(execFloor), { status: 200 }));
        }
        if (url === '/api/office/executive/hires' && method === 'POST') {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            candidateId: string;
            officeIndex?: number;
          };
          const c = executiveCandidate(body.candidateId)!;
          execFloor = {
            ...execFloor,
            hires: [
              ...execFloor.hires,
              {
                candidateId: c.id,
                candidateName: c.name,
                monthlySalaryMinor: c.monthlySalaryMinor,
                officeIndex: body.officeIndex ?? execFloor.hires.length,
                hiredAt: '2024-10-20T00:00:00.000Z',
              },
            ],
          };
          return Promise.resolve(new Response(JSON.stringify(execFloor), { status: 200 }));
        }
        if (url.startsWith('/api/office/executive/hires/') && method === 'DELETE') {
          const id = decodeURIComponent(url.slice('/api/office/executive/hires/'.length));
          execFloor = {
            ...execFloor,
            hires: execFloor.hires.filter((h) => h.candidateId !== id),
          };
          return Promise.resolve(new Response(JSON.stringify(execFloor), { status: 200 }));
        }
        if (url === '/api/office' && method === 'GET') return ok();
        if (url === '/api/office/hires' && method === 'POST') {
          if (hireOutcome === 'unreachable')
            return Promise.reject(new TypeError('Failed to fetch'));
          if (hireOutcome !== null) {
            return Promise.resolve(
              new Response(JSON.stringify(hireOutcome.body), { status: hireOutcome.status }),
            );
          }
          const raw = typeof init?.body === 'string' ? init.body : '{}';
          const body = JSON.parse(raw) as {
            seat: string;
            candidateId: string;
            candidateName: string;
          };
          hires = hires.filter((h) => h.seat !== body.seat);
          hires.push(body);
          return ok();
        }
        if (url.startsWith('/api/office/hires/') && method === 'DELETE') {
          const seat = url.slice('/api/office/hires/'.length);
          hires = hires.filter((h) => h.seat !== seat);
          return ok();
        }
        throw new Error(`unexpected fetch ${method} ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows every seat and today’s four candidates for each', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Headquarters' })).toBeInTheDocument();
    for (const role of HQ_ROLES) {
      const region = screen.getByRole('region', { name: role.role });
      expect(within(region).getAllByRole('listitem')).toHaveLength(SEAT_MARKET_SIZE);
      for (const candidate of shortlistFor(role.id)) {
        expect(within(region).getByText(candidate.name)).toBeInTheDocument();
      }
    }
    // A 24-hour refresh countdown sits at the top of the page.
    expect(screen.getByRole('timer').textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
    // The office loads empty from the server.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(`0 of ${String(HQ_ROLES.length)} seats`),
    );
  });

  it('shows each candidate their own salary, not a flat role rate', () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    const shown = candidatesForRole('route-planner').filter((c) =>
      routePlannerShortlist.some((s) => s.id === c.id),
    );
    const prices = new Set<string>();
    for (const c of shown) {
      const card = within(seat).getByText(c.name).closest('.hq-card');
      const price = `$${(c.salaryPerMonthMinor / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}/mo`;
      expect(within(card as HTMLElement).getByText(price)).toBeInTheDocument();
      prices.add(price);
    }
    // Tier sets the pay, so the four shown candidates are not all one price.
    expect(prices.size).toBeGreaterThan(1);
  });

  it('starts every candidate greyed, and colours the one hired', async () => {
    renderPage();
    const first = routePlannerShortlist[0]!;
    const given = first.name.split(' ')[0]!;
    const card = screen.getByText(first.name).closest<HTMLElement>('.hq-card');
    if (!card) throw new Error('no card for the first shortlisted candidate');
    const portrait = card.querySelector<HTMLElement>('.hq-card__portrait');
    if (!portrait) throw new Error('no portrait');

    expect(portrait.dataset.hired).toBe('false');
    const hire = within(card).getByRole('button', { name: new RegExp(`^Hire ${given}$`) });
    await waitFor(() => expect(hire).toBeEnabled());
    fireEvent.click(hire);
    await waitFor(() => expect(portrait.dataset.hired).toBe('true'));
    expect(screen.getByRole('status')).toHaveTextContent('1 of');
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    expect(within(seat).getByText(`Seat filled by ${first.name}`)).toBeInTheDocument();
  });

  it('holds one person per seat — hiring a rival swaps, it does not stack', async () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    const a = routePlannerShortlist[0]!;
    const b = routePlannerShortlist[1]!;
    const givenA = a.name.split(' ')[0]!;
    const givenB = b.name.split(' ')[0]!;

    const hireA = within(seat).getByRole('button', { name: new RegExp(`^Hire ${givenA}$`) });
    await waitFor(() => expect(hireA).toBeEnabled());
    fireEvent.click(hireA);
    await within(seat).findByText(`Seat filled by ${a.name}`);
    fireEvent.click(within(seat).getByRole('button', { name: new RegExp(`^Hire ${givenB}$`) }));
    await within(seat).findByText(`Seat filled by ${b.name}`);

    expect(screen.getByRole('status')).toHaveTextContent('1 of');
    const aCard = within(seat).getByText(a.name).closest<HTMLElement>('.hq-card');
    const bCard = within(seat).getByText(b.name).closest<HTMLElement>('.hq-card');
    expect(aCard?.dataset.hired).toBe('false');
    expect(bCard?.dataset.hired).toBe('true');
  });

  it('opens a drawer for the exact office a vacant room names', async () => {
    neutralSeats = 2;
    renderHq();
    // Office 07 is the first neutral office (neutral-1) on the plan.
    const room = await screen.findByRole('button', { name: /Office 07, Neutral office/i });
    fireEvent.click(room);
    expect(await screen.findByRole('dialog', { name: /Staff Office 07/i })).toBeInTheDocument();
  });

  it('hires a candidate into the clicked office and closes the drawer', async () => {
    neutralSeats = 2;
    renderHq();
    fireEvent.click(await screen.findByRole('button', { name: /Office 07, Neutral office/i }));
    const dialog = await screen.findByRole('dialog', { name: /Staff Office 07/i });

    const tomRow = within(dialog).getByText('Tom Bakker').closest('li');
    if (!tomRow) throw new Error('no candidate row for Tom');
    fireEvent.click(within(tomRow).getByRole('button', { name: /Hire & Assign/i }));

    // The assignment carried the office the drawer was for — neutral-1 / Office 07.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = hires.find((h) => h.candidateId === 'route-planner-tom');
    expect(post?.seat).toBe('neutral-1');
  });

  it('opens a role seat from its room and hires that role’s candidate into it', async () => {
    renderHq();
    // Office 01 is the Route Planner seat — now staffable straight from the plan.
    fireEvent.click(await screen.findByRole('button', { name: /Office 01, Route Planner/i }));
    const dialog = await screen.findByRole('dialog', { name: /Staff Route Planner/i });

    // Hire whoever tops today's route-planner shortlist.
    const first = routePlannerShortlist[0]!;
    const row = within(dialog).getByText(first.name).closest('li');
    if (!row) throw new Error('no candidate row in the drawer');
    fireEvent.click(within(row).getByRole('button', { name: /Hire & Assign/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(hires.find((h) => h.candidateId === first.id)?.seat).toBe('route-planner');
  });

  it('offers only a role’s own candidates in that seat’s drawer', async () => {
    renderHq();
    fireEvent.click(await screen.findByRole('button', { name: /Office 01, Route Planner/i }));
    const dialog = await screen.findByRole('dialog', { name: /Staff Route Planner/i });
    // A route-planner from today's shortlist is on offer; a revenue-manager never is.
    expect(within(dialog).getByText(routePlannerShortlist[0]!.name)).toBeInTheDocument();
    expect(within(dialog).queryByText('Kenji Tan')).toBeNull();
  });

  it('excludes an already-hired candidate from the drawer', async () => {
    hires = [
      { seat: 'route-planner', candidateId: 'route-planner-mara', candidateName: 'Mara Ellison' },
    ];
    neutralSeats = 2;
    renderHq();
    fireEvent.click(await screen.findByRole('button', { name: /Office 07, Neutral office/i }));
    const dialog = await screen.findByRole('dialog', { name: /Staff Office 07/i });
    // Mara already holds a seat, so she is not on offer; her rival still is.
    expect(within(dialog).queryByText('Mara Ellison')).toBeNull();
    expect(within(dialog).getByText('Tom Bakker')).toBeInTheDocument();
  });

  it('surfaces the world specialist in the drawer, badged, and only that one', async () => {
    offeredSpecialist = 'social-media-reputation';
    neutralSeats = 2;
    renderHq();
    fireEvent.click(await screen.findByRole('button', { name: /Office 07, Neutral office/i }));
    const dialog = await screen.findByRole('dialog', { name: /Staff Office 07/i });

    const lenaRow = within(dialog).getByText('Lena Voss').closest('li');
    expect(lenaRow?.dataset.specialist).toBe('true');
    // The other specialist is never on the market this world.
    expect(within(dialog).queryByText('Kai Mercer')).toBeNull();

    fireEvent.click(within(lenaRow as HTMLElement).getByRole('button', { name: /Hire & Assign/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(hires.find((h) => h.candidateId === 'social-media-reputation')?.seat).toBe('neutral-1');
  });

  it('opens an occupied office from its room and removes the occupant', async () => {
    hires = [{ seat: 'neutral-1', candidateId: 'route-planner-tom', candidateName: 'Tom Bakker' }];
    neutralSeats = 2;
    renderHq();
    // The occupied room names Tom and opens the manage drawer.
    fireEvent.click(
      await screen.findByRole('button', { name: /Office 07, Neutral office, Staffed/i }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Manage Office 07/i });
    expect(within(dialog).getByText('Tom Bakker')).toBeInTheDocument();
    // Removal is two steps now: the first names what it ends, the second does it.
    fireEvent.click(within(dialog).getByRole('button', { name: /Remove from Office/i }));
    expect(within(dialog).getByText(/Ends Tom Bakker/)).toBeInTheDocument();
    expect(hires.find((h) => h.seat === 'neutral-1')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm — remove/i }));

    await waitFor(() => expect(hires.find((h) => h.seat === 'neutral-1')).toBeUndefined());
  });

  it('backs out of a removal without touching the office', async () => {
    hires = [{ seat: 'neutral-1', candidateId: 'route-planner-tom', candidateName: 'Tom Bakker' }];
    neutralSeats = 2;
    renderHq();
    fireEvent.click(
      await screen.findByRole('button', { name: /Office 07, Neutral office, Staffed/i }),
    );
    const dialog = await screen.findByRole('dialog', { name: /Manage Office 07/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /Remove from Office/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));

    expect(within(dialog).getByRole('button', { name: /Remove from Office/i })).toBeInTheDocument();
    expect(hires.find((h) => h.seat === 'neutral-1')).toBeDefined();
  });

  it('offers expansion on the plan when no neutral office is unlocked', async () => {
    neutralSeats = 0;
    renderHq();
    // The plan carries the expand button…
    expect(await screen.findByRole('button', { name: /Expand/i })).toBeInTheDocument();
    // …and there is no Office 07 to staff until it is bought.
    expect(screen.queryByRole('button', { name: /Office 07/i })).toBeNull();
  });

  it('pages to the executive floor and shows the locked, revenue-gated overlay', async () => {
    renderHq();
    fireEvent.click(await screen.findByRole('tab', { name: /Executive/i }));
    const unlock = await screen.findByRole('button', { name: /Unlock the Executive Floor/i });
    // No revenue → the gate is not met and the unlock is disabled.
    expect(screen.getByText(/do not meet the requirements/i)).toBeInTheDocument();
    expect(unlock).toBeDisabled();
  });

  it('unlocks the executive floor once the revenue gate is met, then offers its first office', async () => {
    execFloor.monthlyRevenueMinor = 6_000_000_000; // above the $50M/month gate
    renderHq();
    fireEvent.click(await screen.findByRole('tab', { name: /Executive/i }));
    const unlock = await screen.findByRole('button', { name: /Unlock the Executive Floor/i });
    expect(unlock).toBeEnabled();
    fireEvent.click(unlock);
    // The open floor offers its first office.
    expect(await screen.findByRole('button', { name: /Open office 1 of 10/i })).toBeInTheDocument();
  });

  it('hires an executive straight from the plan, on the Headquarters page', async () => {
    execFloor = {
      unlocked: true,
      officesUnlocked: 1,
      unlockCostMinor: 10_000_000_000,
      revenueGateMinor: 5_000_000_000,
      monthlyRevenueMinor: 6_000_000_000,
      nextOffice: null,
      hires: [],
    };
    renderHq();
    // Page up to the executive floor and hire into its one open office from the plan.
    fireEvent.click(await screen.findByRole('tab', { name: /Executive/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Executive Office 01, Vacant/i }));
    const dialog = await screen.findByRole('dialog', { name: /Staff Executive Office 01/i });
    const first = execShortlist[0]!;
    fireEvent.click(
      within(dialog).getByRole('button', { name: new RegExp(`Hire ${first.name.split(' ')[0]!}`) }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Executive Office 01/i })).toBeNull(),
    );
    expect(execFloor.hires.find((h) => h.candidateId === first.id)).toBeDefined();
  });

  it('shows not-yet-built executive offices as locked', async () => {
    execFloor = {
      unlocked: true,
      officesUnlocked: 1,
      unlockCostMinor: 10_000_000_000,
      revenueGateMinor: 5_000_000_000,
      monthlyRevenueMinor: 6_000_000_000,
      nextOffice: { index: 1, costMinor: 10_000_000_000 },
      hires: [],
    };
    const { container } = renderHq();
    fireEvent.click(await screen.findByRole('tab', { name: /Executive/i }));
    // Office 01 is open (hireable); the other nine are locked padlock cells.
    await screen.findByRole('button', { name: /Executive Office 01, Vacant/i });
    expect(container.querySelectorAll('.hq-cell--locked')).toHaveLength(9);
  });

  it('renders the seats the server already reports as filled, on load', async () => {
    hires = [
      {
        seat: 'safety-compliance',
        candidateId: 'safety-compliance-claire',
        candidateName: 'Claire Fontaine',
      },
    ];
    renderPage();
    const seat = screen.getByRole('region', { name: 'Safety & Compliance' });
    expect(await within(seat).findByText(/Seat filled by Claire Fontaine/i)).toBeInTheDocument();
    // Filling the gate seat unlocks long-haul authority, and the page says so.
    expect(await screen.findByText(/long-haul authority unlocked/i)).toBeInTheDocument();
  });

  it('flags the seat that gates long-haul authority', () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Safety & Compliance' });
    expect(within(seat).getByText('Gate')).toBeInTheDocument();
    const gate = seat.querySelector('.hq-card__gate');
    expect(gate?.textContent?.toLowerCase()).toContain('long-haul');
  });

  it('gates Delegated in the Policies modal until an Ops Controller is hired', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Policies' }));
    const dialog = await screen.findByRole('dialog', { name: /operations policies/i });
    expect(within(dialog).getByRole('radio', { name: /Delegated/i })).toBeDisabled();
  });

  it('enables Delegated once the Ops Controller seat is filled', async () => {
    hires = [
      {
        seat: 'ops-controller',
        candidateId: 'ops-controller-diego',
        candidateName: 'Diego Alvarez',
      },
    ];
    renderPage();
    await screen.findByText(/Seat filled by Diego Alvarez/i);
    fireEvent.click(screen.getByRole('button', { name: 'Policies' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /Delegated/i })).toBeEnabled();
  });

  /* ---- What the UX pass added to the page ------------------------------- */

  it('says what the office costs a month, from the server’s own billing figure', async () => {
    hires = [{ seat: 'route-planner', candidateId: 'route-planner-tom', candidateName: 'Tom' }];
    renderPage();
    // The stub bills $10,000/mo for every hire, so one hire is the whole payroll.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('$10,000/mo payroll'));
    expect(screen.getByRole('status')).toHaveTextContent('1 of 6 seats filled');
  });

  it('says nothing about payroll while the office is empty', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('0 of 6 seats'));
    expect(screen.getByRole('status')).not.toHaveTextContent('payroll');
  });

  it('does not claim a seat is vacant before the server has answered', () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    // The office is still in flight: "Seat vacant" would be an answer the page
    // does not have yet, and the grey portraits would read as that answer.
    expect(within(seat).getByText('Reading the office…')).toBeInTheDocument();
    expect(within(seat).queryByText('Seat vacant')).toBeNull();
    const portrait = seat.querySelector<HTMLElement>('.hq-card__portrait');
    expect(portrait?.dataset.pending).toBe('true');
  });

  it('reads a vacancy as what the airline goes without, once it knows there is one', async () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    await within(seat).findByText('Seat vacant');
    expect(
      within(seat).getByText(HQ_ROLES.find((role) => role.id === 'route-planner')!.vacant),
    ).toBeInTheDocument();
    const portrait = seat.querySelector<HTMLElement>('.hq-card__portrait');
    expect(portrait?.dataset.pending).toBe('false');
  });

  it('states what a filled seat is being billed', async () => {
    // The status line names the person from the catalogue, not the string the
    // wire happened to carry, so the test asks the catalogue too.
    const sten = candidateById('chief-pilot-sten')!;
    hires = [{ seat: 'chief-pilot', candidateId: sten.id, candidateName: sten.name }];
    renderPage();
    const seat = screen.getByRole('region', { name: 'Chief Pilot' });
    await within(seat).findByText(`Seat filled by ${sten.name}`);
    expect(within(seat).getByText('$10,000/mo')).toBeInTheDocument();
    expect(within(seat).queryByText(/goes without|stays unranked/)).toBeNull();
  });

  it('explains what the tier bands buy', () => {
    renderPage();
    expect(screen.getByText(/A higher band asks a higher salary/)).toBeInTheDocument();
  });

  it('marks the strongest boost on offer, and draws the rest against it', async () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    await within(seat).findByText('Seat vacant');
    const shown = candidatesForRole('route-planner').filter((c) =>
      routePlannerShortlist.some((s) => s.id === c.id),
    );
    const best = shown.reduce((top, c) =>
      Math.abs(c.boost.magnitude) > Math.abs(top.boost.magnitude) ? c : top,
    );
    const bestCard = within(seat).getByText(best.name).closest<HTMLElement>('.hq-card');
    expect(within(bestCard!).getByText(/Strongest of the/)).toBeInTheDocument();
    expect(bestCard?.querySelector<HTMLElement>('.hq-card__strength-fill')?.style.inlineSize).toBe(
      '100%',
    );
    // The badge still carries the figure, so the bar is decoration only.
    expect(bestCard?.querySelector('.hq-card__strength')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('warns when a hire would cost more than the airline has, without blocking it', async () => {
    // A month's salary for one hire is $10,000; $5,000 of cash cannot carry it.
    renderHq(undefined, 500_000);
    const seat = await screen.findByRole('region', { name: 'Route Planner' });
    const first = routePlannerShortlist[0]!;
    const card = within(seat).getByText(first.name).closest<HTMLElement>('.hq-card');
    await waitFor(() =>
      expect(within(card!).getByText(/would exceed your cash/)).toBeInTheDocument(),
    );
    // A warning, never a gate: the control is still live.
    expect(
      within(card!).getByRole('button', {
        name: new RegExp(`^Hire ${first.name.split(' ')[0]!}$`),
      }),
    ).toBeEnabled();
  });

  it('says nothing about affordability when it cannot see the cash', async () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    await within(seat).findByText('Seat vacant');
    expect(within(seat).queryByText(/exceed your cash|three months/)).toBeNull();
  });

  it('takes two steps to let someone go, and the first one changes nothing', async () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    const first = routePlannerShortlist[0]!;
    const given = first.name.split(' ')[0]!;
    const hire = within(seat).getByRole('button', { name: new RegExp(`^Hire ${given}$`) });
    await waitFor(() => expect(hire).toBeEnabled());
    fireEvent.click(hire);
    await within(seat).findByText(`Seat filled by ${first.name}`);

    fireEvent.click(within(seat).getByRole('button', { name: 'Let go' }));
    expect(within(seat).getByText(/Ends .*’s contract and stops the salary/)).toBeInTheDocument();
    expect(hires.find((h) => h.seat === 'route-planner')).toBeDefined();

    fireEvent.click(within(seat).getByRole('button', { name: `Confirm — let ${given} go` }));
    await waitFor(() => expect(hires.find((h) => h.seat === 'route-planner')).toBeUndefined());
  });

  it('backs out of a dismissal and leaves the hire standing', async () => {
    hires = [
      { seat: 'route-planner', candidateId: routePlannerShortlist[0]!.id, candidateName: 'X' },
    ];
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    await within(seat).findByText(/Seat filled by/);
    fireEvent.click(within(seat).getByRole('button', { name: 'Let go' }));
    fireEvent.click(within(seat).getByRole('button', { name: 'Keep' }));

    expect(within(seat).getByRole('button', { name: 'Let go' })).toBeInTheDocument();
    expect(hires.find((h) => h.seat === 'route-planner')).toBeDefined();
  });

  it('names the authority a dismissal from the gate seat would revoke', async () => {
    hires = [
      {
        seat: 'safety-compliance',
        candidateId: candidatesForRole('safety-compliance')[0]!.id,
        candidateName: 'Claire',
      },
    ];
    renderPage();
    const seat = screen.getByRole('region', { name: 'Safety & Compliance' });
    await within(seat).findByText(/Seat filled by/);
    fireEvent.click(within(seat).getByRole('button', { name: 'Let go' }));
    expect(
      within(seat).getByText(/revokes long-haul, ETOPS and international authority/),
    ).toBeInTheDocument();
  });

  it('shows a refused hire in the seat that refused it, as a refusal', async () => {
    hireOutcome = { status: 409, body: { code: 'seat_taken', message: 'That seat is taken.' } };
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    const given = routePlannerShortlist[0]!.name.split(' ')[0]!;
    const hire = within(seat).getByRole('button', { name: new RegExp(`^Hire ${given}$`) });
    await waitFor(() => expect(hire).toBeEnabled());
    fireEvent.click(hire);

    const block = await within(seat).findByText('That seat is taken.');
    expect(block.closest<HTMLElement>('.state')?.dataset.state).toBe('refused');
    // And nowhere else: the other five seats say nothing about it.
    expect(
      within(screen.getByRole('region', { name: 'Chief Pilot' })).queryByText(/seat is taken/),
    ).toBeNull();
  });

  it('keeps a server that never answered apart from a server that said no', async () => {
    hireOutcome = 'unreachable';
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    const given = routePlannerShortlist[0]!.name.split(' ')[0]!;
    const hire = within(seat).getByRole('button', { name: new RegExp(`^Hire ${given}$`) });
    await waitFor(() => expect(hire).toBeEnabled());
    fireEvent.click(hire);

    const block = await within(seat).findByText(/could not be reached/i);
    expect(block.closest<HTMLElement>('.state')?.dataset.state).toBe('broken');
    // The control comes back rather than staying disabled on a dropped request.
    expect(hire).toBeEnabled();
  });

  it('offers the new shortlist at the turnover instead of swapping it under you', () => {
    vi.useFakeTimers();
    try {
      renderPage();
      const seat = screen.getByRole('region', { name: 'Route Planner' });
      const before = within(seat)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('.hq-card__name')?.textContent);

      vi.spyOn(Date, 'now').mockReturnValue(nextRefreshAt(FIXED_NOW) + 1000);
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // The shortlist has not moved, and the page says a new one exists.
      expect(
        within(seat)
          .getAllByRole('listitem')
          .map((item) => item.querySelector('.hq-card__name')?.textContent),
      ).toEqual(before);
      const take = screen.getByRole('button', { name: /Show today’s shortlist/ });

      act(() => {
        fireEvent.click(take);
      });
      const after = within(screen.getByRole('region', { name: 'Route Planner' }))
        .getAllByRole('listitem')
        .map((item) => item.querySelector('.hq-card__name')?.textContent);
      expect(after).not.toEqual(before);
      expect(screen.queryByRole('button', { name: /Show today’s shortlist/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts no information in a tooltip alone', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/headquarters']}>
        <HeadquartersPage />
      </MemoryRouter>,
    );
    // Both `title`s the page used to carry were duplicates of visible text, and
    // one of them sat on an `aria-hidden` span where nothing could reach it.
    expect(container.querySelectorAll('.hq-page [title]')).toHaveLength(0);
    const gate = screen.getByRole('region', { name: 'Safety & Compliance' });
    expect(within(gate).getByText(/unreachable until this seat is filled/)).toBeInTheDocument();
  });

  it('dresses its controls from the shared button hierarchy', async () => {
    renderPage();
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    const given = routePlannerShortlist[0]!.name.split(' ')[0]!;
    const hire = within(seat).getByRole('button', { name: new RegExp(`^Hire ${given}$`) });
    // A hire is one of four peers on the seat, so it is secondary rather than
    // dominant; the confirmed dismissal is the destructive variant.
    expect(hire.className).toContain('btn--secondary');
    await waitFor(() => expect(hire).toBeEnabled());
    fireEvent.click(hire);
    await within(seat).findByText(/Seat filled by/);
    fireEvent.click(within(seat).getByRole('button', { name: 'Let go' }));
    expect(
      within(seat).getByRole('button', { name: `Confirm — let ${given} go` }).className,
    ).toContain('btn--danger');
  });

  it('saves a disruption policy from the modal', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Policies' }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByRole('radio', { name: /Policy/i }));
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.change(within(dialog).getByLabelText(/Cancel delays longer than/i), {
      target: { value: '90' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save policy/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(automation.settings).toEqual([
      {
        system: 'disruption',
        mode: 'policy',
        policy: { disruptionResponse: { cancelDelaysOverMinutes: 90 } },
      },
    ]);
  });
});

describe('the HQ layout overview', () => {
  const cell = (container: HTMLElement, seat: string): HTMLElement => {
    const el = container.querySelector<HTMLElement>(`.hq-cell[data-seat="${seat}"]`);
    if (el === null) throw new Error(`no cell for ${seat}`);
    return el;
  };

  const emptyOffice = (neutralSeats: number): OfficeStateResponse => ({
    hires: [],
    hasExtendedAuthority: false,
    neutralSeats,
    nextExpansion:
      neutralSeats < 4
        ? { addsSeats: 2, totalSeats: neutralSeats + 8, costMinor: 1_000_000_000 }
        : null,
    offeredSpecialist: 'social-media-reputation',
  });

  it('shows all six offices vacant when nothing is hired', () => {
    const { container } = render(<HqLayoutPanel office={emptyOffice(0)} />);
    for (const role of HQ_ROLES) {
      const el = cell(container, role.id);
      expect(el.dataset.occupied).toBe('false');
      expect(within(el).getByText('Vacant')).toBeInTheDocument();
      expect(el.querySelector('img')).toBeNull();
    }
    // With no expansion, the two neutral offices are not on the plan.
    expect(container.querySelector('.hq-cell[data-seat="neutral-1"]')).toBeNull();
    const count = container.querySelector('.hq-layout__count');
    expect(count?.textContent).toContain('0 of 6 offices staffed');
  });

  it('adds the neutral offices once expanded', () => {
    const { container } = render(<HqLayoutPanel office={emptyOffice(2)} />);
    expect(cell(container, 'neutral-1').dataset.occupied).toBe('false');
    expect(cell(container, 'neutral-2').dataset.occupied).toBe('false');
    expect(container.querySelector('.hq-cell[data-seat="neutral-3"]')).toBeNull();
    expect(container.querySelector('.hq-layout__count')?.textContent).toContain(
      '0 of 8 offices staffed',
    );
  });

  it('shows the expand button under the map and drives onExpand', async () => {
    const onExpand = vi.fn().mockResolvedValue({ ok: true });
    render(<HqLayoutPanel office={emptyOffice(0)} onExpand={onExpand} />);
    const button = screen.getByRole('button', { name: /expand/i });
    fireEvent.click(button);
    await waitFor(() => expect(onExpand).toHaveBeenCalledTimes(1));
  });

  it('hides the expand button when no expansion handler is wired', () => {
    render(<HqLayoutPanel office={emptyOffice(0)} />);
    expect(screen.queryByRole('button', { name: /expand/i })).toBeNull();
  });

  it('renders a rounded avatar and the occupant name for a filled seat', () => {
    const mara = HQ_CANDIDATES.find((c) => c.id === 'route-planner-mara')!;
    const office: OfficeStateResponse = {
      hires: [
        {
          seat: 'route-planner',
          candidateId: mara.id,
          candidateName: mara.name,
          monthlySalaryMinor: 1_800_000,
          hiredAt: '2024-10-20T00:00:00.000Z',
        },
      ],
      hasExtendedAuthority: false,
      neutralSeats: 0,
      nextExpansion: null,
      offeredSpecialist: 'social-media-reputation',
    };
    const { container } = render(<HqLayoutPanel office={office} />);

    const filled = cell(container, 'route-planner');
    expect(filled.dataset.occupied).toBe('true');
    const avatar = filled.querySelector<HTMLImageElement>('img.hq-cell__avatar');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute('src')).toBe(mara.portrait);
    expect(avatar?.getAttribute('alt')).toMatch(/Mara Ellison/);
    expect(within(filled).getByText('Mara Ellison')).toBeInTheDocument();

    // The seats it did not fill stay vacant.
    expect(cell(container, 'safety-compliance').dataset.occupied).toBe('false');
  });

  it('notes long-haul authority once the gate seat is filled', () => {
    render(
      <HqLayoutPanel
        office={{
          hires: [
            {
              seat: 'safety-compliance',
              candidateId: 'safety-compliance-claire',
              candidateName: 'Claire Fontaine',
              monthlySalaryMinor: 3_000_000,
              hiredAt: '2024-10-20T00:00:00.000Z',
            },
          ],
          hasExtendedAuthority: true,
          neutralSeats: 0,
          nextExpansion: null,
          offeredSpecialist: 'social-media-reputation',
        }}
      />,
    );
    expect(screen.getByText(/long-haul authority/i)).toBeInTheDocument();
  });
});
