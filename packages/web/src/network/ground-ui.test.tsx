import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  GroundContractAlert,
  GroundContractsResponse,
  GroundContractView,
  GroundServiceLineView,
  GroundStationResponse,
} from '@tailfin/shared';

import { setDisplayCurrency } from '../currency/display';

import { spanInWords, termPresentation } from './ground-presentation';
import { GroundHandlingView } from './planner/GroundHandlingView';

/**
 * Ground handling per station (SURFACE-05).
 *
 * The figures are the server's. The tests are about the sentences, because the
 * issue's risks are sentences: a legacy contract's null term read as *expired*,
 * a term that should have lapsed read as *active*, a full vendor read as an
 * error, a refused signing that changed what is on screen anyway.
 */

/** The world's clock, injected. Every instant below is derived from it. */
const GAME_NOW = new Date(Date.UTC(2031, 4, 10, 12, 0));
const DAY = 86_400_000;

function iso(offsetMs: number): string {
  return new Date(GAME_NOW.getTime() + offsetMs).toISOString();
}

const CONTRACT_ID = '66666666-6666-4666-8666-666666666666';
const SELF_ID = '77777777-7777-4777-8777-777777777777';

function vendorContract(overrides: Partial<GroundContractView> = {}): GroundContractView {
  return {
    id: CONTRACT_ID,
    serviceLine: 'ramp_baggage',
    kind: 'vendor',
    grade: 'budget',
    headcount: null,
    staffing: null,
    termEnd: iso(30 * DAY),
    expiring: false,
    committedDepartures: 0,
    earlyTerminationPenaltyMinor: 900_000,
    ...overrides,
  };
}

function line(overrides: Partial<GroundServiceLineView> = {}): GroundServiceLineView {
  return {
    serviceLine: 'ramp_baggage',
    contracted: null,
    offers: [
      {
        grade: 'budget',
        capacity: 6,
        taken: 2,
        reliability: 0.9,
        speedFactor: 1.1,
        quality: 0.6,
        priceIndex: 0.85,
        committedDepartures: 0,
        fullTermPenaltyMinor: 1_200_000,
      },
      {
        grade: 'standard',
        capacity: 4,
        taken: 1,
        reliability: 0.95,
        speedFactor: 1,
        quality: 0.75,
        priceIndex: 1,
        committedDepartures: 63,
        fullTermPenaltyMinor: 1_200_000,
      },
      {
        grade: 'premium',
        capacity: 2,
        taken: 2,
        reliability: 0.98,
        speedFactor: 0.9,
        quality: 0.9,
        priceIndex: 1.3,
        committedDepartures: 180,
        fullTermPenaltyMinor: 1_560_000,
      },
    ],
    selfHandling: {
      available: true,
      unavailableReason: null,
      requiredHeadcount: 18,
      salaryPerHeadMinor: 150_000,
    },
    walkUpPriceIndex: 1.35,
    ...overrides,
  };
}

function station(lines: GroundServiceLineView[] = [line()]): GroundStationResponse {
  return { icao: 'EHAM', lines };
}

function alertRow(overrides: Partial<GroundContractAlert> = {}): GroundContractAlert {
  return {
    id: CONTRACT_ID,
    icao: 'EHAM',
    serviceLine: 'ramp_baggage',
    kind: 'vendor',
    grade: 'budget',
    headcount: null,
    staffing: null,
    termEnd: iso(30 * DAY),
    expiring: false,
    committedDepartures: 63,
    departuresFlown: 41,
    shortfallFeeMinor: 880_000,
    earlyTerminationPenaltyMinor: 900_000,
    ...overrides,
  };
}

