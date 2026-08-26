import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OfficeStateResponse } from '@tailfin/shared';

import { HeadquartersPage } from './HeadquartersPage';
import { candidatesForRole, HQ_CANDIDATES, HQ_ROLES } from './hq-roster';
import { HqLayoutPanel } from './HqLayoutPanel';

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

  it('carries a market of candidates, three each for all six seats', () => {
    expect(candidatesForRole('route-planner').map((c) => c.name)).toEqual([
      'Mara Ellison',
      'Tom Bakker',
      'Victor Lindqvist',
    ]);
    expect(candidatesForRole('revenue-manager').map((c) => c.name)).toEqual([
      'Kenji Tan',
      'Sofía Reyes',
      'Anders Holm',
    ]);
    expect(candidatesForRole('ops-controller').map((c) => c.name)).toEqual([
      'Diego Alvarez',
      'Marta Silva',
      'Jun Park',
    ]);
    expect(candidatesForRole('chief-pilot').map((c) => c.name)).toEqual([
      'Sten Halvorsen',
      'Fiona Brennan',
      'Grant Wexford',
    ]);
    expect(candidatesForRole('ground-ops').map((c) => c.name)).toEqual([
      'Nadia Kovač',
      'Omar Haddad',
      'Luca Moretti',
    ]);
    expect(candidatesForRole('safety-compliance').map((c) => c.name)).toEqual([
      'Claire Fontaine',
      'Hiroshi Tanaka',
      'Emma Larsson',
    ]);
    // Every candidate names a real seat and carries a portrait.
    const roleIds = new Set(HQ_ROLES.map((role) => role.id));
    for (const candidate of HQ_CANDIDATES) {
      expect(roleIds.has(candidate.roleId), candidate.id).toBe(true);
      expect(candidate.portrait, candidate.id).toBeTruthy();
    }
    // Ids are unique.
    const ids = HQ_CANDIDATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
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

  function officeState() {
    return {
      hires: hires.map((h) => ({
        ...h,
        monthlySalaryMinor: 1_000_000,
        hiredAt: '2024-10-20T00:00:00.000Z',
      })),
      hasExtendedAuthority: hires.some((h) => h.seat === 'safety-compliance'),
      neutralSeats: 0,
      nextExpansion: { addsSeats: 2, totalSeats: 8, costMinor: 1_000_000_000 },
    };
  }

  beforeEach(() => {
    hires = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? 'GET';
        const ok = () =>
          Promise.resolve(new Response(JSON.stringify(officeState()), { status: 200 }));
        if (url === '/api/office' && method === 'GET') return ok();
        if (url === '/api/office/hires' && method === 'POST') {
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
  });

  it('shows every seat and every candidate', async () => {
    render(<HeadquartersPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Headquarters' })).toBeInTheDocument();
    for (const role of HQ_ROLES) {
      expect(screen.getByRole('heading', { level: 2, name: role.role })).toBeInTheDocument();
    }
    for (const candidate of HQ_CANDIDATES) {
      expect(screen.getByText(candidate.name)).toBeInTheDocument();
    }
    // The office loads empty from the server.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(`0 of ${String(HQ_ROLES.length)} seats`),
    );
  });

  it('starts every candidate greyed, and colours the one hired', async () => {
    render(<HeadquartersPage />);
    const mara = HQ_CANDIDATES.find((c) => c.id === 'route-planner-mara')!;
    const card = screen.getByText(mara.name).closest<HTMLElement>('.hq-card');
    if (!card) throw new Error('no card for Mara');
    const portrait = card.querySelector<HTMLElement>('.hq-card__portrait');
    if (!portrait) throw new Error('no portrait');

    expect(portrait.dataset.hired).toBe('false');
    const hireMara = within(card).getByRole('button', { name: /Hire Mara/i });
    await waitFor(() => expect(hireMara).toBeEnabled());
    fireEvent.click(hireMara);
    await waitFor(() => expect(portrait.dataset.hired).toBe('true'));
    expect(screen.getByRole('status')).toHaveTextContent('1 of');
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    expect(within(seat).getByText(/Seat filled by Mara Ellison/i)).toBeInTheDocument();
  });

  it('holds one person per seat — hiring a rival swaps, it does not stack', async () => {
    render(<HeadquartersPage />);
    const seat = screen.getByRole('region', { name: 'Route Planner' });

    const hireMara = within(seat).getByRole('button', { name: /Hire Mara/i });
    await waitFor(() => expect(hireMara).toBeEnabled());
    fireEvent.click(hireMara);
    await within(seat).findByText(/Seat filled by Mara Ellison/i);
    fireEvent.click(within(seat).getByRole('button', { name: /Hire Tom/i }));
    await within(seat).findByText(/Seat filled by Tom Bakker/i);

    expect(screen.getByRole('status')).toHaveTextContent('1 of');
    const maraCard = within(seat).getByText('Mara Ellison').closest<HTMLElement>('.hq-card');
    const tomCard = within(seat).getByText('Tom Bakker').closest<HTMLElement>('.hq-card');
    expect(maraCard?.dataset.hired).toBe('false');
    expect(tomCard?.dataset.hired).toBe('true');
  });

  it('renders the seats the server already reports as filled, on load', async () => {
    hires = [
      {
        seat: 'safety-compliance',
        candidateId: 'safety-compliance-claire',
        candidateName: 'Claire Fontaine',
      },
    ];
    render(<HeadquartersPage />);
    const seat = screen.getByRole('region', { name: 'Safety & Compliance' });
    expect(await within(seat).findByText(/Seat filled by Claire Fontaine/i)).toBeInTheDocument();
    // Filling the gate seat unlocks long-haul authority, and the page says so.
    expect(await screen.findByText(/long-haul authority unlocked/i)).toBeInTheDocument();
  });

  it('flags the seat that gates long-haul authority', () => {
    render(<HeadquartersPage />);
    const seat = screen.getByRole('region', { name: 'Safety & Compliance' });
    expect(within(seat).getByText('Gate')).toBeInTheDocument();
    const gate = seat.querySelector('.hq-card__gate');
    expect(gate?.textContent?.toLowerCase()).toContain('long-haul');
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
        }}
      />,
    );
    expect(screen.getByText(/long-haul authority/i)).toBeInTheDocument();
  });
});
