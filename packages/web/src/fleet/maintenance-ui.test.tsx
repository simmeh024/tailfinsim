import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BookCheckResponse,
  MaintenanceAirframeView,
  MaintenanceResponse,
  MaintenanceTierView,
} from '@tailfin/shared';

import { setDisplayCurrency } from '../currency/display';

import { CHECK_STALLED_AFTER_GAME_MINUTES, statusPresentation } from './maintenance-presentation';
import { MaintenancePlanner } from './MaintenancePlanner';

/**
 * Maintenance planning on the Fleet page (SURFACE-04).
 *
 * The figures are the server's; what is tested is what the page *says* about
 * them, because every one of SURFACE-04's risks is a sentence: a null history
 * read as zero, a stalled check read as a running one, a refused booking that
 * nonetheless changed what is on screen, a price the client made up.
 */

/** The world's clock, injected: everything below is derived from it. */
const GAME_NOW = new Date(Date.UTC(2031, 4, 10, 12, 0));
const DAY = 86_400_000;

function iso(offsetMs: number): string {
  return new Date(GAME_NOW.getTime() + offsetMs).toISOString();
}

function tier(overrides: Partial<MaintenanceTierView> & Pick<MaintenanceTierView, 'tier'>) {
  return {
    hoursRemaining: 400,
    cyclesRemaining: 300,
    binding: 'hours' as const,
    usedFraction: 0.2,
    due: false,
    costMinor: 1_800_000,
    downtimeDays: 1,
    ...overrides,
  } satisfies MaintenanceTierView;
}

function airframe(overrides: Partial<MaintenanceAirframeView> = {}): MaintenanceAirframeView {
  return {
    airframeId: '11111111-1111-4111-8111-111111111111',
    registration: 'PH-TFA',
    typeDesignation: 'A320neo',
    maintenanceProfile: 'narrowbody',
    status: 'in_service',
    checkTier: null,
    checkCompletesAt: null,
    totalHours: 1_240,
    totalCycles: 610,
    historyRecorded: true,
    technicalRisk: 0.004,
    airworthy: true,
    dueTiers: [],
    tiers: [
      tier({ tier: 'a' }),
      tier({
        tier: 'c',
        hoursRemaining: 6_000,
        usedFraction: 0.1,
        costMinor: 42_000_000,
        downtimeDays: 14,
      }),
      tier({
        tier: 'd',
        hoursRemaining: 20_000,
        usedFraction: 0.05,
        costMinor: 300_000_000,
        downtimeDays: 35,
      }),
    ],
    ...overrides,
  };
}

/** A pre-M4-06 airframe: real hours, no recorded history — read as last checked at those hours. */
const UNRECORDED = airframe({
  airframeId: '22222222-2222-4222-8222-222222222222',
  registration: 'PH-OLD',
  totalHours: 24_000,
  totalCycles: 19_000,
  historyRecorded: false,
  tiers: [
    tier({ tier: 'a', hoursRemaining: 500, cyclesRemaining: 400, usedFraction: 0 }),
    tier({
      tier: 'c',
      hoursRemaining: 6_000,
      usedFraction: 0,
      costMinor: 42_000_000,
      downtimeDays: 14,
    }),
    tier({
      tier: 'd',
      hoursRemaining: 24_000,
      usedFraction: 0,
      costMinor: 300_000_000,
      downtimeDays: 35,
    }),
  ],
});

const DUE = airframe({
  airframeId: '33333333-3333-4333-8333-333333333333',
  registration: 'PH-DUE',
  technicalRisk: 0.042,
  dueTiers: ['a'],
  tiers: [
    tier({ tier: 'a', hoursRemaining: -180, usedFraction: 1.36, due: true }),
    tier({
      tier: 'c',
      hoursRemaining: 3_000,
      usedFraction: 0.55,
      costMinor: 42_000_000,
      downtimeDays: 14,
    }),
    tier({
      tier: 'd',
      hoursRemaining: 15_000,
      usedFraction: 0.3,
      costMinor: 300_000_000,
      downtimeDays: 35,
    }),
  ],
});

interface Server {
  maintenance: MaintenanceResponse | 'fail' | 'pending';
  booking?: { status: number; body: unknown };
  /** Every request, for asserting what the client sent and what it did not. */
  calls: { url: string; method: string; body: unknown }[];
}

function serve(server: Server): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      server.calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      const json = (status: number, body: unknown) =>
        Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });

      if (url === '/api/world/clock') {
        return json(200, {
          worldId: 'world',
          serverTime: new Date().toISOString(),
          inGameTime: GAME_NOW.toISOString(),
          speedMultiplier: 2,
        });
      }
      if (url === '/api/fleet/maintenance' && method === 'GET') {
        if (server.maintenance === 'pending') return new Promise(() => undefined);
        if (server.maintenance === 'fail') return json(500, {});
        return json(200, server.maintenance);
      }
      if (url === '/api/fleet/maintenance/checks' && method === 'POST') {
        const booking = server.booking ?? { status: 500, body: {} };
        return json(booking.status, booking.body);
      }
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setDisplayCurrency('USD', []);
});

