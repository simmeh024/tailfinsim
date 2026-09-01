import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeResponse, OwnAirlineResponse } from '@tailfin/shared';

import { App } from '../App';
import { waitForSignInCheck } from '../test-gates';

const PLAYER_ID = '11111111-2222-4333-8444-555555555555';
const WORLD_ID = '22222222-3333-4444-8555-666666666666';

const SIGNED_IN: MeResponse = {
  player: {
    id: PLAYER_ID,
    displayName: 'Airline Owner',
    avatarUrl: null,
    displayCurrency: 'USD',
    createdAt: '2026-08-20T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: false,
};

const OWN: OwnAirlineResponse = {
  airline: {
    id: '33333333-4444-4555-8666-777777777777',
    worldId: WORLD_ID,
    playerId: PLAYER_ID,
    kind: 'player',
    archetype: null,
    name: 'Tailfin Air',
    iataCode: 'TF',
    icaoCode: 'TFN',
    callsign: 'TAILFIN',
    baseCountry: 'NL',
    logo: null,
    cash: 50_000_000,
    reputation: 0.35,
    status: 'active',
    statusChangedAt: '2026-08-20T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
  },
  rebrand: {
    costMinor: 2_500_000,
    mutableFields: ['name', 'callsign', 'baseCountry', 'logo'],
    immutableFields: ['iataCode', 'icaoCode', 'cash', 'reputation'],
  },
};

function answer(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

interface StubSettings {
  own?: OwnAirlineResponse;
  refusal?: { status: number; body: unknown };
}

function stubApi(settings: StubSettings = {}) {
  const updates: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/me') return answer(200, SIGNED_IN);
      if (url === '/api/version') return answer(503, {});
      if (url === '/api/airlines/me' && init?.method === 'PATCH') {
        if (typeof init.body !== 'string') throw new Error('airline update was not JSON');
        const body = JSON.parse(init.body) as unknown;
        updates.push(body);
        if (settings.refusal) return answer(settings.refusal.status, settings.refusal.body);
        return answer(200, {
          airline: {
            ...OWN.airline,
            name: 'Air Côte d’Ivoire',
            callsign: 'HORIZON 8',
            baseCountry: 'CI',
            cash: 47_500_000,
          },
          changed: true,
          chargedMinor: 2_500_000,
          identityChangeId: '44444444-5555-4666-8777-888888888888',
        });
      }
      if (url === '/api/airlines/me') return answer(200, settings.own ?? OWN);
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return updates;
}

/**
 * The airline page, with the sign-in check already behind it.
 *
 * `/api/me` and `/api/airlines/me` are two gates in a row — the second cannot even
 * be sent until the first has mounted the route tree — so waiting for the page's
 * contents alone made one query's budget cover both, and under full-suite load it
 * ran out mid-chain and reported a missing heading. The sign-in check is waited
 * for here; each test's own `findBy*` then covers only the page's own load.
 */
async function renderPage() {
  const result = render(
    <MemoryRouter initialEntries={['/airline']}>
      <App />
    </MemoryRouter>,
  );
  await waitForSignInCheck();
  return result;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  localStorage.clear();
});

describe('your airline page', () => {
  it('shows private cash and reputation, stable codes, and live shell identity', async () => {
    stubApi();
    await renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tailfin Air' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('500,000.00')).toHaveLength(2);
    expect(screen.getByText('0.35 / 1.00')).toBeInTheDocument();
    expect(screen.getByLabelText('Airline designators')).toHaveTextContent('TF');
    expect(screen.getByLabelText('Airline designators')).toHaveTextContent('TFN');
    const manage = screen.getByRole('link', { name: /Manage airline/i });
    expect(manage).toHaveAttribute('href', '/airline');
    expect(manage).toHaveTextContent('Tailfin Air');

    const strip = screen.getByLabelText('Status');
    expect(within(strip).getByText('500,000.00')).toBeInTheDocument();
  });

  it('exposes only AIR-02 identity fields as controls and states why codes stay fixed', async () => {
    stubApi();
    await renderPage();

    for (const label of ['Airline name', 'Operational callsign', 'Home country']) {
      expect(await screen.findByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText(/IATA/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/ICAO/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/released only if the airline ceases/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebrand for 25,000.00' })).toBeDisabled();
  });

  it('shows the logo viewer and a link to the dedicated logo studio', async () => {
    stubApi();
    await renderPage();

    // The viewer emblem renders for the airline in the brand-logo section.
    expect(await screen.findByLabelText('Current brand logo')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Brand logo' })).toBeInTheDocument();

    // Editing the logo is its own page, reached by a link rather than inline controls.
    const edit = screen.getByRole('link', { name: 'Edit logo' });
    expect(edit).toHaveAttribute('href', '/airline/logo');

    // The identity rebrand button is unrelated to the logo, and stays disabled clean.
    expect(screen.getByRole('button', { name: 'Rebrand for 25,000.00' })).toBeDisabled();
  });

  it('sends only mutable fields, applies the server result, and updates shell cash', async () => {
    const updates = stubApi();
    await renderPage();

    fireEvent.change(await screen.findByLabelText('Airline name'), {
      target: { value: 'Air Côte d’Ivoire' },
    });
    fireEvent.change(screen.getByLabelText('Operational callsign'), {
      target: { value: 'horizon 8' },
    });
    fireEvent.change(screen.getByLabelText('Home country'), { target: { value: 'ci' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rebrand for 25,000.00' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/recorded in your cash history/i);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Air Côte d’Ivoire' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage airline/i })).toHaveTextContent(
      'Air Côte d’Ivoire',
    );
    expect(within(screen.getByLabelText('Status')).getByText('475,000.00')).toBeInTheDocument();
    expect(updates).toEqual([
      {
        name: 'Air Côte d’Ivoire',
        callsign: 'HORIZON 8',
        baseCountry: 'CI',
      },
    ]);
  });

  it('places AIR-02 server refusals at the field and focuses the summary', async () => {
    stubApi({
      refusal: {
        status: 400,
        body: {
          code: 'invalid_airline_identity',
          message: 'The airline name is not valid',
          fields: { name: ['must contain at least one Unicode letter'] },
        },
      },
    });
    await renderPage();

    fireEvent.change(await screen.findByLabelText('Airline name'), { target: { value: '---' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rebrand for 25,000.00' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not applied/i);
    expect(screen.getByText(/must contain at least one Unicode letter/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Airline name')).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('treats no airline as a normal page state with a route to founding', async () => {
    stubApi({ own: { airline: null, rebrand: null } });
    await renderPage();

    expect(await screen.findByText(/no airline in the active world yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the founding desk' })).toHaveAttribute(
      'href',
      '/found',
    );
  });

  it('keeps a ceased airline visible as history without offering mutations or founding', async () => {
    stubApi({
      own: {
        airline: {
          ...OWN.airline!,
          status: 'ceased',
          statusChangedAt: '2026-08-21T12:00:00.000Z',
          ceasedAt: '2026-08-21T12:00:00.000Z',
        },
        rebrand: null,
      },
    });
    await renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tailfin Air' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/operational history remains readable/i)).toBeInTheDocument();
    expect(screen.getByText(/former codes may now be allocated/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rebrand/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open the founding desk' })).not.toBeInTheDocument();
  });
});
