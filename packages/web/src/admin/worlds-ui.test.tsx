import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** `createReply` decides what POST /api/admin/worlds answers. */
function stubApi(createReply: { body: unknown; status: number } = { body: {}, status: 201 }) {
  const posted: unknown[] = [];
  const fetchMock = vi.fn((input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (url === '/api/me') return Promise.resolve(jsonResponse(ADMIN));
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url === '/api/admin/audit') return Promise.resolve(jsonResponse({ entries: [] }));
    if (url === '/api/admin/admins') return Promise.resolve(jsonResponse({ admins: [] }));
    if (url === '/api/admin/worlds') {
      if (init?.method === 'POST') {
        posted.push(JSON.parse(init.body ?? '{}'));
        return Promise.resolve(jsonResponse(createReply.body, createReply.status));
      }
      return Promise.resolve(jsonResponse({ worlds: [FLAGSHIP] }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { posted };
}

function renderConsole() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
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