interface Server {
  contracts: GroundContractsResponse | 'fail';
  station: GroundStationResponse | 'fail' | 'pending';
  /** What any write answers. */
  write?: { status: number; body: unknown };
  speed?: number;
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
          speedMultiplier: server.speed ?? 2,
        });
      }
      if (method === 'GET' && url === '/api/ground/contracts') {
        return server.contracts === 'fail' ? json(500, {}) : json(200, server.contracts);
      }
      if (method === 'GET' && url.startsWith('/api/ground/')) {
        if (server.station === 'pending') return new Promise(() => undefined);
        return server.station === 'fail' ? json(500, {}) : json(200, server.station);
      }
      if (method !== 'GET' && url.startsWith('/api/ground/')) {
        const write = server.write ?? { status: 500, body: {} };
        return json(write.status, write.body);
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

async function lineSection(name: string): Promise<HTMLElement> {
  return screen.findByRole('region', { name });
}

describe('the states', () => {
  it('says when nothing is arranged anywhere, and when it could not read', async () => {
    serve({ contracts: { contracts: [] }, station: station(), calls: [] });
    render(<GroundHandlingView airports={['EHAM']} />);
    expect(await screen.findByText(/Nothing arranged anywhere/)).toBeInTheDocument();
  });

  it('says it is reading a station, and says so when it cannot', async () => {
    serve({ contracts: { contracts: [] }, station: 'pending', calls: [] });
    const pending = render(<GroundHandlingView airports={['EHAM']} />);
    expect(await screen.findByText(/Reading the station’s handlers/)).toBeInTheDocument();
    pending.unmount();

    serve({ contracts: 'fail', station: 'fail', calls: [] });
    render(<GroundHandlingView airports={['EHAM']} />);
    expect(await screen.findByText(/Could not load this station’s handlers/)).toBeInTheDocument();
    expect(
      await screen.findByText(/Could not load your handling arrangements/),
    ).toBeInTheDocument();
  });

  it('asks for a route when there is no station to show', async () => {
    serve({ contracts: { contracts: [] }, station: station(), calls: [] });
    render(<GroundHandlingView airports={[]} />);
    expect(await screen.findByText(/Open a route first/)).toBeInTheDocument();
  });
});

describe('the term', () => {
  it('reads a null term as no term — never expired, never a past date (with a test, as asked)', () => {
    const legacy = termPresentation(
      { kind: 'vendor', termEnd: null, expiring: false },
      GAME_NOW,
      2,
    );
    expect(legacy.label).toBe('No term');
    expect(legacy.detail).toBe('Signed before contracts had terms. It does not lapse.');
    expect(`${legacy.label} ${legacy.detail}`).not.toMatch(/expired|lapsed|1970/i);
  });

  it('renders a legacy contract’s null term as no term on the page', async () => {
    serve({
      contracts: {
        contracts: [alertRow({ termEnd: null, committedDepartures: null, departuresFlown: null })],
      },
      station: station([line({ contracted: vendorContract({ termEnd: null }) })]),
      calls: [],
    });
    render(<GroundHandlingView airports={['EHAM']} />);
    const section = await lineSection('Ramp and baggage');
    expect(within(section).getByText('No term')).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/Past its term|expired/i);
  });

  it('gives the world date, and the real time it is at this world’s speed', () => {
    // The same 30 game days: half the real time at 4× that it is at 2×.
    expect(spanInWords(30 * DAY, 2)).toBe('30 game days — about 15 real days at 2×');
    expect(spanInWords(30 * DAY, 4)).toBe('30 game days — about 7.5 real days at 4×');
    const at4 = termPresentation(
      { kind: 'vendor', termEnd: iso(30 * DAY), expiring: false },
      GAME_NOW,
      4,
    );
    expect(at4.detail).toBe('Ends 2031-06-09, in 30 game days — about 7.5 real days at 4×.');
  });

  it('shows a term at a 4× world on the page in world dates and real days', async () => {
    serve({
      contracts: { contracts: [alertRow()] },
      station: station([line({ contracted: vendorContract() })]),
      speed: 4,
      calls: [],
    });
    render(<GroundHandlingView airports={['EHAM']} />);
    const section = await lineSection('Ramp and baggage');
    await waitFor(() => {
      expect(section).toHaveTextContent(
        /Ends 2031-06-09, in 30 game days — about 7.5 real days at 4×/,
      );
    });
  });

  it('tells a term that should have lapsed from an active one', () => {
    const lapsing = termPresentation(
      { kind: 'vendor', termEnd: iso(5 * DAY), expiring: true },
      GAME_NOW,
      2,
    );
    expect(lapsing.label).toBe('Lapsing soon');
    const overdue = termPresentation(
      { kind: 'vendor', termEnd: iso(-2 * DAY), expiring: true },
      GAME_NOW,
      2,
    );
    expect(overdue.label).toBe('Past its term');
    expect(overdue.detail).toMatch(/none has run since/);
    // Self-handling has no counterparty and so no term.
    expect(
      termPresentation({ kind: 'self', termEnd: null, expiring: false }, GAME_NOW, 2).label,
    ).toBe('No term');
  });
});

