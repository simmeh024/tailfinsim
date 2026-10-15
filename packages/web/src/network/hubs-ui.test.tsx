import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  HubCandidate,
  HubCandidateListResponse,
  HubFacilityView,
  HubsResponse,
  HubView,
} from '@tailfin/shared';

import { setDisplayCurrency } from '../currency/display';

import { NetworkPage } from './NetworkPage';
import { HubsView } from './planner/HubsView';

/**
 * Hubs on the Network page (SURFACE-09, M7-04, App. B.5).
 *
 * The figures below are deliberately not App. B.5's table and do not follow its
 * curve: a page that rendered `$2,000,000` because it multiplied something would
 * pass a test written with the design's numbers, and fail these. Every price on
 * screen has to be one the stubbed server sent.
 */

const HUB_ID = '11111111-1111-4111-8111-111111111111';
const NEW_HUB_ID = '22222222-2222-4222-8222-222222222222';

function facility(overrides: Partial<HubFacilityView> & Pick<HubFacilityView, 'kind'>) {
  return {
    openedAt: null,
    openingCostMinor: 123_456_700,
    annualFeeMinor: 9_876_500,
    blockedBy: null,
    ...overrides,
  } satisfies HubFacilityView;
}

function facilities(
  overrides: Partial<Record<HubFacilityView['kind'], Partial<HubFacilityView>>> = {},
) {
  return (
    [
      ['lounge', 111_111_100, 2_222_200],
      ['training_academy', 133_333_300, 3_333_300],
      ['maintenance_line', 155_555_500, 4_444_400],
      ['self_handling', 177_777_700, 5_555_500],
      ['heavy_check', 199_999_900, 6_666_600],
    ] as const
  ).map(([kind, openingCostMinor, annualFeeMinor]) =>
    facility({
      kind,
      openingCostMinor,
      annualFeeMinor,
      blockedBy: kind === 'heavy_check' ? 'requires_maintenance_line' : null,
      ...overrides[kind],
    }),
  );
}

function hub(overrides: Partial<HubView> = {}): HubView {
  return {
    id: HUB_ID,
    airportIdent: 'EHAM',
    airportIcao: 'EHAM',
    airportIata: 'AMS',
    airportName: 'Amsterdam Airport Schiphol',
    tier: 'large',
    founderGrant: true,
    purchaseCostMinor: 0,
    openedAt: '2031-05-01T00:00:00.000Z',
    annualFeeMinor: 31_415_900,
    totalAnnualFeeMinor: 31_415_900,
    facilities: facilities(),
    ...overrides,
  };
}

function hubs(overrides: Partial<HubsResponse> = {}): HubsResponse {
  return {
    hubs: [hub()],
    totalAnnualFeeMinor: 31_415_900,
    nextHub: {
      hubsOwned: 1,
      small: 234_567_800,
      medium: 345_678_900,
      large: 456_789_000,
      flagship: 567_890_100,
    },
    ...overrides,
  };
}

function candidate(overrides: Partial<HubCandidate> = {}): HubCandidate {
  return {
    ident: 'LEBL',
    icao: 'LEBL',
    iata: 'BCN',
    name: 'Barcelona El Prat',
    city: 'Barcelona',
    country: 'ES',
    airportTier: 'large',
    tier: 'large',
    purchaseCostMinor: 456_789_000,
    annualFeeMinor: 27_182_800,
    slots: { slotLevel: 3, coordinated: true, capacityPerBand: 4, bandsFull: 7 },
    alreadyHeld: false,
    ...overrides,
  };
}

const REGIONAL = candidate({
  ident: 'EHRD',
  icao: 'EHRD',
  iata: 'RTM',
  name: 'Rotterdam The Hague',
  city: 'Rotterdam',
  country: 'NL',
  airportTier: 'regional',
  tier: 'small',
  purchaseCostMinor: 234_567_800,
  annualFeeMinor: 1_618_000,
  slots: { slotLevel: 1, coordinated: false, capacityPerBand: 0, bandsFull: 0 },
});

