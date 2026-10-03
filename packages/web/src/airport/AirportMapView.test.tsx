import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import {
  ApronResponse,
  type AirportGatesResponse,
  type AirportStand,
  type StandKind,
} from '@tailfin/shared';

import { AirportMapView } from './AirportMapView';

/**
 * The airport map (M7-07, App. B.7), driven through mocked fetch.
 *
 * The claims worth a test each:
 *
 *   - **the three stand states read as three things** — yours in your colour,
 *     a rival's muted and named, an unleased one in outline — and the exclusive
 *     lease is marked;
 *   - **the rings are the real turn on the world's clock**, at the response's
 *     `gameNow` and then at the live clock once it syncs;
 *   - **the heat overlay** tells your idle stands from your jammed ones;
 *   - **leasing and releasing on the map** post exactly what the gates page
 *     posts, fold the answer in, and release only after the two-step confirm;
 *   - **zooming out past the widest view, or the back control, calls `onExit`**.
 *
 * Fixtures are parsed through `ApronResponse`, so one that drifts from the wire
 * contract fails loudly here. Every instant is derived from one anchor, and the
 * clock is the game's, never the wall's.
 */

const GAME_NOW_MS = Date.UTC(2031, 5, 1, 9, 0);
const MINUTE = 60_000;
const at = (minutes: number) => new Date(GAME_NOW_MS + minutes * MINUTE).toISOString();

const YOU = {
  airlineId: '11111111-1111-4111-8111-111111111111',
  name: 'Tailfin Test Air',
  iataCode: 'TT',
  colour: '#3366cc',
  isYou: true,
};
const RIVAL = {
  airlineId: '22222222-2222-4222-8222-222222222222',
  name: 'Rival Air',
  iataCode: 'RV',
  colour: '#aa5500',
  isYou: false,
};

const FEES = { common_use: 0, preferential: 12_000_000, exclusive: 30_000_000 };

function stand(
  position: string,
  kind: StandKind,
  overrides: Partial<AirportStand> = {},
): AirportStand {
  return {
    position,
    kind,
    holders: [],
    yourContract: null,
    exclusivelyHeld: false,
    available: true,
    utilisation: null,
    annualFeeMinor: FEES,
    commonUseTurnFeeMinor: 25_000,
    ...overrides,
  };
}

const youHold = (contract: 'preferential' | 'exclusive') => ({
  airlineId: YOU.airlineId,
  name: YOU.name,
  iataCode: YOU.iataCode,
  contract,
  isYou: true,
});
const rivalHolds = (contract: 'preferential' | 'exclusive') => ({
  airlineId: RIVAL.airlineId,
  name: RIVAL.name,
  iataCode: RIVAL.iataCode,
  contract,
  isYou: false,
});