describe('scarcity, and self-handling as the alternative', () => {
  it('presents a full vendor as a market fact, with signing it disabled rather than refused', async () => {
    serve({ contracts: { contracts: [] }, station: station(), calls: [] });
    render(<GroundHandlingView airports={['EHAM']} />);
    const section = await lineSection('Ramp and baggage');
    const premium = within(section).getByRole('row', { name: /Premium/ });
    expect(premium).toHaveTextContent(/Full — all 2 slots are held by airlines in this world/);
    expect(within(premium).getByRole('button', { name: /Sign premium/ })).toBeDisabled();
    // Not an error: nothing on the page is an alert.
    expect(screen.queryByRole('alert')).toBeNull();
    // The others say how much is left.
    expect(within(section).getByRole('row', { name: /Standard/ })).toHaveTextContent(
      '3 of 4 slots free',
    );
  });

  it('scrolls each table inside its own labelled, focusable box on a narrow screen', async () => {
    // UX-09's pattern, as the Slots and Gates views use it (`.net-table-scroll`).
    serve({ contracts: { contracts: [alertRow()] }, station: station(), calls: [] });
    render(<GroundHandlingView airports={['EHAM']} />);
    for (const name of ['Your handling arrangements', 'Handlers for Ramp and baggage at EHAM']) {
      const box = await screen.findByRole('region', { name });
      expect(box).toHaveAttribute('tabindex', '0');
      expect(box).toHaveClass('net-table-scroll');
      expect(within(box).getByRole('table')).toBeInTheDocument();
    }
  });

  it('states the self-handling trade, and why it is not available without a hub', async () => {
    serve({
      contracts: { contracts: [] },
      station: station([
        line(),
        line({
          serviceLine: 'cleaning',
          selfHandling: {
            available: false,
            unavailableReason: 'needs_hub',
            requiredHeadcount: 18,
            salaryPerHeadMinor: 150_000,
          },
        }),
      ]),
      calls: [],
    });
    render(<GroundHandlingView airports={['EHAM']} />);
    const ramp = await lineSection('Ramp and baggage');
    expect(ramp).toHaveTextContent(
      /fixed cost against per-turn cost: 18 heads .* \$1,500 a head a month/,
    );
    expect(
      within(ramp).getByRole('button', { name: /Handle it yourself — 18 heads, \$27,000 a month/ }),
    ).toBeEnabled();
    const cleaning = await lineSection('Cleaning');
    expect(cleaning).toHaveTextContent(/you have no hub at EHAM/);
    expect(within(cleaning).queryByRole('button', { name: /Handle it yourself/ })).toBeNull();
  });
});