describe('the four states', () => {
  it('says it is loading while the read is in flight', () => {
    serve({ maintenance: 'pending', calls: [] });
    render(<MaintenancePlanner />);
    expect(screen.getByRole('status')).toHaveTextContent(/Reading the fleet’s maintenance/);
  });

  it('says it could not load, rather than showing an empty fleet', async () => {
    serve({ maintenance: 'fail', calls: [] });
    render(<MaintenancePlanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Could not load the fleet’s maintenance/,
    );
  });

  it('says there is nothing to maintain when there is no aircraft', async () => {
    serve({ maintenance: { airframes: [] }, calls: [] });
    render(<MaintenancePlanner />);
    expect(await screen.findByText(/No aircraft to maintain yet/)).toBeInTheDocument();
  });
});

describe('a null maintenance history (SURFACE-04’s fourth point)', () => {
  it('reads as last completed at the hours it has now — never as zero, never overdue', async () => {
    serve({ maintenance: { airframes: [UNRECORDED] }, calls: [] });
    render(<MaintenancePlanner />);

    // The row in "Every aircraft", which carries the history note.
    const row = (await screen.findAllByRole('row')).find(
      (r) => r.getAttribute('data-status') !== null && r.textContent?.includes('PH-OLD'),
    );
    if (row === undefined) throw new Error('no row for PH-OLD');
    // Said in words, with the hours it is counted from.
    expect(row).toHaveTextContent(
      /No maintenance history recorded: every check counts as last completed at the 24,000 h and 19,000 cycles it has now/,
    );
    // And the figure is the server's remaining interval, not a count from hour zero.
    expect(row).toHaveTextContent(/A-check in 500 h/);
    expect(row.textContent).not.toMatch(/\d[\d,]* (h|cycles?) overdue/);
    expect(row.textContent).not.toMatch(/\b0 h\b/);
    expect(row.textContent).not.toMatch(/24,000 h overdue/);
  });

  it('says nothing about history for an airframe whose history is recorded', async () => {
    serve({ maintenance: { airframes: [airframe()] }, calls: [] });
    render(<MaintenancePlanner />);
    expect((await screen.findAllByText('PH-TFA', { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No maintenance history recorded/)).toBeNull();
  });
});

describe('what is coming due across the fleet', () => {
  it('lists the fleet’s next checks, the most used interval first, leaving out aircraft in a check', async () => {
    const inCheck = airframe({
      airframeId: '44444444-4444-4444-8444-444444444444',
      registration: 'PH-HGR',
      status: 'in_check',
      checkTier: 'c',
      checkCompletesAt: iso(5 * DAY),
    });
    serve({ maintenance: { airframes: [DUE, airframe(), inCheck] }, calls: [] });
    render(<MaintenancePlanner />);

    const heading = await screen.findByRole('heading', { name: 'Coming due' });
    const table = heading.parentElement?.querySelector('table');
    if (!table) throw new Error('no coming-due table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent(/PH-DUE.*A-check.*180 h overdue/);
    expect(rows.some((r) => r.textContent?.includes('PH-HGR'))).toBe(false);
  });
});

describe('status, with room for a hold the game adds later', () => {
  it('tells a running check from one nothing will finish', async () => {
    const running = airframe({
      registration: 'PH-RUN',
      status: 'in_check',
      checkTier: 'a',
      checkCompletesAt: iso(DAY),
    });
    const stalled = airframe({
      airframeId: '55555555-5555-4555-8555-555555555555',
      registration: 'PH-STL',
      status: 'in_check',
      checkTier: 'a',
      checkCompletesAt: iso(-(CHECK_STALLED_AFTER_GAME_MINUTES + 30) * 60_000),
    });
    serve({ maintenance: { airframes: [running, stalled] }, calls: [] });
    render(<MaintenancePlanner />);

    const rowOf = async (registration: string) =>
      (await screen.findAllByRole('row')).find(
        (r) => r.getAttribute('data-status') !== null && r.textContent?.includes(registration),
      );
    await waitFor(async () => {
      expect(await rowOf('PH-STL')).toHaveTextContent(/Check not completing/);
    });
    expect(await rowOf('PH-STL')).toHaveTextContent(/none has run since/);
    expect(await rowOf('PH-RUN')).toHaveTextContent(/In check/);
    expect(await rowOf('PH-RUN')).toHaveTextContent(/back in service 2031-05-11/);
    expect((await rowOf('PH-RUN'))?.textContent).not.toMatch(/not completing/);
  });

  it('tells in-check from grounded, and draws a status it does not know as a hold', () => {
    expect(statusPresentation(airframe({ status: 'grounded' }), GAME_NOW).label).toBe('Grounded');
    expect(
      statusPresentation(
        airframe({ status: 'in_check', checkTier: 'c', checkCompletesAt: iso(DAY) }),
        GAME_NOW,
      ).label,
    ).toBe('In check');
    // SAFETY-05's regulatory hold, arriving from a newer server than this build.
    const held = statusPresentation(
      airframe({ status: 'regulatory_hold' as MaintenanceAirframeView['status'] }),
      GAME_NOW,
    );
    expect(held.label).toBe('Held');
    expect(held.tone).toBe('cancelled');
    expect(held.detail).toMatch(/regulatory hold/);
  });
});

describe('booking a check', () => {
  const BOOKED: BookCheckResponse = {
    airframeId: DUE.airframeId,
    tier: 'a',
    costMinor: 1_800_000,
    completesAt: iso(DAY),
  };

  it('states the server’s cost and downtime before committing, and sends only the tier', async () => {
    const server: Server = {
      maintenance: { airframes: [DUE] },
      booking: { status: 201, body: BOOKED },
      calls: [],
    };
    serve(server);
    render(<MaintenancePlanner />);

    const bookRow = (await screen.findAllByRole('row')).find(
      (r) => r.getAttribute('data-status') !== null && r.textContent?.includes('PH-DUE'),
    );
    if (!bookRow) throw new Error('no row');
    fireEvent.click(within(bookRow).getByRole('button', { name: 'Book a check' }));

    const panel = await screen.findByRole('region', { name: /Book a check — PH-DUE/ });
    // The due tier is preselected, and its consequence is stated beside the button.
    expect(within(panel).getByRole('radio', { name: /A-check/ })).toBeChecked();
    expect(panel).toHaveTextContent(/technical-fault risk — 4.2% now — rises/);
    const book = within(panel).getByRole('button', { name: /Book A-check/ });
    expect(book).toHaveTextContent('Book A-check — $18,000, 1 game day out of service');

    // The D-check quotes its own server price and downtime too.
    expect(
      within(panel)
        .getByRole('radio', { name: /D-check/ })
        .closest('label'),
    ).toHaveTextContent(/\$3,000,000.*35 game days out/);

    fireEvent.click(book);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'A-check booked for PH-DUE: $18,000, back in service 2031-05-11.',
    );

    const post = server.calls.find((call) => call.method === 'POST');
    // SEC-09: an airframe and a tier, and no price, duration or date.
    expect(post?.body).toEqual({ airframeId: DUE.airframeId, tier: 'a' });
    // The fleet is re-read from the server rather than edited in place.
    expect(server.calls.filter((call) => call.url === '/api/fleet/maintenance')).toHaveLength(2);
  });

  it('leaves the page as it was when the server refuses, and says why', async () => {
    const server: Server = {
      maintenance: { airframes: [DUE] },
      booking: {
        status: 422,
        body: { code: 'insufficient_funds', message: 'The airline cannot afford that check' },
      },
      calls: [],
    };
    serve(server);
    render(<MaintenancePlanner preselect={DUE.airframeId} />);

    const panel = await screen.findByRole('region', { name: /Book a check — PH-DUE/ });
    fireEvent.click(within(panel).getByRole('button', { name: /Book A-check/ }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'The airline cannot afford that check',
    );
    // Nothing re-read, nothing claimed: the fleet on screen is the fleet as it was.
    expect(server.calls.filter((call) => call.url === '/api/fleet/maintenance')).toHaveLength(1);
    expect(screen.queryByText(/booked for/)).toBeNull();
    expect(screen.getAllByText(/180 h overdue/).length).toBeGreaterThan(0);
  });

  it('will not offer a second check on an aircraft already in one', async () => {
    const inCheck = airframe({ status: 'in_check', checkTier: 'a', checkCompletesAt: iso(DAY) });
    serve({ maintenance: { airframes: [inCheck] }, calls: [] });
    render(<MaintenancePlanner preselect={inCheck.airframeId} />);

    const panel = await screen.findByRole('region', { name: /Book a check — PH-TFA/ });
    expect(within(panel).queryByRole('button', { name: /Book A-check/ })).toBeNull();
    expect(panel).toHaveTextContent(/already in a check/);
  });
});

describe('money through the display currency (M8-02)', () => {
  it('shows every quote in the player’s chosen currency', async () => {
    setDisplayCurrency('EUR', [
      {
        code: 'EUR',
        name: 'Euro',
        symbol: '€',
        decimals: 2,
        rateE6: 500_000,
        refreshedAt: '2031-01-01T00:00:00.000Z',
        top: true,
      },
    ]);
    serve({ maintenance: { airframes: [DUE] }, calls: [] });
    render(<MaintenancePlanner />);

    const heading = await screen.findByRole('heading', { name: 'Coming due' });
    const table = heading.parentElement?.querySelector('table');
    if (!table) throw new Error('no table');
    // $18,000 at 0.5 is €9,000, in the euro's own symbol.
    expect(within(table).getAllByText('€9,000').length).toBeGreaterThan(0);
    expect(table.textContent).not.toMatch(/\$/);
  });
});