/** A small airport's apron (M7-06's `small` inventory), with every state on it. */
function gates(changes: Record<string, Partial<AirportStand>> = {}): AirportGatesResponse {
  const stands: AirportStand[] = [
    stand('A1', 'contact_gate', {
      holders: [youHold('preferential')],
      yourContract: 'preferential',
      utilisation: { turns: 6, occupiedMinutes: 900, fraction: 0.88, belowFloor: false },
    }),
    stand('A2', 'contact_gate', {
      holders: [youHold('preferential')],
      yourContract: 'preferential',
      utilisation: { turns: 1, occupiedMinutes: 50, fraction: 0.05, belowFloor: true },
    }),
    stand('A3', 'contact_gate', { holders: [rivalHolds('preferential')] }),
    stand('A4', 'contact_gate', {
      holders: [rivalHolds('exclusive')],
      exclusivelyHeld: true,
      available: false,
    }),
    stand('A5', 'contact_gate'),
    stand('A6', 'contact_gate'),
    ...['R1', 'R2', 'R3', 'R4'].map((p) => stand(p, 'remote_stand')),
    ...['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((p) => stand(p, 'overnight_parking')),
    stand('C1', 'cargo_stand'),
    stand('M1', 'maintenance_stand'),
  ].map((row) => ({ ...row, ...changes[row.position] }));
  return {
    icao: 'EHAM',
    name: 'Amsterdam Schiphol',
    tier: 'small',
    stands,
    requirement: {
      contactGates: 2,
      contactGatesHeld: 2,
      overnightPositions: 0,
      overnightPositionsHeld: 0,
      percentileConcurrency: 1.2,
      peakConcurrency: 2,
      turns: 7,
      sampledGameDate: at(0),
    },
    monthlyFeeMinor: 2_000_000,
    leaseBreakevenTurnsPerMonth: 40,
  };
}

function apron(overrides: Partial<ApronResponse> = {}): ApronResponse {
  return ApronResponse.parse({
    icao: 'EHAM',
    name: 'Amsterdam Schiphol',
    tier: 'small',
    gameNow: at(0),
    you: YOU,
    gates: gates(),
    runways: [{ ident: '09/27', lengthFt: 11_000, widthFt: 150, headingDeg: 87 }],
    aircraft: [
      {
        key: 'flight-1',
        airline: YOU,
        registration: 'PH-TTA',
        typeDesignation: 'A320neo',
        size: 'narrowbody',
        standPosition: 'A1',
        // A sixty-minute turn, a quarter of the way through at gameNow.
        arrivedAt: at(-15),
        departsAt: at(45),
        nextDestinationIcao: 'EGLL',
        flightId: '33333333-3333-4333-8333-333333333333',
      },
      {
        key: 'flight-2',
        airline: RIVAL,
        registration: 'RV-ABC',
        typeDesignation: 'B737',
        size: 'narrowbody',
        standPosition: 'A3',
        arrivedAt: at(-5),
        departsAt: at(30),
        nextDestinationIcao: 'LFPG',
        flightId: null,
      },
      {
        key: 'flight-3',
        airline: YOU,
        registration: 'PH-TTB',
        typeDesignation: 'E195',
        size: 'regional',
        standPosition: null,
        arrivedAt: at(-60),
        departsAt: null,
        nextDestinationIcao: null,
        flightId: null,
      },
    ],
    movements: [
      {
        kind: 'arrival',
        at: at(0.5),
        airline: RIVAL,
        typeDesignation: 'B737',
        otherIcao: 'LFPG',
      },
      {
        kind: 'departure',
        at: at(10),
        airline: YOU,
        typeDesignation: 'A320neo',
        otherIcao: 'EGLL',
      },
    ],
    standDays: [
      {
        position: 'A1',
        turns: [
          {
            arrivedAt: at(-120),
            departsAt: at(-75),
            registration: 'PH-TTA',
            fromIcao: 'EGLL',
            toIcao: 'LEMD',
          },
        ],
        utilisation: { turns: 6, occupiedMinutes: 900, fraction: 0.88, belowFloor: false },
      },
    ],
    ...overrides,
  });
}

type Reply = { status: number; body: unknown } | 'pending';

/** Routes `fetch` by method and path. The world clock answers 409 unless a test says otherwise. */
function stubFetch(routes: {
  apron?: () => Reply;
  clock?: () => Reply;
  lease?: (body: unknown) => Reply;
  release?: (path: string) => Reply;
}) {
  const mock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let reply: Reply = { status: 404, body: {} };
    if (url.endsWith('/apron')) reply = routes.apron?.() ?? { status: 200, body: apron() };
    else if (url === '/api/world/clock') reply = routes.clock?.() ?? { status: 409, body: {} };
    else if (method === 'POST' && url === '/api/airports/EHAM/gates') {
      const sent = typeof init?.body === 'string' ? init.body : '';
      reply = routes.lease?.(JSON.parse(sent)) ?? { status: 500, body: {} };
    } else if (method === 'DELETE') reply = routes.release?.(url) ?? { status: 500, body: {} };
    if (reply === 'pending') return new Promise<Response>(() => undefined);
    const { status, body } = reply;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderMap(onExit = vi.fn(), icao = 'EHAM') {
  render(
    <MemoryRouter>
      <AirportMapView icao={icao} onExit={onExit} />
    </MemoryRouter>,
  );
  return onExit;
}

/** The schematic, once the apron has loaded. */
async function loaded(): Promise<HTMLElement> {
  return screen.findByRole('group', { name: 'Schematic of Amsterdam Schiphol' });
}

function standElement(position: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${position}, `) });
}

function ring(aircraftKey: string, phase: string): Element | null {
  return document.querySelector(`[data-aircraft="${aircraftKey}"] [data-phase="${phase}"]`);
}

describe('the stands', () => {
  it('draws yours in your colour, a rival’s muted and named, and an unleased one in outline', async () => {
    stubFetch({});
    renderMap();
    await loaded();

    const yours = standElement('A1');
    expect(yours).toHaveAttribute('data-state', 'yours');
    expect(yours.getAttribute('aria-label')).toContain('held by You (preferential)');
    expect(yours.querySelector('.apron-stand__shape')).toHaveStyle({ fill: '#3366cc' });

    const rival = standElement('A3');
    expect(rival).toHaveAttribute('data-state', 'rival');
    expect(rival.getAttribute('aria-label')).toContain('held by Rival Air (preferential)');

    const open = standElement('A5');
    expect(open).toHaveAttribute('data-state', 'open');
    expect(open.getAttribute('aria-label')).toContain('unleased');

    const exclusive = standElement('A4');
    expect(exclusive).toHaveAttribute('data-exclusive', 'true');
    expect(exclusive.getAttribute('aria-label')).toContain('exclusively held');
    expect(exclusive.querySelector('.apron-stand__exclusive')).not.toBeNull();
    expect(standElement('A3').querySelector('.apron-stand__exclusive')).toBeNull();

    // Every stand is on the map, each reachable from the keyboard.
    expect(document.querySelectorAll('[data-stand]')).toHaveLength(18);
    expect(standElement('M1')).toHaveAttribute('tabindex', '0');
  });

  it('names a rival holder on hover and on focus', async () => {
    stubFetch({});
    renderMap();
    await loaded();

    fireEvent.focus(standElement('A3'));
    expect(screen.getByText('A3: Rival Air (preferential)')).toBeInTheDocument();
    fireEvent.blur(standElement('A3'));
    expect(screen.queryByText('A3: Rival Air (preferential)')).toBeNull();

    fireEvent.mouseEnter(standElement('A4'));
    expect(screen.getByText('A4: Rival Air (exclusive)')).toBeInTheDocument();
  });

  it('draws a legend for every state', async () => {
    stubFetch({});
    renderMap();
    await loaded();
    const legend = screen.getByRole('region', { name: 'Legend' });
    for (const entry of ['Your stands', 'Held by another airline', 'Unleased', /Exclusive lease/]) {
      expect(within(legend).getByText(entry)).toBeInTheDocument();
    }
  });
});

describe('aircraft and rings', () => {
  it('fills the five rings from the real turn at the response’s game time', async () => {
    stubFetch({});
    renderMap();
    await loaded();

    // A quarter of a sixty-minute turn: bags half done, boarding not begun.
    expect(ring('flight-1', 'bags')).toHaveAttribute('data-progress', '0.50');
    expect(Number(ring('flight-1', 'fuelling')?.getAttribute('data-progress'))).toBeCloseTo(
      0.125,
      1,
    );
    expect(ring('flight-1', 'boarding')).toHaveAttribute('data-progress', '0.00');
    // Parked with no departure: a finished turn.
    expect(ring('flight-3', 'boarding')).toHaveAttribute('data-progress', '1.00');

    const plane = screen.getByRole('button', { name: /^Tailfin Test Air A320neo PH-TTA/ });
    expect(plane.getAttribute('aria-label')).toContain('Bags 50%');
    // A rival's aeroplane is drawn, in its colour, but is not a control.
    const rival = document.querySelector('[data-aircraft="flight-2"]');
    expect(rival?.querySelector('path')).toHaveStyle({ fill: '#aa5500' });
    expect(rival).not.toHaveAttribute('role');
  });

  it('ticks the rings with the world clock once it syncs', async () => {
    stubFetch({
      clock: () => ({
        status: 200,
        body: {
          worldId: '44444444-4444-4444-8444-444444444444',
          serverTime: new Date(GAME_NOW_MS).toISOString(),
          // Half an hour on: three quarters of the turn.
          inGameTime: at(30),
          speedMultiplier: 1,
        },
      }),
    });
    renderMap();
    await loaded();

    await waitFor(() => {
      expect(ring('flight-1', 'bags')).toHaveAttribute('data-progress', '1.00');
    });
    expect(ring('flight-1', 'boarding')).toHaveAttribute('data-progress', '0.50');
  });

  it('parks an aeroplane with no stand on the remote apron’s overflow', async () => {
    stubFetch({});
    renderMap();
    await loaded();
    expect(document.querySelector('[data-area="overflow"]')).not.toBeNull();
    expect(document.querySelector('[data-aircraft="flight-3"]')).not.toBeNull();
  });

  it('opens the flight panel for your aeroplane', async () => {
    stubFetch({});
    renderMap();
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: /^Tailfin Test Air A320neo PH-TTA/ }));
    const panel = screen.getByRole('complementary', { name: 'PH-TTA' });
    expect(within(panel).getByText('A320neo · Tailfin Test Air')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Next departure09:45 to EGLL');
    expect(panel).toHaveTextContent('A1 since 08:45');
    expect(within(panel).getByRole('link', { name: 'Open in Fleet' })).toHaveAttribute(
      'href',
      '/fleet',
    );
  });

  it('draws a runway movement close to now, and not one ten minutes away', async () => {
    stubFetch({});
    renderMap();
    await loaded();
    expect(document.querySelectorAll('[data-movement="arrival"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-movement="departure"]')).toHaveLength(0);
  });
});

describe('the utilisation heat overlay', () => {
  it('shows which of your stands are idle and which are jammed', async () => {
    stubFetch({});
    renderMap();
    await loaded();

    expect(standElement('A1')).not.toHaveAttribute('data-heat');
    fireEvent.click(screen.getByRole('button', { name: 'Utilisation heat' }));
    expect(screen.getByRole('button', { name: 'Utilisation heat' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    expect(standElement('A1')).toHaveAttribute('data-heat', 'jammed');
    expect(standElement('A2')).toHaveAttribute('data-heat', 'idle');
    // A rival's utilisation is never disclosed, so it has no heat.
    expect(standElement('A3')).not.toHaveAttribute('data-heat');
    expect(within(standElement('A1')).getByText('▲ 88%')).toBeInTheDocument();
    const heat = screen.getByRole('list', { name: 'Utilisation heat' });
    expect(within(heat).getByText('Jammed — over 85% occupied')).toBeInTheDocument();
    expect(within(heat).getByText('Idle — below the utilisation floor')).toBeInTheDocument();
  });
});

describe('leasing on the map', () => {
  it('leases a stand, echoing the quoted fee, and paints it yours', async () => {
    const leased = gates({
      A5: { holders: [youHold('preferential')], yourContract: 'preferential' },
    });
    const sent: unknown[] = [];
    stubFetch({
      lease: (body) => {
        sent.push(body);
        return { status: 200, body: leased };
      },
    });
    renderMap();
    await loaded();

    fireEvent.click(standElement('A5'));
    const panel = screen.getByRole('complementary', { name: 'Stand A5' });
    expect(panel).toHaveTextContent('None — you hold nothing here');
    fireEvent.click(
      within(panel).getByRole('button', { name: 'Lease preferential — $120,000 a year' }),
    );

    await waitFor(() => {
      expect(standElement('A5')).toHaveAttribute('data-state', 'yours');
    });
    expect(sent).toEqual([
      { position: 'A5', contract: 'preferential', expectedAnnualFeeMinor: 12_000_000 },
    ]);
  });

  it('offers an exclusive lease only on an empty stand', async () => {
    stubFetch({});
    renderMap();
    await loaded();
    fireEvent.click(standElement('A5'));
    expect(
      screen.getByRole('button', { name: 'Lease exclusive — $300,000 a year' }),
    ).toBeInTheDocument();
    fireEvent.click(standElement('A3'));
    expect(screen.getByRole('complementary', { name: 'Stand A3' })).toHaveTextContent(
      'Rival Air (Preferential)',
    );
    expect(screen.queryByRole('button', { name: /Lease exclusive/ })).toBeNull();
    fireEvent.click(standElement('A4'));
    expect(screen.queryByRole('button', { name: /Lease preferential/ })).toBeNull();
    expect(screen.getByText(/Not available to lease/)).toBeInTheDocument();
  });

  it('shows a refusal in words and changes nothing', async () => {
    stubFetch({
      lease: () => ({
        status: 409,
        body: { code: 'fee_changed', message: 'The fee for A5 has changed; review the new quote.' },
      }),
    });
    renderMap();
    await loaded();

    fireEvent.click(standElement('A5'));
    fireEvent.click(screen.getByRole('button', { name: /Lease preferential/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The fee for A5 has changed; review the new quote.',
    );
    expect(standElement('A5')).toHaveAttribute('data-state', 'open');
  });

  it('releases only after the two-step confirm, and folds the answer in', async () => {
    const released = gates({ A1: { holders: [], yourContract: null, utilisation: null } });
    const fetchMock = stubFetch({ release: () => ({ status: 200, body: released }) });
    renderMap();
    await loaded();

    fireEvent.click(standElement('A1'));
    const panel = screen.getByRole('complementary', { name: 'Stand A1' });
    // The day's rotation and utilisation, for your own stand.
    expect(panel).toHaveTextContent('88% of the operating day');
    expect(
      within(panel).getByText(/07:00–07:45 · PH-TTA · from EGLL · to LEMD/),
    ).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Release A1' }));
    const confirm = within(panel).getByRole('group', { name: 'Confirm releasing A1' });
    expect(confirm).toHaveTextContent('Ends your preferential lease on A1.');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm — release A1' }));
    await waitFor(() => {
      expect(standElement('A1')).toHaveAttribute('data-state', 'open');
    });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(call?.[0]).toBe('/api/airports/EHAM/gates/A1');
  });

  it('closes the panel on Escape and gives focus back to the stand', async () => {
    stubFetch({});
    renderMap();
    await loaded();

    standElement('A3').focus();
    fireEvent.keyDown(standElement('A3'), { key: 'Enter' });
    expect(screen.getByRole('complementary', { name: 'Stand A3' })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Stand A3' }), { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Stand A3' })).toBeNull();
    await waitFor(() => {
      expect(standElement('A3')).toHaveFocus();
    });
  });
});

describe('leaving for the world map', () => {
  it('calls onExit from the back control', () => {
    stubFetch({});
    const onExit = renderMap();
    fireEvent.click(screen.getByRole('button', { name: '← Back to world map' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit once when the wheel zooms out past the widest view', async () => {
    stubFetch({});
    const onExit = renderMap();
    const svg = await loaded();

    // Zooming in first does not leave.
    act(() => {
      fireEvent.wheel(svg, { deltaY: -200 });
    });
    expect(onExit).not.toHaveBeenCalled();
    expect(Number(svg.getAttribute('data-zoom'))).toBeGreaterThan(1);

    for (let i = 0; i < 6; i += 1) {
      act(() => {
        fireEvent.wheel(svg, { deltaY: 200 });
      });
    }
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('calls onExit when the zoom-out control passes the widest view', async () => {
    stubFetch({});
    const onExit = renderMap();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('states', () => {
  it('announces loading', () => {
    stubFetch({ apron: () => 'pending' });
    renderMap();
    expect(screen.getByRole('status')).toHaveTextContent('Reading the apron…');
    expect(screen.getByRole('heading', { name: 'EHAM' })).toBeInTheDocument();
  });

  it('says plainly that an airport does not exist', async () => {
    stubFetch({ apron: () => ({ status: 404, body: {} }) });
    renderMap(vi.fn(), 'ZZZZ');
    expect(await screen.findByText('There is no airport with the code ZZZZ.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the apron is unknown when it cannot be read, and tries again', async () => {
    let attempt = 0;
    stubFetch({
      apron: () => {
        attempt += 1;
        return attempt === 1 ? { status: 500, body: {} } : { status: 200, body: apron() };
      },
    });
    renderMap();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not read this airport’s apron.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
  });
});
