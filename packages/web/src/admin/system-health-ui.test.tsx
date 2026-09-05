import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSystemHealthResponse, MeResponse, VersionResponse } from '@tailfin/shared';

import { App } from '../App';
import { waitForSignInCheck } from '../test-gates';

/**
 * System Health, as an admin meets it (OPS-15).
 *
 * The one thing this page must never do is show a comforting word next to a
 * machine that has stopped. Everything below is about that: the state is words
 * as well as colour, the server's sentence is rendered rather than recomputed,
 * and a worker that is up with a dead engine does not read as fine.
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
  build: 218,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-21T12:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-21T11:55:00.000Z',
  serverTime: '2026-08-21T12:05:00.000Z',
};

const LOAD = {
  cpuPercent: 12.5,
  loadAverage1m: 0.25,
  cores: 2,
  processMemoryBytes: 125_829_120,
  memoryUsedPercent: 41.2,
  memoryTotalBytes: 4_000_000_000,
};

const HEALTHY: AdminSystemHealthResponse = {
  nodes: [
    {
      node: 'tailfin-dev-web',
      role: 'web',
      environment: 'dev',
      state: 'online',
      detail: 'Reporting normally and serving requests.',
      build: 218,
      commit: 'abc9999',
      startedAt: '2026-08-21T11:00:00.000Z',
      lastSeenAt: '2026-08-21T12:04:55.000Z',
      ageMs: 5000,
      uptimeSeconds: 3900,
      load: LOAD,
      engine: null,
    },
    {
      node: 'tailfin-dev-worker',
      role: 'worker',
      environment: 'dev',
      state: 'online',
      detail: 'Ticking, with nothing to do: 1204 ticks, queue empty.',
      build: 218,
      commit: 'abc9999',
      startedAt: '2026-08-21T11:30:00.000Z',
      lastSeenAt: '2026-08-21T12:04:58.000Z',
      ageMs: 2000,
      uptimeSeconds: 2100,
      load: { ...LOAD, cpuPercent: 67.4 },
      engine: {
        running: true,
        ticks: 1204,
        errors: 0,
        lateTicks: 0,
        processed: 0,
        failed: 0,
        unsupported: 0,
        aircraftDeliveries: 0,
        aircraftDeliveryErrors: 0,
        lastTickAt: '2026-08-21T12:04:58.000Z',
        queueDue: 0,
        oldestDueAt: null,
        unhandledEventTypes: [],
      },
    },
  ],
  serverTime: '2026-08-21T12:05:00.000Z',
  staleAfterMs: 45_000,
  offlineAfterMs: 120_000,
  alerts: [],
  unsupportedEvents: [],
  rateLimits: [
    { class: 'read', max: 1200, windowMs: 60_000, exceeded: 0 },
    { class: 'write', max: 240, windowMs: 60_000, exceeded: 3 },
    { class: 'auth', max: 20, windowMs: 900_000, exceeded: 0 },
  ],
};

function stubApi(health: AdminSystemHealthResponse = HEALTHY) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

      if (url === '/api/me') return json(ADMIN);
      if (url === '/api/version') return json(VERSION);
      if (url === '/api/admin/system-health') return json(health);
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

async function openSystemHealth(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/admin/system']}>
      <App />
    </MemoryRouter>,
  );
  await waitForSignInCheck();
}

describe('the system health page', () => {
  it('is in the console nav, at /admin/system', async () => {
    stubApi();
    await openSystemHealth();

    const nav = await screen.findByRole('navigation', { name: 'Admin sections' });
    expect(within(nav).getByRole('link', { name: 'System health' })).toHaveAttribute(
      'href',
      '/admin/system',
    );
  });

  it('shows each node with its role, build and load', async () => {
    stubApi();
    await openSystemHealth();

    const web = await screen.findByRole('article', { name: /Web — tailfin-dev-web/ });
    const worker = screen.getByRole('article', { name: /Engine — tailfin-dev-worker/ });

    expect(within(web).getByText('218')).toBeInTheDocument();
    expect(within(web).getByText('12.5%')).toBeInTheDocument();
    expect(within(worker).getByText('67.4%')).toBeInTheDocument();
    // The engine's own counters, which only a worker carries.
    expect(within(worker).getByText('1204')).toBeInTheDocument();
  });

  it('says the state in words, not only in colour', async () => {
    stubApi();
    await openSystemHealth();

    const web = await screen.findByRole('article', { name: /tailfin-dev-web/ });
    // A status carried by colour alone is invisible in greyscale, in a
    // screenshot, and to a screen reader (H.7).
    expect(within(web).getByText('Online')).toBeInTheDocument();
  });

  it('renders the server’s sentence rather than deciding for itself', async () => {
    stubApi();
    await openSystemHealth();

    // §21: a browser with a skewed clock must not reach a different conclusion
    // about a node than the server did.
    expect(
      await screen.findByText('Ticking, with nothing to do: 1204 ticks, queue empty.'),
    ).toBeInTheDocument();
  });

  it('does not call a worker healthy when its engine has stopped', async () => {
    stubApi({
      ...HEALTHY,
      nodes: [
        HEALTHY.nodes[0]!,
        {
          ...HEALTHY.nodes[1]!,
          state: 'stale',
          detail: 'The process is alive and the engine is stopped. Nothing is being drained.',
          engine: { ...HEALTHY.nodes[1]!.engine!, running: false },
        },
      ],
    });
    await openSystemHealth();

    const worker = await screen.findByRole('article', { name: /tailfin-dev-worker/ });
    expect(within(worker).getByText('Stale')).toBeInTheDocument();
    expect(within(worker).queryByText('Online')).toBeNull();
    expect(within(worker).getByText(/engine is stopped/i)).toBeInTheDocument();
  });

  it('surfaces the server’s alerts where they cannot be missed', async () => {
    stubApi({
      ...HEALTHY,
      alerts: ['Nodes are running different builds: web-01 on 218, worker-01 on 214.'],
    });
    await openSystemHealth();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/different builds/i);
  });

  it('says so plainly when nothing has ever reported', async () => {
    stubApi({ ...HEALTHY, nodes: [], alerts: [] });
    await openSystemHealth();

    expect(await screen.findByText(/no node has ever written a heartbeat/i)).toBeInTheDocument();
  });

  it('explains that it reads a table rather than contacting the machines', async () => {
    stubApi();
    await openSystemHealth();

    // Worth stating on the page: an admin who assumes this polls the worker will
    // misread a stale node as a network problem at their end.
    expect(await screen.findByText(/cannot reach them, deliberately/i)).toBeInTheDocument();
  });

  it('shows this node’s rate-limit budgets and how often each has fired', async () => {
    // The false positive is the failure that hurts: a budget set slightly too
    // low refuses real players and looks, from outside, like a broken game. A
    // limit nobody can see firing cannot be tuned (SEC-HARD-09).
    stubApi();
    await openSystemHealth();

    const table = await screen.findByRole('table', { name: /Rate limits on/ });
    const write = within(table).getByText('write').closest('tr');
    expect(within(write!).getByText('240 / minute')).toBeInTheDocument();
    expect(within(write!).getByText('3')).toBeInTheDocument();

    // A quarter-hour window is read as one, not as 900000.
    const auth = within(table).getByText('auth').closest('tr');
    expect(within(auth!).getByText('20 / 15 minutes')).toBeInTheDocument();

    // The multi-node caveat is on the page, not only in an issue.
    expect(within(table).getByText(/OPS-11/)).toBeInTheDocument();
  });
});
