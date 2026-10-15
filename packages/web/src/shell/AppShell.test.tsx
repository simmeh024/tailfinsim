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
    displayCurrency: 'USD',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  signInProviders: [],
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
  vi.restoreAllMocks();
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

  it('shows the Head Office floor-plan on the office screens, not elsewhere', async () => {
    // Freeze the clock so the C-Suite page's once-a-second countdown is a no-op
    // (setNow to the same value bails the re-render) rather than an unwrapped
    // state update after the assertions.
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 28, 9, 0, 0));
    const world = await renderAt('/world');
    // Elsewhere the panel is the plain selection surface, not the office.
    expect(world.container.querySelector('.hq-layout__floor')).toBeNull();
    expect(screen.getByText(/Selection detail appears here/i)).toBeInTheDocument();
    world.unmount();

    // The Headquarters page opens on the ground floor plan.
    const hq = await renderAt('/headquarters');
    expect(hq.container.querySelector('.hq-layout__floor')).not.toBeNull();
    hq.unmount();

    // The C-Suite page shares the same panel but opens on the executive floor.
    const csuite = await renderAt('/c-suite');
    expect(screen.getByRole('complementary', { name: 'Context' })).toBeInTheDocument();
    await waitFor(() =>
      expect(csuite.container.querySelector('.hq-layout__floor--exec')).not.toBeNull(),
    );
  });

  it('renders the world on the World page and nowhere else', async () => {
    const { unmount } = await renderAt('/world');
    // `findBy` since PERF-01: the world page is a lazily-loaded chunk, so it
    // arrives a microtask after the shell rather than with it. `renderAt` waits
    // for the rail, which is eager; the page behind it needs its own wait.
    expect(await screen.findByLabelText('Interactive world renderer')).toBeInTheDocument();
    unmount();

    // The shell used to mount the renderer for every route with the page drawn
    // on top of it, so a WebGL context and its frames were paid for on screens
    // that never showed a map — and page content took every drag aimed at it.
    await renderAt('/fleet');
    // Waiting for the fleet page to actually arrive, so this asserts "the world
    // is absent from a loaded page" rather than "the page has not loaded yet",
    // which would pass against a shell that still mounted the renderer.
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByLabelText('Interactive world renderer')).toBeNull();
  });

  it('has a rail link for each destination', async () => {
    await renderAt('/world');
    const rail = screen.getByRole('navigation', { name: 'Main' });
    // Eight from App. H.4 and M5-04, plus M8-05's Service configurator,
    // M8-10's Dashboard — which leads the rail, because §14 calls the dashboard
    // the game's main interface after the first week — M8-13's Alerts, and
    // M9-05's Research tree beside the crew who earn its points.
    expect(NAV_ITEMS).toHaveLength(13);
    expect(NAV_ITEMS[0]?.to).toBe('/dashboard');
    // M8-12's operational dashboards sit beside the executive one: a player
    // asking "why was yesterday bad?" starts at the headline and goes there.
    expect(NAV_ITEMS[1]?.to).toBe('/operations');
    // M8-13's alerts sit next to both, because every row links away to the
    // screen that can act on it — the page is a junction, not a workplace.
    expect(NAV_ITEMS[2]?.to).toBe('/alerts');
    for (const item of NAV_ITEMS) {
      /*
       * An **exact** name, not a substring. The loose `new RegExp(label)` this
       * used to be broke the moment a label contained another one — "Dashboard"
       * matches /Board/i — and reported it as two links for one destination
       * rather than as an ambiguous query. The accessible names are distinct;
       * only the matcher was not.
       */
      expect(
        within(rail).getByRole('link', {
          name: (accessibleName) => accessibleName.trim() === item.label,
        }),
      ).toHaveAttribute('href', item.to);
    }
  });

  it('shows cash, runway, airborne and alerts in the status strip', async () => {
    await renderAt('/world');
    const strip = screen.getByLabelText('Status');
    for (const label of ['Cash', 'Runway', 'Airborne', 'Alerts']) {
      expect(within(strip).getByText(label)).toBeInTheDocument();
    }
    expect(await within(strip).findByText('$500,000.00')).toBeInTheDocument();
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
    ['/research', 'Research'],
    ['/headquarters', 'Headquarters'],
    ['/service', 'Service'],
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

describe('on a phone (UX pass)', () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'shell.css'), 'utf8');
  /** The body of the shell's own `max-width: 48rem` block — the one that lays out the grid. */
  const phone = (() => {
    const start = css.indexOf('@media (max-width: 48rem) {\n  .shell {');
    return start === -1 ? '' : css.slice(start, css.indexOf('\n}\n', start));
  })();

  it('keeps the check-in destinations in the bar and puts the rest behind More', async () => {
    await renderAt('/dashboard');
    const rail = screen.getByRole('navigation', { name: 'Main' });
    // App. H.6: "one glance at cash, alerts, and aircraft airborne", and its next tap.
    expect(NAV_ITEMS.filter((item) => item.phoneBar === true).map((item) => item.to)).toEqual([
      '/dashboard',
      '/alerts',
      '/world',
      '/fleet',
      '/network',
    ]);
    // Every destination is still a link in the rail — full parity is the sheet.
    for (const item of NAV_ITEMS) {
      const link = within(rail).getByRole('link', { name: new RegExp(item.label) });
      expect(link.classList.contains('rail__link--more')).toBe(item.phoneBar !== true);
    }
    expect(phone).toMatch(
      /\.rail__link--more,\s*\.rail > \.account,\s*\.rail__theme\s*\{\s*display:\s*none/,
    );
    // More is a phone control: hidden outside the block, shown inside it.
    expect(css).toMatch(/\.rail__more\s*\{\s*display:\s*none;\s*\}/);
    expect(phone).toMatch(/\.rail__more\s*\{\s*display:\s*flex/);
  });

  it('opens the sheet with More, and closes it on navigation or Escape', async () => {
    await renderAt('/dashboard');
    // Wait for the shell to settle — the airline arriving re-renders it — and
    // re-read the rail at every step rather than holding an element a later
    // render may have replaced (CLAUDE.md's effect-race trap).
    await screen.findByText('Shell Air');
    const rail = () => screen.getByRole('navigation', { name: 'Main' });
    expect(within(rail()).getByRole('button', { name: 'More' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    fireEvent.click(within(rail()).getByRole('button', { name: 'More' }));
    expect(await within(rail()).findByRole('button', { name: 'Close' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(rail()).toHaveClass('rail--expanded');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(rail()).not.toHaveClass('rail--expanded');
    });

    fireEvent.click(within(rail()).getByRole('button', { name: 'More' }));
    expect(rail()).toHaveClass('rail--expanded');
    fireEvent.click(within(rail()).getByRole('link', { name: /Research/ }));
    await waitFor(() => {
      expect(rail()).not.toHaveClass('rail--expanded');
    });
  });

  it('drops an idle context panel from the phone layout, but never the office plan', async () => {
    const { unmount } = await renderAt('/dashboard');
    // Nothing selected and no office plan: one sentence, which a bottom sheet
    // spent ~180px on, on every page.
    expect(screen.getByRole('complementary', { name: 'Context' })).toHaveClass('panel--idle');
    expect(phone).toMatch(/\.panel--idle,\s*\.panel__reopen--idle\s*\{\s*display:\s*none/);
    unmount();

    await renderAt('/headquarters');
    expect(screen.getByRole('complementary', { name: 'Context' })).not.toHaveClass('panel--idle');
  });
});