const HELD = candidate({
  ident: 'EHAM',
  icao: 'EHAM',
  iata: 'AMS',
  name: 'Amsterdam Airport Schiphol',
  city: 'Amsterdam',
  country: 'NL',
  alreadyHeld: true,
});

function candidates(
  airports: HubCandidate[] = [candidate(), REGIONAL, HELD],
  query = 'a',
): HubCandidateListResponse {
  return { airports, query, nextHub: hubs().nextHub };
}

/** The whole state after buying LEBL — figures that no client arithmetic produces. */
const AFTER_PURCHASE = hubs({
  hubs: [
    hub(),
    hub({
      id: NEW_HUB_ID,
      airportIdent: 'LEBL',
      airportIcao: 'LEBL',
      airportIata: 'BCN',
      airportName: 'Barcelona El Prat',
      founderGrant: false,
      purchaseCostMinor: 456_789_000,
      annualFeeMinor: 27_182_800,
      totalAnnualFeeMinor: 27_182_800,
    }),
  ],
  totalAnnualFeeMinor: 58_598_700,
  nextHub: {
    hubsOwned: 2,
    small: 777_777_700,
    medium: 888_888_800,
    large: 999_999_900,
    flagship: 1_010_101_000,
  },
});

type Answer = { status: number; body: unknown } | 'pending' | 'reject';

interface Server {
  /** Each GET /api/hubs takes the next answer; the last one repeats. */
  hubs: Answer[];
  candidates: Answer[];
  write?: Answer;
  calls: { url: string; method: string; body: unknown }[];
}

function serve(server: Server): void {
  const next = (queue: Answer[]): Answer =>
    (queue.length > 1 ? queue.shift() : queue[0]) ?? 'reject';
  const answer = (value: Answer) => {
    if (value === 'pending') return new Promise(() => undefined);
    if (value === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve({
      ok: value.status < 300,
      status: value.status,
      json: () => Promise.resolve(value.body),
    });
  };
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
      if (method === 'GET' && url === '/api/hubs') return answer(next(server.hubs));
      if (method === 'GET' && url.startsWith('/api/hubs/candidates')) {
        return answer(next(server.candidates));
      }
      if (method === 'POST' && url.startsWith('/api/hubs')) {
        return answer(server.write ?? 'reject');
      }
      // The Network page's own reads, when it is rendered whole.
      if (url === '/api/routes') return answer({ status: 200, body: { routes: [] } });
      if (url.startsWith('/api/fleet/airframes')) {
        return answer({ status: 200, body: { airframes: [] } });
      }
      if (url.startsWith('/api/schedules')) return answer({ status: 200, body: { schedules: [] } });
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    }),
  );
}

function ok(body: unknown): Answer {
  return { status: 200, body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setDisplayCurrency('USD', []);
  window.history.replaceState(null, '', '/');
});

function posts(server: Server) {
  return server.calls.filter((call) => call.method === 'POST');
}

function reads(server: Server, prefix: string) {
  return server.calls.filter((call) => call.method === 'GET' && call.url.startsWith(prefix));
}

