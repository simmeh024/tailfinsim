import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminEconomyConfigCompareResponse,
  AdminEconomyConfigDetailResponse,
  AdminEconomyConfigListResponse,
  AdminPinEconomyConfigResponse,
  AdminWorldSummary,
  MeResponse,
  VersionResponse,
} from '@tailfin/shared';

import { App } from '../App';
import { waitForSignInCheck } from '../test-gates';

/**
 * The economy console, as an admin meets it (M11-37).
 *
 * The five things the milestone says an admin has to be able to do, each
 * defended by the test that would fail if it stopped being true:
 *
 * 1. see every version and which worlds are on each;
 * 2. see what changed between two versions;
 * 3. re-pin a world, with a statement of what moves;
 * 4. be told, as a fact, when the stored economy is not the shipped one;
 * 5. be refused — and told why — when their role lacks `economy.pin`.
 *
 * The fifth is the one worth being careful about. There is no client capability
 * model until M11-15, so the control is offered to everybody and the server is
 * what refuses. A test that only proved the happy path would let that refusal
 * become a blank page or a thrown error without anything noticing.
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
    airlines: 4,
    pendingEvents: 7,
    createdAt: '2026-08-01T00:00:00.000Z',
  },
];

const LIST: AdminEconomyConfigListResponse = {
  shippedVersion: 'v1',
  shippedMatchesStored: true,
  versions: [
    {
      version: 'v2',
      checksum: 'bbbbbbbbbbbbcccccccccccc',
      parentVersion: 'v1',
      notes: 'Fuel up 8% across the board.',
      createdAt: '2026-08-20T10:30:00.000Z',
      createdByPlayerId: '11111111-2222-3333-4444-555555555555',
      createdByLabel: 'Amelia Hart',
      worldsPinned: 0,
    },
    {
      version: 'v1',
      checksum: 'aaaaaaaaaaaadddddddddddd',
      parentVersion: null,
      notes: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      createdByPlayerId: null,
      createdByLabel: 'the build',
      worldsPinned: 1,
    },
  ],
};

const DIFF: AdminEconomyConfigCompareResponse = {
  from: 'v1',
  to: 'v2',
  changes: [
    { path: 'fuel.basePriceMinorPerLitre', before: 82, after: 89 },
    { path: 'demand.logit.beta.leisure.price', before: -1.9, after: -2.1 },
    { path: 'ground.selfHandling.enabled', after: true },
  ],
};

const DETAIL: AdminEconomyConfigDetailResponse = {
  summary: LIST.versions[1]!,
  payloadJson: '{"version":"v1","fuel":{"basePriceMinorPerLitre":82}}',
  comparedWith: null,
  diff: null,
};

const PIN: AdminPinEconomyConfigResponse = {
  worldId: WORLD_ID,
  worldName: 'Flagship',
  before: 'v1',
  after: 'v2',
  diff: DIFF.changes,
  pendingEvents: 7,
};

interface Stubs {
  list?: AdminEconomyConfigListResponse;
  /** Status for the version list, so a role without `economy.read` can be posed. */
  listStatus?: number;
  /** Status for the pin, so a role without `economy.pin` can be posed. */
  pinStatus?: number;
}

function stubApi({ list = LIST, listStatus = 200, pinStatus = 200 }: Stubs = {}) {
  const posted: unknown[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const reply = (status: number, body: unknown) =>
        Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: () => Promise.resolve(body),
        } as Response);

      if (url === '/api/me') return reply(200, ADMIN);
      if (url === '/api/version') return reply(200, VERSION);
      if (url === '/api/admin/worlds') return reply(200, { worlds: WORLDS });

      if (url === '/api/admin/economy-config') {
        return listStatus === 200
          ? reply(200, list)
          : reply(listStatus, { code: 'forbidden', message: 'Administrator access required' });
      }
      if (url.startsWith('/api/admin/economy-config/') && url.includes('/diff')) {
        return reply(200, DIFF);
      }
      if (url.startsWith('/api/admin/economy-config/')) return reply(200, DETAIL);

      if (url === `/api/admin/worlds/${WORLD_ID}/economy-config`) {
        posted.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        return pinStatus === 200
          ? reply(200, PIN)
          : reply(pinStatus, { code: 'forbidden', message: 'Administrator access required' });
      }

      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );

  return posted;
}

