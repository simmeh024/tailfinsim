import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeResponse } from '@tailfin/shared';

import { App } from '../App';

import { NAV_ITEMS } from './AppShell';

/**
 * Shell tests.
 *
 * `App` takes its router from the caller, so these use `MemoryRouter` and never
 * touch browser history — the route table is testable without a DOM navigation.
 *
 * Since M0-12 the shell only renders behind a session, so each test signs in
 * first. `renderAt` waits for the rail to appear, which is the point at which
 * the login wall has resolved and the shell is actually mounted. The wall itself
 * is covered in auth/session-ui.test.tsx.
 */

const SIGNED_IN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Shell Tester',
    avatarUrl: null,
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: false,
};

async function renderAt(path: string) {
  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('navigation', { name: 'Main' });
  return result;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const body = url === '/api/me' ? SIGNED_IN : {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
});

afterEach(() => {
  localStorage.clear();
});

describe('layout', () => {
  it('renders the four regions from App. H.4', async () => {
    await renderAt('/world');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'World' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('has a rail link for each of the seven destinations', async () => {
    await renderAt('/world');
    const rail = screen.getByRole('navigation', { name: 'Main' });
    expect(NAV_ITEMS).toHaveLength(7);
    for (const item of NAV_ITEMS) {
      expect(within(rail).getByRole('link', { name: new RegExp(item.label, 'i') })).toHaveAttribute(
        'href',
        item.to,
      );
    }
  });

  it('shows cash, runway, airborne and alerts in the status strip', async () => {
    await renderAt('/world');
    const strip = screen.getByLabelText('Status');
    for (const label of ['Cash', 'Runway', 'Airborne', 'Alerts']) {
      expect(within(strip).getByText(label)).toBeInTheDocument();
    }
  });

  it('marks up figures for tabular numerals so digits do not jitter', async () => {
    // H.4 asks for a tabular monospace for figures specifically.
    await renderAt('/world');
    const strip = screen.getByLabelText('Status');
    expect(strip.querySelectorAll('.figure').length).toBeGreaterThan(0);
  });
});

describe('context panel is dismissible', () => {
  it('hides on dismiss and offers a way back', async () => {
    await renderAt('/world');
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss panel' }));
    expect(screen.queryByRole('complementary', { name: 'Context' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show panel' }));
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeInTheDocument();
  });
});

describe('routing', () => {
  it.each([
    ['/world', 'World'],
    ['/fleet', 'Fleet'],
    ['/network', 'Network'],
    ['/finance', 'Finance'],
    ['/crew', 'Crew'],
    ['/design', 'Design'],
    ['/board', 'Board'],
  ])('%s renders its page', async (path, title) => {
    await renderAt(path);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
  });

  it('redirects / to /world rather than duplicating the view', async () => {
    await renderAt('/');
    // Awaited, not synchronous: behind the login wall the shell mounts only once
    // the session resolves, so the index redirect lands a render later.
    expect(await screen.findByRole('heading', { level: 1, name: 'World' })).toBeInTheDocument();
  });

  it('shows a not-found page for an unknown path, still inside the shell', async () => {
    await renderAt('/nonsense');
    expect(screen.getByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    // The world stays visible behind it — the shell is not replaced.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('marks the current destination for assistive tech, not just visually', async () => {
    await renderAt('/fleet');
    const rail = screen.getByRole('navigation', { name: 'Main' });
    expect(within(rail).getByRole('link', { name: /Fleet/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('theme', () => {
  it('defaults to dark, as App. H.4 requires', async () => {
    await renderAt('/world');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('toggles and persists the choice to localStorage', async () => {
    await renderAt('/world');
    fireEvent.click(screen.getByRole('button', { name: /Switch to light theme/i }));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('tailfin.theme')).toBe('light');
  });

  it('restores a stored preference on next load', async () => {
    localStorage.setItem('tailfin.theme', 'light');
    await renderAt('/world');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('falls back to dark when the stored value is nonsense', async () => {
    localStorage.setItem('tailfin.theme', 'chartreuse');
    await renderAt('/world');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('labels the control by what it will do, not by current state', async () => {
    // "Dark" as a label is ambiguous — is that the state or the action?
    await renderAt('/world');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });
});
