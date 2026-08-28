import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      const body =
        url === '/api/me'
          ? SIGNED_IN
          : url === '/api/airlines/founding-options'
            ? {
                memberships: [
                  {
                    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                    worldId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
                  },
                ],
                worlds: [],
              }
            : url === '/api/airlines/me'
              ? {
                  airline: {
                    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                    worldId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
                    playerId: SIGNED_IN.player?.id,
                    name: 'Shell Air',
                    iataCode: 'SH',
                    icaoCode: 'SHL',
                    callsign: 'SHELL',
                    baseCountry: 'NL',
                    cash: 50_000_000,
                    reputation: 0.35,
                    status: 'active',
                    statusChangedAt: '2026-08-17T10:00:00.000Z',
                    ceasedAt: null,
                    createdAt: '2026-08-17T10:00:00.000Z',
                  },
                  rebrand: {
                    costMinor: 2_500_000,
                    mutableFields: ['name', 'callsign', 'baseCountry'],
                    immutableFields: ['iataCode', 'icaoCode', 'cash', 'reputation'],
                  },
                }
              : url === '/api/office/executive'
                ? {
                    unlocked: false,
                    officesUnlocked: 0,
                    unlockCostMinor: 10_000_000_000,
                    revenueGateMinor: 5_000_000_000,
                    monthlyRevenueMinor: 0,
                    nextOffice: null,
                    hires: [],
                  }
                : {};
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
    // The stage is the one `main` landmark and is deliberately unnamed: it holds
    // whichever page is routed, not the world in particular.
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });

  it('shows the Head Office floor-plan only on the Headquarters page', async () => {
    const world = await renderAt('/world');
    // Elsewhere the panel is the plain selection surface, not the office.
    expect(world.container.querySelector('.hq-layout__floor')).toBeNull();
    expect(screen.getByText(/Selection detail appears here/i)).toBeInTheDocument();
    world.unmount();

    const hq = await renderAt('/headquarters');
    expect(hq.container.querySelector('.hq-layout__floor')).not.toBeNull();
  });

  it('drops the context panel on the C-Suite page and shows the executive floor inline', async () => {
    // Freeze the clock so the C-Suite page's once-a-second countdown is a no-op
    // (setNow to the same value bails the re-render) — otherwise it lands a state
    // update after the test, as an unwrapped act warning.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 28, 9, 0, 0));
    try {
      const { container } = await renderAt('/c-suite');
      // No context window beside the page…
      expect(screen.queryByRole('complementary', { name: 'Context' })).toBeNull();
      // …and the executive floor plan is rendered on the page itself instead, once
      // the page's floor fetch resolves.
      await waitFor(() =>
        expect(container.querySelector('.hq-layout__floor--exec')).not.toBeNull(),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('renders the world on the World page and nowhere else', async () => {
    const { unmount } = await renderAt('/world');
    expect(screen.getByLabelText('Interactive world renderer')).toBeInTheDocument();
    unmount();

    // The shell used to mount the renderer for every route with the page drawn
    // on top of it, so a WebGL context and its frames were paid for on screens
    // that never showed a map — and page content took every drag aimed at it.
    await renderAt('/fleet');
    expect(screen.queryByLabelText('Interactive world renderer')).toBeNull();
  });

  it('has a rail link for each destination', async () => {
    await renderAt('/world');
    const rail = screen.getByRole('navigation', { name: 'Main' });
    expect(NAV_ITEMS).toHaveLength(8);
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
    expect(await within(strip).findByText('500,000.00')).toBeInTheDocument();
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
    ['/airline', 'Shell Air'],
    ['/fleet', 'Fleet'],
    ['/network', 'Network'],
    ['/finance', 'Finance'],
    ['/crew', 'Crew'],
    ['/headquarters', 'Headquarters'],
    ['/design', 'Shell Air'],
    ['/board', 'Board'],
  ])('%s renders its page', async (path, title) => {
    await renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
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

describe('the shell grid', () => {
  /**
   * A renamed grid area that one `@media` block still spells the old way places
   * nothing: `grid-area: stage` matches no named area, the element is auto-placed,
   * and on a narrow viewport it collapsed to **24 pixels** — the whole page, not
   * just the world, reduced to a dot in the corner.
   *
   * Renaming `world` to `stage` did exactly that and the base layout hid it,
   * because desktop widths never reach the media query. This asserts every area
   * named in any `grid-template-areas` is one an element actually claims.
   */
  it('places every named area, at every breakpoint', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'shell.css'), 'utf8');

    const claimed = new Set(
      [...css.matchAll(/grid-area:\s*([a-z-]+)\s*;/gi)].map((match) => String(match[1])),
    );
    const named = new Set(
      [...css.matchAll(/grid-template-areas:([^;]+);/gi)].flatMap((match) =>
        [...String(match[1]).matchAll(/'([^']+)'/g)].flatMap((row) =>
          String(row[1]).trim().split(/\s+/),
        ),
      ),
    );

    expect(named.size).toBeGreaterThan(0);
    const orphans = [...named].filter((area) => area !== '.' && !claimed.has(area));
    expect(orphans, 'grid areas named in a template that nothing claims').toEqual([]);
  });
});
