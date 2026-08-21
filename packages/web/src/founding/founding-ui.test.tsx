import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AirlineCodeAvailabilityResponse,
  AirlineFoundingAirport,
  AirlineFoundingOptionsResponse,
  MeResponse,
} from '@tailfin/shared';

import { App } from '../App';

const PLAYER_ID = '11111111-2222-4333-8444-555555555555';
const WORLD_ID = '22222222-3333-4444-8555-666666666666';

const SIGNED_IN: MeResponse = {
  player: {
    id: PLAYER_ID,
    displayName: 'Founder Tester',
    avatarUrl: null,
    createdAt: '2026-08-20T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: false,
};

const OPTIONS: AirlineFoundingOptionsResponse = {
  memberships: [],
  worlds: [
    {
      id: WORLD_ID,
      name: 'Flagship',
      openingCashMinor: 50_000_000,
      freeHubAllowance: 1,
      playerCap: null,
      airlines: 0,
      availability: 'available',
    },
  ],
};

const MEDIUM: AirlineFoundingAirport = {
  ident: 'EHAM',
  icao: 'EHAM',
  iata: 'AMS',
  name: 'Amsterdam Airport Schiphol',
  city: 'Amsterdam',
  country: 'NL',
  tier: 'medium',
  slotLevel: 2,
  foundingCostMinor: 0,
  feeWarning: null,
};

const FLAGSHIP: AirlineFoundingAirport = {
  ident: 'EGLL',
  icao: 'EGLL',
  iata: 'LHR',
  name: 'London Heathrow Airport',
  city: 'London',
  country: 'GB',
  tier: 'flagship',
  slotLevel: 3,
  foundingCostMinor: 0,
  feeWarning:
    'Flagship hub: the founder grant covers acquisition, but this tier carries the highest ongoing facility fees and Level 3 slot scarcity. This ambitious choice is allowed.',
};

const AVAILABLE_CODES: AirlineCodeAvailabilityResponse = {
  advisory: {
    scope: 'world',
    reservation: 'none',
    realWorldCodes: 'allowed-if-free',
    message: 'Availability is advisory; founding reserves the code.',
  },
  iataCode: { requested: 'TF', status: 'available', alternatives: [] },
  icaoCode: { requested: 'TFN', status: 'available', alternatives: [] },
};

interface StubOptions {
  codes?: AirlineCodeAvailabilityResponse;
  foundingRefusal?: { status: number; body: unknown };
}

function answer(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function stubApi(settings: StubOptions = {}) {
  const creates: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/me') return answer(200, SIGNED_IN);
      if (url === '/api/version') return answer(503, {});
      if (url === '/api/airlines/founding-options') return answer(200, OPTIONS);
      if (url.startsWith('/api/airlines/founding-airports')) {
        return answer(200, {
          airports: url.includes('?q=') ? [FLAGSHIP] : [MEDIUM],
          query: url.includes('?q=') ? 'Heathrow' : '',
        });
      }
      if (url === '/api/airlines/code-availability') {
        return answer(200, settings.codes ?? AVAILABLE_CODES);
      }
      if (url === '/api/airlines' && init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('founding request body was not JSON');
        creates.push(JSON.parse(init.body) as unknown);
        if (settings.foundingRefusal) {
          return answer(settings.foundingRefusal.status, settings.foundingRefusal.body);
        }
        return answer(201, {
          airline: {
            id: '33333333-4444-4555-8666-777777777777',
            worldId: WORLD_ID,
            playerId: PLAYER_ID,
            name: 'Tailfin Air',
            iataCode: 'TF',
            icaoCode: 'TFN',
            callsign: 'TAILFIN',
            baseCountry: 'NL',
            cash: 50_000_000,
            reputation: 0.35,
            status: 'active',
            statusChangedAt: '2026-08-20T10:00:00.000Z',
            ceasedAt: null,
            createdAt: '2026-08-20T10:00:00.000Z',
          },
          hub: {
            id: '44444444-5555-4666-8777-888888888888',
            airlineId: '33333333-4444-4555-8666-777777777777',
            airportIdent: 'EGLL',
            founderGrant: true,
            createdAt: '2026-08-20T10:00:00.000Z',
          },
        });
      }
      if (url === '/api/routes') return answer(200, { routes: [] });
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return creates;
}

function renderAt(path = '/found') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

async function fillIdentity() {
  fireEvent.change(await screen.findByLabelText('Airline name'), {
    target: { value: 'Tailfin Air' },
  });
  fireEvent.change(screen.getByLabelText('Home country'), { target: { value: 'NL' } });
  fireEvent.change(screen.getByLabelText('IATA airline code'), { target: { value: 'TF' } });
  fireEvent.change(screen.getByLabelText('ICAO airline code'), { target: { value: 'TFN' } });
  fireEvent.change(screen.getByLabelText('Operational callsign'), {
    target: { value: 'TAILFIN' },
  });
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  localStorage.clear();
});

describe('the founding desk', () => {
  it('routes a signed-in player with no airline to the no-menu cold open', async () => {
    stubApi();
    renderAt('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'What’s your airline called?' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect((await screen.findAllByText('500,000.00')).length).toBeGreaterThan(0);
  });

  it('labels every critical control and uses native keyboard controls', async () => {
    stubApi();
    renderAt();

    for (const label of [
      'Airline name',
      'Home country',
      'World',
      'IATA airline code',
      'ICAO airline code',
      'Operational callsign',
      'Search airports',
    ]) {
      expect(await screen.findByLabelText(label)).toBeInTheDocument();
    }
    expect(
      await screen.findByRole('radio', { name: /Amsterdam Airport Schiphol/i }),
    ).toHaveAttribute('type', 'radio');
    expect(screen.getByRole('button', { name: 'Found airline' })).toHaveAttribute('type', 'submit');
  });

  it('offers a taken code inline as buttons that replace the field', async () => {
    stubApi({
      codes: {
        ...AVAILABLE_CODES,
        iataCode: { requested: 'TF', status: 'assigned', alternatives: ['TA', 'TN', 'TR'] },
      },
    });
    renderAt();
    await fillIdentity();

    const suggestion = await screen.findByRole('button', { name: 'Use IATA code TA' });
    expect(screen.getByText(/TF is not available/i)).toBeInTheDocument();
    fireEvent.click(suggestion);
    expect(screen.getByLabelText('IATA airline code')).toHaveValue('TA');
  });

  it('warns about a costly flagship hub but lets the player found and reach the network', async () => {
    const creates = stubApi();
    renderAt();
    await fillIdentity();

    fireEvent.change(screen.getByLabelText('Search airports'), { target: { value: 'Heathrow' } });
    const flagship = await screen.findByRole('radio', { name: /London Heathrow Airport/i });
    fireEvent.click(flagship);

    expect(screen.getAllByText(/highest ongoing facility fees/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/It does not block founding/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Found airline' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Found airline' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Network' })).toBeInTheDocument();
    expect(creates).toEqual([
      expect.objectContaining({
        worldId: WORLD_ID,
        name: 'Tailfin Air',
        baseCountry: 'NL',
        iataCode: 'TF',
        icaoCode: 'TFN',
        callsign: 'TAILFIN',
        hubIdent: 'EGLL',
      }),
    ]);
  });

  it('shows the server rule when founding is refused instead of a generic failure', async () => {
    stubApi({
      foundingRefusal: {
        status: 409,
        body: {
          code: 'world_not_open',
          message: 'This world is locked; an airline can only be founded in an open world',
        },
      },
    });
    renderAt();
    await fillIdentity();
    fireEvent.click(await screen.findByRole('radio', { name: /Amsterdam Airport Schiphol/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Found airline' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/world is locked/i);
    expect(alert).toHaveTextContent(/only be founded in an open world/i);
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