async function openEconomy(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/admin/economy']}>
      <App />
    </MemoryRouter>,
  );
  await waitForSignInCheck();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the economy console', () => {
  it('is in the console nav, at /admin/economy', async () => {
    stubApi();
    await openEconomy();

    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getByRole('link', { name: 'Economy' })).toHaveAttribute(
      'href',
      '/admin/economy',
    );
  });

  it('lists every version and how many worlds are on it', async () => {
    stubApi();
    await openEconomy();

    const table = await screen.findByRole('table', { name: /Newest first/ });
    const rows = within(table).getAllByRole('row');

    // Header, then v2, then v1 — newest first, as the server sends them.
    expect(within(rows[1]!).getByText('v2')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('v1')).toBeInTheDocument();

    // The number that decides whether a version matters at all.
    expect(within(rows[1]!).getByText('0')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('1')).toBeInTheDocument();

    // A version written by the build, not by a person, says so rather than
    // showing an empty cell that reads like missing data.
    expect(within(rows[2]!).getByText('the build')).toBeInTheDocument();
  });

  it('states that the stored economy matches the shipped one', async () => {
    stubApi();
    await openEconomy();

    // Said out loud even when it is fine: an absent warning is not evidence
    // that anything was checked.
    expect(await screen.findByText(/byte-for-byte the one this build ships/i)).toBeInTheDocument();
  });

  it('states a stored-versus-shipped mismatch as a fact, not as an error', async () => {
    stubApi({ list: { ...LIST, shippedMatchesStored: false } });
    await openEconomy();

    expect(await screen.findByText(/does not match the one this build ships/i)).toBeInTheDocument();
    // And says the thing an admin would otherwise get wrong: nothing is broken,
    // and the database is supposed to win.
    expect(screen.getByText(/the database wins by design/i)).toBeInTheDocument();
  });

  it('compares any two versions and names what differs', async () => {
    stubApi();
    await openEconomy();

    await screen.findByRole('table', { name: /Newest first/ });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));

    const diff = await screen.findByRole('table', { name: /differ between v1 and v2/ });
    expect(within(diff).getByText('fuel.basePriceMinorPerLitre')).toBeInTheDocument();
    expect(within(diff).getByText('82')).toBeInTheDocument();
    expect(within(diff).getByText('89')).toBeInTheDocument();

    // A field that is new in the later version is an addition, not a change
    // from an em dash — those are different facts about the payload.
    const added = within(diff).getByText('ground.selfHandling.enabled').closest('tr');
    expect(within(added!).getByText('added')).toBeInTheDocument();
  });

  it('says what moves before it will pin anything', async () => {
    stubApi();
    await openEconomy();

    fireEvent.change(await screen.findByLabelText('Pin to'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));

    const confirm = await screen.findByRole('group', {
      name: 'Confirm the economy change for Flagship',
    });

    // The actual numbers, fetched for this world's current version rather than
    // taken from whatever the Compare panel was last showing.
    expect(within(confirm).getByText('fuel.basePriceMinorPerLitre')).toBeInTheDocument();

    // The two things an admin would otherwise assume wrongly.
    expect(within(confirm).getByText(/Nothing already settled is re-priced/i)).toBeInTheDocument();
    expect(
      within(confirm).getByText(/7 scheduled events will settle under v2/),
    ).toBeInTheDocument();
  });

  it('sends the version the admin was shown as the guard', async () => {
    const posted = stubApi();
    await openEconomy();

    fireEvent.change(await screen.findByLabelText('Pin to'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin “Flagship” to v2' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    // Optimistic concurrency: if somebody else moved this world while the
    // review was on screen, the server refuses rather than applying the change
    // the admin did not actually agree to.
    expect(posted[0]).toEqual({ version: 'v2', expectedVersion: 'v1' });

    expect(await screen.findByText(/moved from v1 to v2/)).toBeInTheDocument();
  });

  it('tells an admin whose role cannot pin why they were refused', async () => {
    // `economy.read` without `economy.pin`. The server answers 403 and
    // deliberately will not name the capability, so the sentence has to be
    // written here — and it has to be a refusal, not a thrown error.
    const posted = stubApi({ pinStatus: 403 });
    await openEconomy();

    fireEvent.change(await screen.findByLabelText('Pin to'), { target: { value: 'v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pin “Flagship” to v2' }));

    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent(/does not carry the permission for this action/i);
    // And it says where the answer is, since the response will not say it.
    expect(refusal).toHaveTextContent(/the log on the box names it/i);

    // The request was made and refused; nothing pretends it succeeded.
    expect(posted).toHaveLength(1);
    expect(screen.queryByText(/moved from v1 to v2/)).toBeNull();
  });

  it('refuses the whole page to a role that cannot read the economy', async () => {
    stubApi({ listStatus: 403 });
    await openEconomy();

    // "You cannot see this", not "something went wrong" — a 403 is the correct
    // answer to the request, and the page has to be able to say so.
    expect(await screen.findByText(/does not carry/i)).toBeInTheDocument();
    expect(screen.getByText('economy.read')).toBeInTheDocument();
  });

  it('shows a version’s stored payload rather than a re-rendering of it', async () => {
    stubApi();
    await openEconomy();

    const table = await screen.findByRole('table', { name: /Newest first/ });
    // By position rather than by text: "v1" is also v2's parent, so it appears
    // in two cells of two different rows.
    const v1Row = within(table).getAllByRole('row')[2]!;
    fireEvent.click(within(v1Row).getByRole('button', { name: 'Inspect' }));

    // The canonical bytes the checksum was taken over, so an admin can verify
    // what they hold. A pretty-printed object would not be that.
    expect(await screen.findByText(DETAIL.payloadJson)).toBeInTheDocument();
    // The seed has no parent, and says so rather than showing an empty diff.
    expect(screen.getByText(/has no parent, which makes it the seed/i)).toBeInTheDocument();
  });
});
