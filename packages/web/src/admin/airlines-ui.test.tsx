import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { AdminAirlineDetailResponse, MeResponse, VersionResponse } from '@tailfin/shared';

import { App } from '../App';

const ADMIN: MeResponse = {
  player: {
    id: '11111111-2222-4333-8444-555555555555',
    displayName: 'Admin User',
    avatarUrl: null,
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: true,
};

const VERSION: VersionResponse = {
  build: 215,
  commit: 'air1000',
  environment: 'dev',
  startedAt: '2026-08-22T08:00:00.000Z',
  ref: 'codex/air-10-admin-airlines',
  deployedAt: null,
  serverTime: '2026-08-22T08:05:00.000Z',
};

const AIRLINE_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

const DETAIL: AdminAirlineDetailResponse = {
  airline: {
    id: AIRLINE_ID,
    worldId: 'bbbbbbbb-1111-4222-8333-444444444444',
    worldName: 'Flagship',
    owner: {
      id: 'cccccccc-1111-4222-8333-444444444444',
      displayName: 'Amelia Hart',
    },
    kind: 'player',
    archetype: null,
    name: 'Hart Air',
    iataCode: 'HA',
    icaoCode: 'XHA',
    callsign: 'HARTAIR',
    baseCountry: 'GB',
    cashMinor: 49_987_500,
    reputation: 0.35,
    status: 'active',
    statusChangedAt: '2026-08-17T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-17T10:00:00.000Z',
    routes: [
      {
        id: 'dddddddd-1111-4222-8333-444444444444',
        originIcao: 'EHAM',
        originName: 'Amsterdam Airport Schiphol',
        destinationIcao: 'EGLL',
        destinationName: 'London Heathrow Airport',
        greatCircleNm: 200,
        fares: { economy: 12_500 },
        active: false,
        createdAt: '2026-08-18T10:00:00.000Z',
        updatedAt: '2026-08-21T10:00:00.000Z',
      },
    ],
  },
  cashMovements: {
    entries: [
      {
        id: 'eeeeeeee-1111-4222-8333-444444444444',
        amountMinor: -12_500,
        cause: 'flight_settlement',
        reference: 'flight-123',
        balanceAfterMinor: 49_987_500,
        occurredAt: '2026-08-21T10:00:00.000Z',
        recordedAt: '2026-08-21T10:00:01.000Z',
      },
    ],
    total: 1,
    limit: 50,
    offset: 0,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function stubApi(options: { notFound?: boolean; paged?: boolean } = {}) {
  const requested: string[] = [];
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (url === '/api/me') return Promise.resolve(jsonResponse(ADMIN));
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url.startsWith(`/api/admin/airlines/${AIRLINE_ID}`)) {
      if (options.notFound) {
        return Promise.resolve(
          jsonResponse({ code: 'airline_not_found', message: 'No airline with that id.' }, 404),
        );
      }
      if (options.paged && url.includes('movementOffset=50')) {
        return Promise.resolve(
          jsonResponse({
            ...DETAIL,
            cashMovements: {
              entries: [
                {
                  ...DETAIL.cashMovements.entries[0]!,
                  id: 'ffffffff-1111-4222-8333-444444444444',
                  reference: 'opening-balance',
                  amountMinor: 50_000_000,
                  cause: 'airline_founding',
                },
              ],
              total: 51,
              limit: 50,
              offset: 50,
            },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(
          options.paged
            ? { ...DETAIL, cashMovements: { ...DETAIL.cashMovements, total: 51 } }
            : DETAIL,
        ),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requested };
}

function renderAirline() {
  return render(
    <MemoryRouter initialEntries={[`/admin/airlines/${AIRLINE_ID}`]}>
      <App />
    </MemoryRouter>,
  );
}

describe('the airline support record', () => {
  it('shows the identity, standing, routes and cash evidence support needs', async () => {
    stubApi();
    renderAirline();

    expect(await screen.findByRole('heading', { name: 'Hart Air' })).toBeInTheDocument();
    expect(screen.getByText(/HA · XHA · HARTAIR/)).toBeInTheDocument();
    expect(screen.getAllByText('499,875.00')).toHaveLength(2);
    expect(screen.getByText('EHAM').closest('td')).toHaveTextContent('Amsterdam Airport Schiphol');
    expect(screen.getByText('EGLL').closest('td')).toHaveTextContent('London Heathrow Airport');
    expect(screen.getByText('closed')).toBeInTheDocument();
    expect(screen.getByText('Flight settlement')).toBeInTheDocument();
    expect(screen.getByText('flight-123')).toBeInTheDocument();
    expect(screen.getByText('-125.00')).toBeInTheDocument();
  });

  it('links back to the owning player and has no balance mutation control', async () => {
    stubApi();
    renderAirline();

    await screen.findByRole('heading', { name: 'Hart Air' });
    expect(screen.getAllByRole('link', { name: /Amelia Hart/ })[0]).toHaveAttribute(
      'href',
      '/admin/players/cccccccc-1111-4222-8333-444444444444',
    );
    expect(screen.getByText(/Cash cannot be changed here/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /adjust|edit|credit|debit|cash/i })).toBeNull();
  });

  it('loads older ledger entries from the server rather than truncating history', async () => {
    const { requested } = stubApi({ paged: true });
    renderAirline();

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }));
    expect(await screen.findByText('opening-balance')).toBeInTheDocument();
    await waitFor(() => {
      expect(requested).toContain(`/api/admin/airlines/${AIRLINE_ID}?movementOffset=50`);
    });
    expect(screen.getByRole('status')).toHaveTextContent('51–51 of 51');
  });

  it('handles a stale support link as a normal not-found state', async () => {
    stubApi({ notFound: true });
    renderAirline();

    expect(await screen.findByText(/No airline with that id/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to players/i })).toBeInTheDocument();
  });
});