describe('the writes', () => {
  it('signs with a line and a grade and nothing else, and takes the station the server answers', async () => {
    const signed = station([line({ contracted: vendorContract({ grade: 'standard' }) })]);
    const server: Server = {
      contracts: { contracts: [] },
      station: station(),
      write: { status: 200, body: signed },
      calls: [],
    };
    serve(server);
    render(<GroundHandlingView airports={['EHAM']} />);
    const section = await lineSection('Ramp and baggage');
    fireEvent.click(within(section).getByRole('button', { name: 'Sign standard' }));

    await waitFor(() => {
      expect(
        within(screen.getByRole('region', { name: 'Ramp and baggage' })).getByText('Yours'),
      ).toBeInTheDocument();
    });
    const post = server.calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe('/api/ground/EHAM/contracts');
    expect(post?.body).toEqual({ serviceLine: 'ramp_baggage', grade: 'standard' });
    // The network list is re-read, because an arrangement changed.
    expect(server.calls.filter((call) => call.url === '/api/ground/contracts')).toHaveLength(2);
  });

  it('leaves the station as it was when a signing is refused, and says why', async () => {
    const server: Server = {
      contracts: { contracts: [] },
      station: station(),
      write: {
        status: 422,
        body: {
          code: 'capacity_exhausted',
          message: 'That handler is full — every contract slot is taken',
        },
      },
      calls: [],
    };
    serve(server);
    render(<GroundHandlingView airports={['EHAM']} />);
    const section = await lineSection('Ramp and baggage');
    fireEvent.click(within(section).getByRole('button', { name: 'Sign standard' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That handler is full — every contract slot is taken',
    );
    // Same offers, nothing marked as yours, the network list not re-read.
    const after = screen.getByRole('region', { name: 'Ramp and baggage' });
    expect(within(after).queryByText('Yours')).toBeNull();
    expect(within(after).getByRole('row', { name: /Standard/ })).toHaveTextContent(
      '3 of 4 slots free',
    );
    expect(server.calls.filter((call) => call.url === '/api/ground/contracts')).toHaveLength(1);
  });

  it('ends a contract, opens and closes an operation, through their own routes', async () => {
    const withContract = station([line({ contracted: vendorContract() })]);
    const withSelf = station([
      line({
        contracted: {
          ...vendorContract({
            id: SELF_ID,
            kind: 'self',
            grade: null,
            headcount: 12,
            staffing: 0.67,
          }),
          termEnd: null,
          committedDepartures: null,
          earlyTerminationPenaltyMinor: 0,
        },
      }),
    ]);
    const server: Server = {
      contracts: { contracts: [] },
      station: withContract,
      write: { status: 200, body: station() },
      calls: [],
    };
    serve(server);
    const first = render(<GroundHandlingView airports={['EHAM']} />);
    let section = await lineSection('Ramp and baggage');
    fireEvent.click(
      within(section).getByRole('button', { name: /End the contract — \$9,000 to break it now/ }),
    );
    await waitFor(() => {
      expect(server.calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    expect(server.calls.find((call) => call.method === 'DELETE')?.url).toBe(
      `/api/ground/contracts/${CONTRACT_ID}`,
    );
    first.unmount();

    server.calls = [];
    server.station = withSelf;
    serve(server);
    const second = render(<GroundHandlingView airports={['EHAM']} />);
    section = await lineSection('Ramp and baggage');
    fireEvent.click(within(section).getByRole('button', { name: /Close the operation/ }));
    await waitFor(() => {
      expect(server.calls.find((call) => call.method === 'DELETE')?.url).toBe(
        `/api/ground/self-handling/${SELF_ID}`,
      );
    });
    second.unmount();

    server.calls = [];
    server.station = station();
    serve(server);
    render(<GroundHandlingView airports={['EHAM']} />);
    section = await lineSection('Ramp and baggage');
    fireEvent.click(within(section).getByRole('button', { name: /Handle it yourself/ }));
    await waitFor(() => {
      expect(server.calls.find((call) => call.method === 'POST')?.body).toEqual({
        serviceLine: 'ramp_baggage',
        headcount: 18,
      });
    });
    expect(server.calls.find((call) => call.method === 'POST')?.url).toBe(
      '/api/ground/EHAM/self-handling',
    );
  });
});

describe('the lapse warning’s destination', () => {
  it('opens on the contract an alert names, at its station, with what it costs to leave', async () => {
    serve({
      contracts: { contracts: [alertRow({ icao: 'LFPG', expiring: true, termEnd: iso(4 * DAY) })] },
      station: {
        icao: 'LFPG',
        lines: [line({ contracted: vendorContract({ expiring: true, termEnd: iso(4 * DAY) }) })],
      },
      calls: [],
    });
    render(<GroundHandlingView airports={['EHAM']} initialContract={CONTRACT_ID} />);

    const row = await screen.findByRole('row', { current: true });
    expect(row).toHaveTextContent(/LFPG.*Ramp and baggage.*Lapsing soon/);
    expect(row).toHaveTextContent(/41 of 63 departures flown/);
    expect(await screen.findByRole('heading', { name: 'Station LFPG' })).toBeInTheDocument();
  });
});

describe('money through the display currency (M8-02)', () => {
  it('shows fees and payroll in the player’s chosen currency', async () => {
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
    serve({ contracts: { contracts: [alertRow()] }, station: station(), calls: [] });
    render(<GroundHandlingView airports={['EHAM']} />);
    const section = await lineSection('Ramp and baggage');
    // $1,500 a head is €750; $27,000 a month is €13,500.
    expect(section).toHaveTextContent(/€750 a head a month/);
    expect(within(section).getByRole('button', { name: /€13,500 a month/ })).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/\$/);
  });
});
