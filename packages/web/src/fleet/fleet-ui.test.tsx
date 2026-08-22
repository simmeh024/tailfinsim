import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { FleetCatalogueResponse, MeResponse, VersionResponse } from '@tailfin/shared';

import { App } from '../App';
import { waitForSignInCheck } from '../test-gates';

/**
 * The fleet catalogue, as a player meets it (M4-02, §7.2b).
 *
 * The acceptance criterion this page owns: *"Types arriving soon are visible
 * with their EIS date, not hidden."* Its opposite matters just as much — a type
 * that has not flown must not appear at all, because §7.2b says it *does not
 * exist* in that world, and the server is what enforces that.
 */

const ME: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Amelia Hart',
    avatarUrl: null,
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: false,
};

const VERSION: VersionResponse = {
  build: 240,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-21T12:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-21T11:55:00.000Z',
  serverTime: '2026-08-21T12:05:00.000Z',
};

const entry = (over: Partial<FleetCatalogueResponse['types'][number]> = {}) => ({
  designation: 'A320neo',
  family: 'A320neo',
  manufacturer: 'Airbus',
  class: 'narrowbody' as const,
  availability: 'orderable' as const,
  detail: 'Available to order new, lease, or buy used.',
  arrivesOn: null,
  seatsTwoClass: 165,
  maxSeats: 180,
  rangeNm: 3_500,
  mtowTonnes: 79,
  runwayRequirementM: 2_100,
  wingspanCode: 'C' as const,
  listPrice: 11_000_000_000,
  monthlyLeaseRate: 88_000_000,
  baseDeliveryLeadWeeks: 4,
  restrictions: [],
  restrictionCostPerDepartureMinor: 0,
  // M4-03. The page does not render the configurator — that is M4-07 — but the
  // response carries it, so the fixture does too.
  availableOptionIds: [],
  ...over,
});

const CATALOGUE: FleetCatalogueResponse = {
  inGameDate: '2024-10-20T00:00:00.000Z',
  catalogueVersion: 'v1',
  options: [],
  types: [
    entry(),
    entry({
      designation: 'A321XLR',
      availability: 'prototype',
      arrivesOn: '2024-11-11',
      detail: 'Flying as a prototype. Enters service on 2024-11-11, and can be ordered from then.',
      seatsTwoClass: 180,
      rangeNm: 4_700,
    }),
    entry({
      designation: '737-800',
      manufacturer: 'Boeing',
      availability: 'used_only',
      detail: 'Out of production since 2020-01-01. Available on the used market and by lease only.',
      listPrice: null,
    }),
  ],
};

function stubApi(catalogue: FleetCatalogueResponse | null = CATALOGUE) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

      if (url === '/api/me') return json(ME);
      if (url === '/api/version') return json(VERSION);
      if (url === '/api/airlines/me') return json({ airline: null, rebrand: null });
      if (url === '/api/fleet/catalogue') {
        return catalogue === null
          ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)
          : json(catalogue);
      }
      if (url.startsWith('/api/airlines/founding')) return json({ worlds: [], memberships: [] });
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

async function openFleet(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/fleet']}>
      <App />
    </MemoryRouter>,
  );
  await waitForSignInCheck();
}

describe('the fleet catalogue page', () => {
  it('lists what this world can fly', async () => {
    stubApi();
    await openFleet();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('A320neo')).toBeInTheDocument();
    expect(within(table).getByText('737-800')).toBeInTheDocument();
  });

  it('shows an arriving type with the date it arrives', async () => {
    stubApi();
    await openFleet();

    // M4-02's second acceptance criterion. The date is what turns a locked row
    // from a wall into a plan.
    expect(await screen.findByText('arrives 2024-11-11')).toBeInTheDocument();
    expect(screen.getByText('A321XLR')).toBeInTheDocument();
  });

  it('renders the server’s sentence rather than deciding for itself', async () => {
    stubApi();
    await openFleet();

    // §21: a browser must not reach a different conclusion about whether an
    // aircraft exists than the world did. Lint already stops the client
    // importing `@tailfin/sim`; this proves it renders what it was told.
    expect(
      await screen.findByText(
        'Flying as a prototype. Enters service on 2024-11-11, and can be ordered from then.',
      ),
    ).toBeInTheDocument();
  });

  it('says the status in words, not only by position', async () => {
    stubApi();
    await openFleet();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('In testing')).toBeInTheDocument();
    expect(within(table).getByText('Used only')).toBeInTheDocument();
  });

  it('shows a dash where a used-only type has no list price', async () => {
    stubApi();
    await openFleet();

    // Not a zero. An aircraft you cannot buy new does not cost nothing.
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('says so plainly when the world is too early for any aircraft', async () => {
    // The 1950s world. A real state, and a very different one from a failure —
    // the criterion is that such a world offers no jets, not that it errors.
    stubApi({
      inGameDate: '1955-06-01T00:00:00.000Z',
      catalogueVersion: 'v1',
      types: [],
      options: [],
    });
    await openFleet();

    expect(await screen.findByText(/No aircraft type has flown yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('reports a failed load as a failure, not as an empty world', async () => {
    stubApi(null);
    await openFleet();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load/i);
    expect(screen.queryByText(/No aircraft type has flown yet/i)).toBeNull();
  });

  it('shows a restriction with what it costs and when it started', async () => {
    stubApi({
      ...CATALOGUE,
      types: [
        entry({
          designation: '737-800',
          availability: 'used_only',
          detail: 'Out of production. Available on the used market and by lease only.',
          restrictions: [
            {
              kind: 'noise_quota',
              since: '2030-01-01',
              amountMinor: 180_000,
              note: 'Excluded from night noise quotas at EU hubs.',
            },
          ],
          restrictionCostPerDepartureMinor: 180_000,
        }),
      ],
    });
    await openFleet();

    // §7.2b's squeeze made legible: the aircraft still flies, and the player
    // can see exactly what it is now costing them and since when.
    expect(
      await screen.findByText(/Excluded from night noise quotas at EU hubs/),
    ).toBeInTheDocument();
    expect(screen.getByText(/since 2030-01-01/)).toBeInTheDocument();
  });
});
