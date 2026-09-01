import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { AdminWorldSummary, MeResponse, VersionResponse, WorldStatus } from '@tailfin/shared';

import { App } from '../App';
import { waitForSignInCheck } from '../test-gates';

/**
 * A world's lifecycle, as an admin meets it (M1A-04).
 *
 * The server owns whether a transition is legal and whether a reset may proceed;
 * `admin/lifecycle.test.ts` proves that against a database. What is tested here
 * is the half that only exists in the interface, and that the issue makes an
 * acceptance criterion:
 *
 *   - the confirmation states what will be destroyed
 *   - an open world cannot be reset without the world's name being typed
 *
 * Plus the thing no server test can catch: a destructive button that is easy to
 * press by accident.
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
  build: 211,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-18T20:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-18T19:55:00.000Z',
  serverTime: '2026-08-18T20:05:00.000Z',
};

const WORLD: AdminWorldSummary = {
  id: 'ffffffff-1111-2222-3333-444444444444',
  name: 'Flagship',
  epoch: '2024-10-20T00:00:00.000Z',
  launchDate: '2026-08-17T00:00:00.000Z',
  speedMultiplier: 2,
  status: 'staging',
  aircraftCatalogueVersion: 'v1',
  economyConfigVersion: 'v1',
  playerCap: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  inGameDate: '2024-10-23T00:00:00.000Z',
  pendingEvents: 7,
  airlines: 4,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

interface Reply {
  body: unknown;
  status: number;
}

interface Posted {
  url: string;
  body: unknown;
}

/**
 * Stubs the console's endpoints for one world in a given state.
 *
 * `posts` collects everything sent, so a test can assert that a control which
 * should not have fired a request did not fire one — which for a reset button is
 * the assertion that matters most.
 */
function stubApi(
  world: AdminWorldSummary = WORLD,
  replies: { status?: Reply; reset?: Reply } = {},
) {
  const posts: Posted[] = [];
  const fetchMock = vi.fn((input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);

    if (url.endsWith('/status') || url.endsWith('/reset')) {
      posts.push({ url, body: JSON.parse(init?.body ?? '{}') as unknown });
      const reply = url.endsWith('/status')
        ? (replies.status ?? {
            body: { world, before: world.status, after: 'open' },
            status: 200,
          })
        : (replies.reset ?? {
            body: {
              world: { ...world, status: 'staging', airlines: 0, pendingEvents: 0 },
              destroyed: { airlines: world.airlines, events: world.pendingEvents },
              inGameDate: world.epoch,
              reason: 'testing',
            },
            status: 200,
          });
      return Promise.resolve(jsonResponse(reply.body, reply.status));
    }

    if (url === '/api/me') return Promise.resolve(jsonResponse(ADMIN));
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url === '/api/admin/audit') return Promise.resolve(jsonResponse({ entries: [] }));
    if (url === '/api/admin/admins') return Promise.resolve(jsonResponse({ admins: [] }));
    if (url === '/api/admin/overview')
      return Promise.resolve(
        jsonResponse({
          counts: { players: 1, worlds: 1, admins: 1, airports: 85915, auditEntries: 3 },
          backup: null,
          alerts: [],
        }),
      );
    if (url === '/api/admin/worlds/health')
      return Promise.resolve(
        jsonResponse({
          worlds: [],
          datasets: [],
          serverTime: '2026-08-19T12:00:00.000Z',
          behindAfterMs: 60000,
        }),
      );

    if (url === '/api/admin/worlds') return Promise.resolve(jsonResponse({ worlds: [world] }));

    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posts };
}

/**
 * The world list, once `/api/admin/worlds` has actually answered.
 *
 * The only table these stubs produce: `WorldHealth` renders one of its own for
 * the datasets in use, and the health reply here has none. Queried by role alone
 * rather than by name, so the poll that runs until it appears does not compute an
 * accessible name for every element on the page each time round.
 */
function findWorldList(): Promise<HTMLElement> {
  return screen.findByRole('table');
}

/**
 * The console, open at Worlds, with one world's controls showing.
 *
 * Two gates stand between `render` and a row button, and they are sequential:
 * `/api/me` has to answer before the route tree mounts at all, and only the route
 * tree mounts `WorldsPanel`, which then has to wait for `/api/admin/worlds` before
 * the table has a single row in it. This used to wait straight for
 * `Manage <name>`, which put both gates and every render between them inside one
 * button query — see `test-gates.ts` for what that cost.
 *
 * Each gate is waited for on its own here. The last step needs no wait at all:
 * the table and its row buttons are rendered in the same commit, so once the list
 * is here the button is too, and the lookup can be a plain `getByRole`.
 */