async function searchFor(text: string): Promise<HTMLElement> {
  fireEvent.change(screen.getByPlaceholderText('ICAO, IATA, name or city'), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  return screen.findByRole('region', { name: 'Hub candidates' });
}

function hubPanel(name: RegExp): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('the states', () => {
  it('says it is reading the hubs while it is', async () => {
    serve({ hubs: ['pending'], candidates: [], calls: [] });
    render(<HubsView />);
    expect(await screen.findByRole('status')).toHaveTextContent('Reading your hubs…');
  });

  it('says so when the hubs cannot be read, and offers nothing to buy beside it', async () => {
    serve({ hubs: [{ status: 500, body: {} }], candidates: [], calls: [] });
    render(<HubsView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your hubs.');
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('shows a refused read with the server’s words and its code', async () => {
    serve({
      hubs: [
        {
          status: 409,
          body: {
            code: 'airline_required',
            message: 'Found an airline in the active world before using this feature',
          },
        },
      ],
      candidates: [],
      calls: [],
    });
    render(<HubsView />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-state', 'refused');
    expect(alert).toHaveTextContent(
      'Found an airline in the active world before using this feature',
    );
    expect(within(alert).getByText('airline_required')).toBeInTheDocument();
  });

  it('says when the airline holds no hub', async () => {
    serve({ hubs: [ok(hubs({ hubs: [], totalAnnualFeeMinor: 0 }))], candidates: [], calls: [] });
    render(<HubsView />);
    expect(await screen.findByText(/You hold no hub yet/)).toBeInTheDocument();
  });

  it('prices nothing until asked, then says it is pricing, empty, or broken', async () => {
    const server: Server = {
      hubs: [ok(hubs())],
      candidates: ['pending'],
      calls: [],
    };
    serve(server);
    render(<HubsView />);
    await screen.findByRole('heading', { name: 'Your hubs' });
    // Never on mount, never on a keystroke.
    fireEvent.change(screen.getByPlaceholderText('ICAO, IATA, name or city'), {
      target: { value: 'barc' },
    });
    expect(reads(server, '/api/hubs/candidates')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Pricing airports for “barc”…')).toBeInTheDocument();
    expect(reads(server, '/api/hubs/candidates').map((call) => call.url)).toEqual([
      '/api/hubs/candidates?query=barc',
    ]);
  });

  it('tells an empty answer from a broken one', async () => {
    serve({
      hubs: [ok(hubs())],
      candidates: [ok(candidates([], 'zzz')), { status: 500, body: {} }],
      calls: [],
    });
    render(<HubsView />);
    await screen.findByRole('heading', { name: 'Your hubs' });
    fireEvent.change(screen.getByPlaceholderText('ICAO, IATA, name or city'), {
      target: { value: 'zzz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const empty = await screen.findByText(/No airport with scheduled service matches “zzz”/);
    expect(empty.closest('[data-state]')).toHaveAttribute('data-state', 'empty');

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not price airports for “zzz”.',
    );
  });
});

describe('the hubs held', () => {
  it('shows each hub with the server’s fees, and every facility with its price', async () => {
    serve({ hubs: [ok(hubs())], candidates: [], calls: [] });
    render(<HubsView />);
    const panel = await screen.findByRole('region', { name: /Amsterdam Airport Schiphol/ });
    expect(panel).toHaveTextContent('Founder hub');
    expect(panel).toHaveTextContent('Large');
    expect(panel).toHaveTextContent(
      'Opened 2031-05-01. The hub itself costs $314,159 a year; with what is built here, $314,159 a year',
    );
    const lounge = within(panel).getByRole('row', { name: /Lounge/ });
    expect(lounge).toHaveTextContent('$1,111,111');
    expect(lounge).toHaveTextContent('$22,222');
    expect(within(lounge).getByRole('button', { name: 'Build — $1,111,111' })).toBeEnabled();
    expect(screen.getByText(/1 hub · \$314,159 a year in hub fees/)).toBeInTheDocument();
  });

  it('says heavy check waits for the maintenance line, and offers no button for it', async () => {
    serve({ hubs: [ok(hubs())], candidates: [], calls: [] });
    render(<HubsView />);
    const panel = await screen.findByRole('region', { name: /Amsterdam Airport Schiphol/ });
    const heavy = within(panel).getByRole('row', { name: /Heavy check capability/ });
    expect(heavy).toHaveTextContent('Needs the maintenance line');
    expect(within(heavy).queryByRole('button')).toBeNull();
  });

  it('shows a built facility as built, with its pinned fee and no build price', async () => {
    serve({
      hubs: [
        ok(
          hubs({
            hubs: [
              hub({
                totalAnnualFeeMinor: 35_860_300,
                facilities: facilities({
                  lounge: { openedAt: '2031-05-20T00:00:00.000Z', blockedBy: 'already_open' },
                }),
              }),
            ],
          }),
        ),
      ],
      candidates: [],
      calls: [],
    });
    render(<HubsView />);
    const panel = await screen.findByRole('region', { name: /Amsterdam Airport Schiphol/ });
    const lounge = within(panel).getByRole('row', { name: /Lounge/ });
    expect(lounge).toHaveTextContent('Built 2031-05-20');
    expect(lounge).toHaveTextContent('$22,222');
    expect(lounge).not.toHaveTextContent('$1,111,111');
    expect(within(lounge).queryByRole('button')).toBeNull();
    expect(panel).toHaveTextContent('with what is built here, $358,603 a year');
  });

  it('shows the next hub’s price at all four tiers, as the server quoted them', async () => {
    serve({ hubs: [ok(hubs())], candidates: [], calls: [] });
    render(<HubsView />);
    const tiles = await screen.findByRole('group', { name: 'The next hub’s price at each tier' });
    expect(tiles).toHaveTextContent('Small$2,345,678');
    expect(tiles).toHaveTextContent('Medium$3,456,789');
    expect(tiles).toHaveTextContent('Large$4,567,890');
    expect(tiles).toHaveTextContent('Flagship$5,678,901');
  });

  it('converts every figure at the display-currency boundary', async () => {
    setDisplayCurrency('EUR', [
      {
        code: 'EUR',
        name: 'Euro',
        symbol: '€',
        decimals: 2,
        rateE6: 500_000,
        refreshedAt: '1965-01-01T00:00:00.000Z',
        top: true,
      },
    ]);
    serve({ hubs: [ok(hubs())], candidates: [], calls: [] });
    render(<HubsView />);
    const tiles = await screen.findByRole('group', { name: 'The next hub’s price at each tier' });
    expect(tiles).toHaveTextContent('Small€1,172,839');
    expect(screen.getByRole('button', { name: 'Build — €555,556' })).toBeInTheDocument();
  });

  it('scrolls each facility table inside its own labelled, focusable box', async () => {
    serve({ hubs: [ok(hubs())], candidates: [], calls: [] });
    render(<HubsView />);
    const box = await screen.findByRole('region', { name: 'Facilities at EHAM / AMS' });
    expect(box).toHaveAttribute('tabindex', '0');
    expect(box).toHaveClass('net-table-scroll');
    expect(within(box).getByRole('table')).toBeInTheDocument();
  });
});

describe('the candidates', () => {
  it('shows each candidate’s price, fee and slots, and marks one already held', async () => {
    serve({ hubs: [ok(hubs())], candidates: [ok(candidates())], calls: [] });
    render(<HubsView />);
    await screen.findByRole('heading', { name: 'Your hubs' });
    const table = await searchFor('a');
    expect(table).toHaveAttribute('tabindex', '0');
    expect(table).toHaveClass('net-table-scroll');

    const barcelona = within(table).getByRole('row', { name: /Barcelona El Prat/ });
    expect(barcelona).toHaveTextContent('$4,567,890');
    expect(barcelona).toHaveTextContent('$271,828');
    expect(barcelona).toHaveTextContent(
      'Level 3 — coordinated: 4 airlines a band, 7 of 24 bands full',
    );

    const rotterdam = within(table).getByRole('row', { name: /Rotterdam The Hague/ });
    expect(rotterdam).toHaveTextContent('Regional tier, priced as small');
    // An uncoordinated airport's zeros are said, not shown as a cap of zero.
    expect(rotterdam).toHaveTextContent('Level 1 — not coordinated; nothing here waits for a slot');
    expect(rotterdam).not.toHaveTextContent('0 airlines');

    const held = within(table).getByRole('row', { name: /Amsterdam Airport Schiphol/ });
    expect(held).toHaveTextContent('Your hub');
    expect(within(held).queryByRole('button')).toBeNull();
  });

  it('searches for the airport a deep link names, once, on arrival', async () => {
    const server: Server = { hubs: [ok(hubs())], candidates: [ok(candidates())], calls: [] };
    serve(server);
    render(<HubsView initialQuery="LEBL" />);
    expect(await screen.findByRole('region', { name: 'Hub candidates' })).toBeInTheDocument();
    expect(reads(server, '/api/hubs/candidates').map((call) => call.url)).toEqual([
      '/api/hubs/candidates?query=LEBL',
    ]);
  });
});

describe('buying a hub', () => {
  it('quotes first and sends nothing until the second click, then takes the whole state', async () => {
    const server: Server = {
      hubs: [ok(hubs())],
      candidates: [ok(candidates()), ok(candidates([candidate({ alreadyHeld: true })]))],
      write: ok(AFTER_PURCHASE),
      calls: [],
    };
    serve(server);
    render(<HubsView />);
    await screen.findByRole('heading', { name: 'Your hubs' });
    const table = await searchFor('a');

    fireEvent.click(within(table).getByRole('button', { name: 'Buy — $4,567,890' }));
    expect(posts(server)).toHaveLength(0);
    const confirm = screen.getByRole('region', { name: 'Confirm the purchase' });
    // App. B.5: the fee and the slot scarcity are on screen before anything is charged.
    expect(confirm).toHaveTextContent(
      'Barcelona El Prat (LEBL / BCN) as your next hub: $4,567,890 now, then $271,828 a year before any facility',
    );
    expect(confirm).toHaveTextContent(
      'Its slots are coordinated (Level 3): 4 airlines may hold any hourly band, and 7 of the day’s 24 are already full.',
    );

    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm — buy for $4,567,890' }));

    expect(await screen.findByRole('region', { name: /Barcelona El Prat/ })).toBeInTheDocument();
    expect(posts(server)).toEqual([
      {
        url: '/api/hubs',
        method: 'POST',
        body: { airportIdent: 'LEBL', expectedCostMinor: 456_789_000 },
      },
    ]);
    expect(
      screen.getByText('Barcelona El Prat is now one of your hubs, bought for $4,567,890.'),
    ).toHaveAttribute('role', 'status');
    // The server's whole state: the next hub is priced from its answer, not ours.
    const tiles = screen.getByRole('group', { name: 'The next hub’s price at each tier' });
    expect(tiles).toHaveTextContent('Small$7,777,777');
    expect(tiles).toHaveTextContent('Flagship$10,101,010');
    expect(screen.getByText(/2 hubs · \$585,987 a year in hub fees/)).toBeInTheDocument();
    // Every candidate's price moved, so the list on screen is re-read once.
    await waitFor(() => {
      expect(reads(server, '/api/hubs/candidates')).toHaveLength(2);
    });
    // And the hub list was not re-fetched: the write's answer is the state.
    expect(reads(server, '/api/hubs').filter((call) => call.url === '/api/hubs')).toHaveLength(1);
  });

  it('sends nothing when the player keeps looking', async () => {
    const server: Server = { hubs: [ok(hubs())], candidates: [ok(candidates())], calls: [] };
    serve(server);
    render(<HubsView />);
    await screen.findByRole('heading', { name: 'Your hubs' });
    const table = await searchFor('a');
    fireEvent.click(within(table).getByRole('button', { name: 'Buy — $2,345,678' }));
    const confirm = screen.getByRole('region', { name: 'Confirm the purchase' });
    expect(confirm).toHaveTextContent(
      'Its slots are not coordinated: nothing here is refused for want of a slot.',
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep looking' }));
    expect(screen.queryByRole('region', { name: 'Confirm the purchase' })).toBeNull();
    expect(posts(server)).toHaveLength(0);
  });

  it('leaves the hubs as they were on a refusal, shows its code, and does not retry', async () => {
    const server: Server = {
      hubs: [ok(hubs())],
      candidates: [ok(candidates())],
      write: {
        status: 422,
        body: { code: 'insufficient_funds', message: 'Not enough cash for that purchase' },
      },
      calls: [],
    };
    serve(server);
    render(<HubsView />);
    await screen.findByRole('heading', { name: 'Your hubs' });
    const table = await searchFor('a');
    fireEvent.click(within(table).getByRole('button', { name: 'Buy — $4,567,890' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm — buy for $4,567,890' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-state', 'refused');
    expect(alert).toHaveTextContent('Not enough cash for that purchase');
    expect(within(alert).getByText('insufficient_funds')).toBeInTheDocument();
    // Nothing changed on screen, and a second purchase starts from Buy again.
    expect(screen.queryByRole('region', { name: /Barcelona El Prat/ })).toBeNull();
    expect(screen.getAllByRole('region', { name: /Amsterdam Airport Schiphol/ })).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Confirm the purchase' })).toBeNull();
    expect(
      screen.getByRole('group', { name: 'The next hub’s price at each tier' }),
    ).toHaveTextContent('Small$2,345,678');
    expect(posts(server)).toHaveLength(1);
    expect(reads(server, '/api/hubs/candidates')).toHaveLength(1);
  });

  it('re-reads the quote when the price moved, and makes the player confirm the new one', async () => {
    const requoted = candidates([candidate({ purchaseCostMinor: 913_578_000 })]);
    const server: Server = {
      hubs: [ok(hubs()), ok(hubs({ nextHub: { ...hubs().nextHub, hubsOwned: 2 } }))],
      candidates: [ok(candidates()), ok(requoted)],
      write: {
        status: 409,
        body: {
          code: 'hub_cost_changed',
          message:
            'The price has changed since it was quoted. Re-read the quote and confirm the new figure.',
        },
      },
      calls: [],
    };
    serve(server);
    render(<HubsView />);
    await screen.findByRole('heading', { name: 'Your hubs' });
    const table = await searchFor('a');
    fireEvent.click(within(table).getByRole('button', { name: 'Buy — $4,567,890' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm — buy for $4,567,890' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('hub_cost_changed')).toBeInTheDocument();
    // The new figure is on screen, and nothing has been sent at it.
    expect(await screen.findByRole('button', { name: 'Buy — $9,135,780' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Confirm the purchase' })).toBeNull();
    expect(posts(server)).toHaveLength(1);
    await waitFor(() => {
      expect(reads(server, '/api/hubs').filter((call) => call.url === '/api/hubs')).toHaveLength(2);
    });
  });

  it('says a purchase whose answer never came could have gone through, and does not retry', async () => {
    const server: Server = {
      hubs: [ok(hubs())],
      candidates: [ok(candidates())],
      write: 'reject',
      calls: [],
    };
    serve(server);
    render(<HubsView />);
    await screen.findByRole('heading', { name: 'Your hubs' });
    const table = await searchFor('a');
    fireEvent.click(within(table).getByRole('button', { name: 'Buy — $4,567,890' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm — buy for $4,567,890' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-state', 'broken');
    expect(alert).toHaveTextContent(/it may have gone through, and it is not retried for you/);
    expect(posts(server)).toHaveLength(1);
  });
});

describe('building a facility', () => {
  it('quotes on the button, sends the kind and the quoted cost on the second click, and takes the answer', async () => {
    const built = hubs({
      hubs: [
        hub({
          totalAnnualFeeMinor: 35_860_300,
          facilities: facilities({
            maintenance_line: { openedAt: '2031-06-02T00:00:00.000Z', blockedBy: 'already_open' },
            heavy_check: { blockedBy: null },
          }),
        }),
      ],
      totalAnnualFeeMinor: 35_860_300,
    });
    const server: Server = { hubs: [ok(hubs())], candidates: [], write: ok(built), calls: [] };
    serve(server);
    render(<HubsView />);
    const panel = await screen.findByRole('region', { name: /Amsterdam Airport Schiphol/ });
    const line = within(panel).getByRole('row', { name: /Maintenance line/ });

    fireEvent.click(within(line).getByRole('button', { name: 'Build — $1,555,555' }));
    expect(posts(server)).toHaveLength(0);
    fireEvent.click(within(line).getByRole('button', { name: 'Confirm — build for $1,555,555' }));

    await waitFor(() => {
      expect(
        within(hubPanel(/Amsterdam Airport Schiphol/)).getByRole('row', {
          name: /Maintenance line/,
        }),
      ).toHaveTextContent('Built 2031-06-02');
    });
    expect(posts(server)).toEqual([
      {
        url: `/api/hubs/${HUB_ID}/facilities`,
        method: 'POST',
        body: { kind: 'maintenance_line', expectedCostMinor: 155_555_500 },
      },
    ]);
    // Heavy check unblocked because the server said so, not because the page inferred it.
    const heavy = within(hubPanel(/Amsterdam Airport Schiphol/)).getByRole('row', {
      name: /Heavy check capability/,
    });
    expect(within(heavy).getByRole('button', { name: 'Build — $1,999,999' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Maintenance line built at EHAM / AMS.');
  });

  it('shows a refused build in the hub it was about, with its code, and changes nothing', async () => {
    const server: Server = {
      hubs: [ok(hubs())],
      candidates: [],
      write: {
        status: 409,
        body: {
          code: 'facility_already_open',
          message: 'That facility is already open at this hub',
        },
      },
      calls: [],
    };
    serve(server);
    render(<HubsView />);
    const panel = await screen.findByRole('region', { name: /Amsterdam Airport Schiphol/ });
    const lounge = within(panel).getByRole('row', { name: /Lounge/ });
    fireEvent.click(within(lounge).getByRole('button', { name: 'Build — $1,111,111' }));
    fireEvent.click(within(lounge).getByRole('button', { name: 'Confirm — build for $1,111,111' }));

    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('That facility is already open at this hub');
    expect(within(alert).getByText('facility_already_open')).toBeInTheDocument();
    // Still unbuilt, and a second build starts from its own first click again.
    const after = within(panel).getByRole('row', { name: /Lounge/ });
    expect(after).not.toHaveTextContent('Built');
    expect(within(after).getByRole('button', { name: 'Build — $1,111,111' })).toBeEnabled();
    expect(posts(server)).toHaveLength(1);
  });

  it('cancels a build with Keep, sending nothing', async () => {
    const server: Server = { hubs: [ok(hubs())], candidates: [], calls: [] };
    serve(server);
    render(<HubsView />);
    const panel = await screen.findByRole('region', { name: /Amsterdam Airport Schiphol/ });
    const lounge = within(panel).getByRole('row', { name: /Lounge/ });
    fireEvent.click(within(lounge).getByRole('button', { name: 'Build — $1,111,111' }));
    fireEvent.click(within(lounge).getByRole('button', { name: 'Keep' }));
    expect(within(lounge).getByRole('button', { name: 'Build — $1,111,111' })).toBeEnabled();
    expect(posts(server)).toHaveLength(0);
  });
});

describe('its home on the Network page', () => {
  it('is a view of the page, reached from the view switch', async () => {
    const server: Server = { hubs: [ok(hubs())], candidates: [], calls: [] };
    serve(server);
    render(<NetworkPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Hubs' }));
    expect(await screen.findByRole('heading', { name: 'Your hubs' })).toBeInTheDocument();
  });

  it('opens on the Hubs view with an airport priced from a deep link', async () => {
    window.history.replaceState(null, '', '/network?view=hubs&station=lebl');
    const server: Server = { hubs: [ok(hubs())], candidates: [ok(candidates())], calls: [] };
    serve(server);
    render(<NetworkPage />);
    expect(await screen.findByRole('tab', { name: 'Hubs' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByRole('region', { name: 'Hub candidates' })).toBeInTheDocument();
    expect(reads(server, '/api/hubs/candidates').map((call) => call.url)).toEqual([
      '/api/hubs/candidates?query=LEBL',
    ]);
  });
});
