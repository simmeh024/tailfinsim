import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { AdminWorldSummary, MeResponse, VersionResponse } from '@tailfin/shared';

import { App } from '../App';

/**
 * The world-creation form (M1A-02).
 *
 * What is worth protecting here is that a refusal lands where the mistake is.
 * A form that says "something went wrong" for a duplicate name is a form that
 * gets an admin poking at the epoch field.
 */

const ADMIN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Amelia Hart',
    avatarUrl: null,
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: true,
};

const VERSION: VersionResponse = {
  build: 210,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-18T20:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-18T19:55:00.000Z',
  serverTime: '2026-08-18T20:05:00.000Z',
};

const FLAGSHIP: AdminWorldSummary = {
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
  pendingEvents: 3,
  airlines: 4,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** What the speed endpoint answers, and what it was sent. */
const SPEED_OK = {
  world: { ...FLAGSHIP, speedMultiplier: 3 },
  before: {
    speedMultiplier: 2,
    launchDate: '2026-08-17T00:00:00.000Z',
    inGameDate: '2024-10-23T00:00:00.000Z',
  },
  after: {
    speedMultiplier: 3,
    launchDate: '2026-08-17T12:00:00.000Z',
    inGameDate: '2024-10-23T00:00:00.000Z',
  },
  pendingEvents: 3,
  driftMs: 0,
};

/** `createReply` decides what POST /api/admin/worlds answers. */
function stubApi(
  createReply: { body: unknown; status: number } = { body: {}, status: 201 },
  speedReply: { body: unknown; status: number } = { body: SPEED_OK, status: 200 },
  worlds: AdminWorldSummary[] = [FLAGSHIP],
) {
  const posted: unknown[] = [];
  const speedPosts: unknown[] = [];
  const fetchMock = vi.fn((input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (url.endsWith('/speed')) {
      speedPosts.push({ url, body: JSON.parse(init?.body ?? '{}') as unknown });
      return Promise.resolve(jsonResponse(speedReply.body, speedReply.status));
    }
    if (url === '/api/me') return Promise.resolve(jsonResponse(ADMIN));
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url === '/api/admin/audit') return Promise.resolve(jsonResponse({ entries: [] }));
    if (url === '/api/admin/overview')
      return Promise.resolve(
        jsonResponse({
          counts: { players: 1, worlds: 1, admins: 1, airports: 85915, auditEntries: 3 },
          backup: null,
          alerts: [],
        }),
      );
    if (url === '/api/admin/admins') return Promise.resolve(jsonResponse({ admins: [] }));
    if (url === '/api/admin/worlds/health')
      return Promise.resolve(
        jsonResponse({
          worlds: [],
          datasets: [],
          serverTime: '2026-08-19T12:00:00.000Z',
          behindAfterMs: 60000,
        }),
      );

    if (url === '/api/admin/worlds') {
      if (init?.method === 'POST') {
        posted.push(JSON.parse(init.body ?? '{}'));
        return Promise.resolve(jsonResponse(createReply.body, createReply.status));
      }
      return Promise.resolve(jsonResponse({ worlds }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posted, speedPosts };
}

function renderConsole() {
  return render(
    <MemoryRouter initialEntries={['/admin/worlds']}>
      <App />
    </MemoryRouter>,
  );
}

async function fillName(name: string): Promise<void> {
  const input = await screen.findByLabelText('Name');
  fireEvent.change(input, { target: { value: name } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: /create world/i }));
}

describe('the world list', () => {
  it('shows what exists, with the in-game date', async () => {
    stubApi();
    renderConsole();

    expect(await screen.findByText('Flagship')).toBeInTheDocument();
    // The date an admin actually wants: what day it is in there.
    expect(screen.getByText('2024-10-23 00:00')).toBeInTheDocument();
    expect(screen.getByText('2.00×')).toBeInTheDocument();
  });
});

describe('creating a world', () => {
  it('sends the config the server expects', async () => {
    const { posted } = stubApi({
      status: 201,
      body: { world: { ...FLAGSHIP, id: 'new', name: 'Second' } },
    });
    renderConsole();

    await fillName('Second');
    submit();

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]).toEqual({
      name: 'Second',
      epoch: '2024-10-20T00:00:00.000Z',
      speedMultiplier: 2,
      aircraftCatalogueVersion: 'v1',
      economyConfigVersion: 'v1',
      playerCap: null,
    });
  });

  it('never asks for a status, so an open world is not expressible here', async () => {
    const { posted } = stubApi({
      status: 201,
      body: { world: { ...FLAGSHIP, id: 'new', name: 'Third' } },
    });
    renderConsole();

    await fillName('Third');
    submit();

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]).not.toHaveProperty('status');
    // No status control on the form itself — scoped to the form, because the
    // app's bottom strip is also labelled "Status".
    const form = document.querySelector('.admin__form');
    expect(form?.querySelector('[id*="status"], [name*="status"]')).toBeNull();
  });

  it('says the world was created, and in what state', async () => {
    stubApi({ status: 201, body: { world: { ...FLAGSHIP, id: 'new', name: 'Fourth' } } });
    renderConsole();

    await fillName('Fourth');
    submit();

    expect(await screen.findByRole('status')).toHaveTextContent(/created .Fourth., in staging/i);
  });

  it('puts a duplicate-name refusal against the name field', async () => {
    // The acceptance criterion, as the admin experiences it: the message names
    // the problem and sits where the problem is.
    stubApi({
      status: 409,
      body: {
        code: 'world_exists',
        message: 'A world called "Flagship" already exists.',
        fields: { name: ['A world with this name already exists. Pick another.'] },
      },
    });
    renderConsole();

    await fillName('Flagship');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already exists/i);

    // Tied to the name input by `aria-describedby`, which is the relationship
    // that actually reaches a screen reader — stronger than DOM proximity, and
    // it survives the markup being rearranged.
    const input = await screen.findByLabelText('Name');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('leaves the field name alone when it carries an error', async () => {
    // The error is a *description*, not part of what the field is called. Folding
    // it into the label would have a screen reader announce the input as
    // "Name A world with this name already exists."
    stubApi({
      status: 409,
      body: { code: 'world_exists', message: 'x', fields: { name: ['Already exists.'] } },
    });
    renderConsole();

    await fillName('Flagship');
    submit();

    await screen.findByRole('alert');
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
  });

  it('puts an epoch refusal against the epoch field', async () => {
    stubApi({
      status: 400,
      body: {
        code: 'invalid_world',
        message: 'This world cannot be created as described.',
        fields: { epoch: ['The epoch has to be in the past.'] },
      },
    });
    renderConsole();

    await fillName('Future');
    submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/has to be in the past/i);
    const epoch = screen.getByLabelText('Epoch (UTC)');
    expect(epoch.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('still says something when the refusal carries no field detail', async () => {
    // Otherwise the button appears to do nothing and the admin concludes it is
    // broken.
    stubApi({ status: 400, body: { code: 'invalid_world', message: 'No.' } });
    renderConsole();

    await fillName('Whatever');
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent('No.');
  });

  it('clears the name after a success, so the next one is not a duplicate', async () => {
    stubApi({ status: 201, body: { world: { ...FLAGSHIP, id: 'new', name: 'Fifth' } } });
    renderConsole();

    await fillName('Fifth');
    submit();

    await screen.findByRole('status');
    expect(await screen.findByLabelText('Name')).toHaveValue('');
  });
});

/**
 * Changing the speed of a running world (M1A-03).
 *
 * The acceptance criterion this file owns is the third one: *the confirmation
 * states the current speed, the new one, and what happens to scheduled events*.
 * The rest — that the calendar does not move, that events keep their in-game
 * moment — is the server's, and `speed.test.ts` proves it against a database.
 *
 * So these tests are about what an admin is told **before** agreeing, and about
 * the change being impossible to make by accident.
 */

async function openSpeedControl(): Promise<void> {
  const button = await screen.findByRole('button', { name: 'Manage Flagship' });
  fireEvent.click(button);
}

function setSpeed(value: string): void {
  fireEvent.change(screen.getByLabelText('New speed multiplier'), { target: { value } });
}

function review(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
}

describe('changing a world speed', () => {
  it('is not offered until a row is picked', async () => {
    stubApi();
    renderConsole();

    await screen.findByText('Flagship');
    expect(screen.queryByLabelText('New speed multiplier')).toBeNull();
  });

  it('shows what the world is doing now', async () => {
    stubApi();
    renderConsole();
    await openSpeedControl();

    // The current speed and the current in-game date, so the change is decided
    // against the world as it is rather than from memory.
    expect(await screen.findByRole('heading', { name: 'Speed' })).toBeInTheDocument();
    expect(screen.getByLabelText('New speed multiplier')).toHaveValue(2);
    expect(screen.getByText(/runs at/)).toHaveTextContent('2.00×');
    expect(screen.getByText(/runs at/)).toHaveTextContent('2024-10-23 00:00');
  });

  it('will not send anything until the change has been reviewed', async () => {
    // The change is two steps on purpose. One click on a number field must not
    // be able to re-anchor a live world's clock.
    const { speedPosts } = stubApi();
    renderConsole();
    await openSpeedControl();
    setSpeed('3');

    expect(screen.queryByRole('button', { name: /^Change speed to/ })).toBeNull();
    expect(speedPosts).toHaveLength(0);

    review();
    expect(await screen.findByRole('button', { name: 'Change speed to 3.00×' })).toBeEnabled();
    // Still nothing sent: reviewing is reading, not doing.
    expect(speedPosts).toHaveLength(0);
  });

  it('states the current speed, the new speed and what happens to scheduled events', async () => {
    // The acceptance criterion, read as an admin reads it.
    stubApi();
    renderConsole();
    await openSpeedControl();
    setSpeed('3');
    review();

    const confirm = await screen.findByRole('group', { name: /confirm the speed change/i });
    expect(confirm).toHaveTextContent('2.00× → 3.00×');
    expect(confirm).toHaveTextContent(/3 scheduled events keep the in-game moment/i);
    expect(confirm).toHaveTextContent(/nothing is rescheduled/i);
    // And what actually changes for them: the real-world wait. Thirty real
    // minutes buys an in-game hour at 2×, and twenty at 3×.
    expect(confirm).toHaveTextContent(/30 minutes now would take 20 minutes/i);
    expect(confirm).toHaveTextContent(/does not jump/i);
    expect(confirm).toHaveTextContent(/audit log/i);
  });

  it('says plainly that the past is rewritten, which is the part nobody expects', async () => {
    // ADR-0005's accepted cost. Leaving it out would make the confirmation a
    // reassurance rather than a description.
    stubApi();
    renderConsole();
    await openSpeedControl();
    setSpeed('4');
    review();

    const confirm = await screen.findByRole('group', { name: /confirm the speed change/i });
    expect(confirm).toHaveTextContent(/past is rewritten/i);
    expect(confirm).toHaveTextContent(/changing the speed back does not undo it/i);
  });

  it('sends the speed it showed, and the speed it believed', async () => {
    // `expectedSpeedMultiplier` is what makes the confirmation binding: the
    // server refuses if the world has moved on since it was rendered.
    const { speedPosts } = stubApi();
    renderConsole();
    await openSpeedControl();
    setSpeed('3');
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Change speed to 3.00×' }));

    await waitFor(() => {
      expect(speedPosts).toHaveLength(1);
    });
    expect(speedPosts[0]).toEqual({
      url: '/api/admin/worlds/ffffffff-1111-2222-3333-444444444444/speed',
      body: { speedMultiplier: 3, expectedSpeedMultiplier: 2 },
    });
  });

  it('confirms afterwards that the calendar did not move', async () => {
    stubApi();
    renderConsole();
    await openSpeedControl();
    setSpeed('3');
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Change speed to 3.00×' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('now runs at 3.00×');
    expect(status).toHaveTextContent('2024-10-23 00:00');
  });

  it('abandons the confirmation when the number changes underneath it', async () => {
    // Otherwise a review of 3× could be committed as 9× by typing after reading
    // it — the confirmation has to be about the value it named.
    stubApi();
    renderConsole();
    await openSpeedControl();
    setSpeed('3');
    review();
    await screen.findByRole('button', { name: 'Change speed to 3.00×' });

    setSpeed('9');
    expect(screen.queryByRole('button', { name: /^Change speed to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Review change' })).toBeInTheDocument();
  });

  it('cancels without sending anything', async () => {
    const { speedPosts } = stubApi();
    renderConsole();
    await openSpeedControl();
    setSpeed('3');
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('group', { name: /confirm/i })).toBeNull();
    expect(speedPosts).toHaveLength(0);
  });

  it('will not offer to change a speed to the one it already is', async () => {
    stubApi();
    renderConsole();
    await openSpeedControl();
    setSpeed('2');

    expect(screen.getByRole('button', { name: 'Review change' })).toBeDisabled();
  });

  it('puts a refusal where the admin can act on it', async () => {
    // A stale expectation: somebody else changed the speed while this was on
    // screen. The message has to name what the world is actually doing.
    stubApi(undefined, {
      status: 409,
      body: {
        code: 'speed_stale',
        message: 'The world is no longer running at the speed you were shown.',
        fields: {
          form: ['Flagship is running at 5.00×, not 2.00× as shown. Somebody else changed it.'],
        },
      },
    });
    renderConsole();
    await openSpeedControl();
    setSpeed('3');
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Change speed to 3.00×' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/somebody else changed it/i);

    // Tied to the input, and the confirmation is gone — the sentence it stated
    // is no longer true, so it must not still be sitting there ready to click.
    const input = screen.getByLabelText('New speed multiplier');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
    expect(screen.queryByRole('button', { name: /^Change speed to/ })).toBeNull();
  });

  it('shows the queue depth in the list, which is what the confirmation counts', async () => {
    stubApi();
    renderConsole();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('3')).toBeInTheDocument();
  });
});

describe('what the confirmation says about the queue', () => {
  async function confirmWith(pendingEvents: number): Promise<HTMLElement> {
    stubApi(undefined, undefined, [{ ...FLAGSHIP, pendingEvents }]);
    renderConsole();
    await openSpeedControl();
    setSpeed('3');
    review();
    return screen.findByRole('group', { name: /confirm the speed change/i });
  }

  it('does not claim that nought events keep their moment', async () => {
    // "0 scheduled events keep the in-game moment they have" is not a sentence
    // anyone should be asked to agree to. An empty queue is worth saying plainly,
    // because it is the case where an admin can stop worrying.
    const confirm = await confirmWith(0);
    expect(confirm).toHaveTextContent(/nothing is scheduled in this world/i);
    expect(confirm).not.toHaveTextContent(/0 scheduled/);
    // Still true of anything scheduled later, and worth saying so.
    expect(confirm).toHaveTextContent(/stored in game time/i);
  });

  it('counts one event in the singular', async () => {
    const confirm = await confirmWith(1);
    expect(confirm).toHaveTextContent(/1 scheduled event keeps the in-game moment it has/i);
  });

  it('counts several in the plural', async () => {
    const confirm = await confirmWith(12);
    expect(confirm).toHaveTextContent(/12 scheduled events keep the in-game moment they have/i);
  });
});