async function openWorld(name = 'Flagship'): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/admin/worlds']}>
      <App />
    </MemoryRouter>,
  );
  await waitForSignInCheck();
  await findWorldList();
  fireEvent.click(screen.getByRole('button', { name: `Manage ${name}` }));
}

function worldIn(status: WorldStatus, overrides: Partial<AdminWorldSummary> = {}) {
  return { ...WORLD, status, ...overrides };
}

describe('the transitions on offer', () => {
  it('offers a staging world the two places it can go', async () => {
    stubApi(worldIn('staging'));
    await openWorld();

    expect(await screen.findByRole('button', { name: 'Open for play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    // Locking something nobody can reach is not a state worth having.
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  });

  it('makes an open world take two steps to archive', async () => {
    // The decision: archiving is permanent and read-only, so doing it to a world
    // with players in flight should be two deliberate acts rather than one.
    stubApi(worldIn('open'));
    await openWorld();

    expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('lets a locked world go back or go away', async () => {
    stubApi(worldIn('locked'));
    await openWorld();

    expect(await screen.findByRole('button', { name: 'Open for play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('offers an archived world nothing, and says why', async () => {
    stubApi(worldIn('archived'));
    await openWorld();

    expect(await screen.findByText(/record of what happened/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open for play' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  });
});

describe('confirming a transition', () => {
  it('says what locking does to the people in the world', async () => {
    stubApi(worldIn('open'));
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }));

    const confirm = await screen.findByRole('group', { name: /confirm the status change/i });
    expect(confirm).toHaveTextContent('open → locked');
    expect(confirm).toHaveTextContent(/play stops/i);
    // The part that is easy to get wrong: locking does not stop the clock, so an
    // aircraft in the air is still in the air when it reopens.
    expect(confirm).toHaveTextContent(/clock keeps running/i);
    expect(confirm).toHaveTextContent(/reversible/i);
  });

  it('says archiving is permanent, and that it destroys nothing', async () => {
    stubApi(worldIn('locked'));
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    const confirm = await screen.findByRole('group', { name: /confirm the status change/i });
    expect(confirm).toHaveTextContent(/permanent/i);
    expect(confirm).toHaveTextContent(/cannot be reopened/i);
    expect(confirm).toHaveTextContent(/4 airlines stay/i);
  });

  it('sends the new status and the one it believed', async () => {
    const { posts } = stubApi(worldIn('staging'));
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Open for play' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open for play “Flagship”' }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]).toEqual({
      url: '/api/admin/worlds/ffffffff-1111-2222-3333-444444444444/status',
      body: { status: 'open', expectedStatus: 'staging' },
    });
  });

  it('sends nothing until the confirmation is agreed to', async () => {
    const { posts } = stubApi(worldIn('staging'));
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Open for play' }));

    await screen.findByRole('group', { name: /confirm the status change/i });
    expect(posts).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(posts).toHaveLength(0);
  });

  it('shows a refusal rather than pretending it worked', async () => {
    const { posts } = stubApi(worldIn('staging'), {
      status: {
        status: 409,
        body: {
          code: 'status_stale',
          message: 'The world is no longer in the state you were shown.',
          fields: { form: ['"Flagship" is open, not staging as shown. Somebody else changed it.'] },
        },
      },
    });
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Open for play' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open for play “Flagship”' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/somebody else changed it/i);
    expect(posts).toHaveLength(1);
  });
});

describe('the reset', () => {
  async function openReset(world: AdminWorldSummary = WORLD): Promise<HTMLElement> {
    stubApi(world);
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: `Reset “${world.name}”…` }));
    return screen.findByRole('group', { name: /confirm the reset/i });
  }

  it('states what it will destroy, in numbers', async () => {
    // The acceptance criterion. "This will delete the airlines" asks for
    // agreement to an unknown quantity.
    const confirm = await openReset();

    expect(confirm).toHaveTextContent(/4 airlines will be deleted/i);
    expect(confirm).toHaveTextContent(/7 scheduled events will be deleted/i);
    expect(confirm).toHaveTextContent(/clock returns to the epoch, 2024-10-20 00:00/i);
    expect(confirm).toHaveTextContent(/back to.*staging/i);
    // And what it does *not* touch, which is the half people assume wrongly.
    expect(confirm).toHaveTextContent(/airports, runways and catchment are untouched/i);
    expect(confirm).toHaveTextContent(/players keep their accounts/i);
  });

  it('warns when the world is one people are playing', async () => {
    const confirm = await openReset(worldIn('open'));
    expect(confirm).toHaveTextContent(/this world is open/i);
    expect(confirm).toHaveTextContent(/loses their airline/i);
  });

  it('will not proceed until the world is named, exactly', async () => {
    // The criterion: an open world cannot be reset without an explicit
    // confirmation naming it. A checkbox is one mis-click; a name is not.
    await openReset(worldIn('open'));
    const button = screen.getByRole('button', { name: 'Reset “Flagship” permanently' });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'go-live rehearsal' } });

    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/type .Flagship. to confirm/i), {
      target: { value: 'flagship' },
    });
    // Close is not the same world. Case matters, because names differ by it.
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/type .Flagship. to confirm/i), {
      target: { value: 'Flagship' },
    });
    expect(button).toBeEnabled();
  });

  it('will not proceed without a reason, because the log needs one', async () => {
    await openReset();
    fireEvent.change(screen.getByLabelText(/type .Flagship. to confirm/i), {
      target: { value: 'Flagship' },
    });

    const button = screen.getByRole('button', { name: 'Reset “Flagship” permanently' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'go-live rehearsal' } });
    expect(button).toBeEnabled();
  });

  it('sends the name, the reason and the status it believed', async () => {
    const { posts } = stubApi(worldIn('open'));
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset “Flagship”…' }));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: '  go-live rehearsal  ' } });
    fireEvent.change(screen.getByLabelText(/type .Flagship. to confirm/i), {
      target: { value: 'Flagship' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset “Flagship” permanently' }));

    await waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]).toEqual({
      url: '/api/admin/worlds/ffffffff-1111-2222-3333-444444444444/reset',
      // Trimmed: a reason of "  " is not a reason, and trailing spaces in a
      // world name are not a different world.
      body: { confirmName: 'Flagship', reason: 'go-live rehearsal', expectedStatus: 'open' },
    });
  });

  it('reports what was actually destroyed afterwards', async () => {
    stubApi(WORLD);
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset “Flagship”…' }));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'starting over' } });
    fireEvent.change(screen.getByLabelText(/type .Flagship. to confirm/i), {
      target: { value: 'Flagship' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset “Flagship” permanently' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/destroyed 4 airlines and 7 scheduled events/i);
    expect(status).toHaveTextContent(/back to 2024-10-20 00:00/i);
  });

  it('puts a refusal against the field that was wrong', async () => {
    stubApi(WORLD, {
      reset: {
        status: 400,
        body: {
          code: 'name_mismatch',
          message: 'That is not the name of this world.',
          fields: { confirmName: ['That is not the name of this world. Type “Flagship” exactly.'] },
        },
      },
    });
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset “Flagship”…' }));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'starting over' } });
    fireEvent.change(screen.getByLabelText(/type .Flagship. to confirm/i), {
      target: { value: 'Flagship' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset “Flagship” permanently' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not the name of this world/i);
  });

  it('is not offered at all for an archived world', async () => {
    stubApi(worldIn('archived'));
    await openWorld();

    expect(await screen.findByText(/archived worlds cannot be reset/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset/ })).toBeNull();
  });

  it('sends nothing when it is cancelled', async () => {
    const { posts } = stubApi(WORLD);
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset “Flagship”…' }));
    fireEvent.change(screen.getByLabelText(/type .Flagship. to confirm/i), {
      target: { value: 'Flagship' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('group', { name: /confirm the reset/i })).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('forgets the typed name when it is cancelled', async () => {
    // Otherwise reopening the panel finds the confirmation already satisfied,
    // and the most destructive button in the console is one click away.
    stubApi(WORLD);
    await openWorld();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset “Flagship”…' }));
    fireEvent.change(screen.getByLabelText(/type .Flagship. to confirm/i), {
      target: { value: 'Flagship' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset “Flagship”…' }));

    expect(screen.getByLabelText(/type .Flagship. to confirm/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reset “Flagship” permanently' })).toBeDisabled();
  });
});

describe('the world list', () => {
  it('shows how much each world is carrying', async () => {
    stubApi(WORLD);
    render(
      <MemoryRouter initialEntries={['/admin/worlds']}>
        <App />
      </MemoryRouter>,
    );

    await waitForSignInCheck();
    const table = await findWorldList();
    expect(within(table).getByText('7')).toBeInTheDocument();
    expect(within(table).getByText('4')).toBeInTheDocument();
  });
});
