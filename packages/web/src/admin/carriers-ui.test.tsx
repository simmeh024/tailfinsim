import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminNpcResponse,
  AdminWorldSummary,
  MeResponse,
  VersionResponse,
} from '@tailfin/shared';

import { App } from '../App';
import { waitForSignInCheck } from '../test-gates';

/**
 * The carriers page, as an admin meets it (M3-12).
 *
 * M3-12's third acceptance criterion is *"NPC decisions are logged and
 * inspectable in the admin console"*, and the question it has to answer is a
 * support question: why did a competitor appear in my market last week? So the
 * decision and its reason are what these tests defend, along with the two
 * empty states — a world nobody seeded, and a world too young to have reviewed.
 */

const ADMIN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Amelia Hart',
    avatarUrl: null,
    displayCurrency: 'USD',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: true,
};

const VERSION: VersionResponse = {
  build: 226,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-21T12:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-21T11:55:00.000Z',
  serverTime: '2026-08-21T12:05:00.000Z',
};

const WORLD_ID = '99999999-8888-7777-6666-555555555555';

const WORLDS: AdminWorldSummary[] = [
  {
    id: WORLD_ID,
    name: 'Flagship',
    status: 'open',
    epoch: '2024-10-20T00:00:00.000Z',
    launchDate: '2026-08-01T00:00:00.000Z',
    speedMultiplier: 2,
    inGameDate: '2024-12-01T00:00:00.000Z',
    aircraftCatalogueVersion: 'v1',
    economyConfigVersion: 'v1',
    playerCap: null,
    airlines: 1,
    pendingEvents: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
  },
];

const SEEDED: AdminNpcResponse = {
  seeded: true,
  carriers: [
    {
      airlineId: '22222222-3333-4444-5555-666666666666',
      name: 'Barcelona Express',
      iataCode: 'B7',
      icaoCode: 'BEX',
      archetype: 'lcc',
      baseCountry: 'ES',
      hubIcao: 'LEBL',
      routes: 12,
      cashMinor: 50_000_000,
      reputation: 0.47,
    },
  ],
  decisions: [
    {
      id: '33333333-4444-4555-8666-777777777777',
      airlineId: '22222222-3333-4444-5555-666666666666',
      airlineName: 'Barcelona Express',
      airlineIataCode: 'B7',
      archetype: 'lcc',
      decidedAt: '2024-11-17T00:00:00.000Z',
      recordedAt: '2026-08-21T12:00:00.000Z',
      kind: 'route_opened',
      originIcao: 'EHAM',
      destinationIcao: 'LEBL',
      basis: { dailyPassengers: 1204, incumbents: 0, estimatedMargin: 0.11 },
      reason: 'Entered: 1204 passengers a day and 0 operators, at an estimated 11% margin.',
      economyConfigVersion: 'v1',
    },
  ],
};

function stubApi(npc: AdminNpcResponse = SEEDED) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

      if (url === '/api/me') return json(ADMIN);
      if (url === '/api/version') return json(VERSION);
      if (url === '/api/admin/worlds') return json({ worlds: WORLDS });
      if (url === `/api/admin/worlds/${WORLD_ID}/npc`) return json(npc);
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

async function openCarriers(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/admin/carriers']}>
      <App />
    </MemoryRouter>,
  );
  await waitForSignInCheck();
}

describe('the carriers page', () => {
  it('is in the console nav, at /admin/carriers', async () => {
    stubApi();
    await openCarriers();

    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getByRole('link', { name: 'Carriers' })).toHaveAttribute(
      'href',
      '/admin/carriers',
    );
  });

  it('lists each carrier with its archetype, hub and network size', async () => {
    stubApi();
    await openCarriers();

    const carrier = await screen.findByRole('article', { name: /Barcelona Express/ });
    // The archetype in words. "lcc" is an identifier, not a label.
    expect(within(carrier).getByText('Low-cost carrier')).toBeInTheDocument();
    expect(within(carrier).getByText('LEBL')).toBeInTheDocument();
    expect(within(carrier).getByText('12')).toBeInTheDocument();
  });

  it('shows the server’s reason for a decision, verbatim', async () => {
    stubApi();
    await openCarriers();

    // §21: the client must not reach a different conclusion about a decision
    // than the server did, so it renders the sentence rather than rebuilding it.
    expect(
      await screen.findByText(
        'Entered: 1204 passengers a day and 0 operators, at an estimated 11% margin.',
      ),
    ).toBeInTheDocument();
  });

  it('dates a decision by the world’s calendar, not real time', async () => {
    stubApi();
    await openCarriers();

    // `decidedAt` is game time and `recordedAt` is real time. Showing the wrong
    // one would put a 2026 date on something that happened in 2024 in-world.
    const table = await screen.findByRole('table');
    expect(within(table).getByText('2024-11-17')).toBeInTheDocument();
    expect(within(table).queryByText('2026-08-21')).toBeNull();
  });

  it('tells an admin how to seed a world that has no carriers', async () => {
    stubApi({ seeded: false, carriers: [], decisions: [] });
    await openCarriers();

    expect(await screen.findByText(/no NPC carriers/i)).toBeInTheDocument();
    // The prerequisite that is not guessable, said where it is needed.
    expect(screen.getByText(/demand pools generated first/i)).toBeInTheDocument();
  });

  it('distinguishes a seeded world with no decisions yet', async () => {
    // Different from an unseeded world, and the difference matters: one needs a
    // command run, the other needs time to pass.
    stubApi({ ...SEEDED, decisions: [] });
    await openCarriers();

    expect(await screen.findByText(/No decisions recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/no NPC carriers/i)).toBeNull();
  });
});
