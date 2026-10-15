import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeResponse } from '@tailfin/shared';

import { App } from '../App';

import { NAV_ITEMS } from './AppShell';
import {
  IN_SHELL_ROUTES,
  NOT_DESTINATIONS,
  OUT_OF_SHELL_ROUTES,
  type RouteReach,
} from './reachability';
import { titleFor } from './route-identity';

/**
 * The navigation says everything the app has (SURFACE-07).
 *
 * Three questions, each a way the next page could be forgotten:
 *
 *   1. **Is every route the router mounts in `reachability.ts`?** Read from
 *      `App.tsx`'s own route table, so a page added there without a way in fails
 *      here rather than in a player's bookmarks.
 *   2. **Is every entry still a route?** A stale entry claims a way into a page
 *      that no longer exists.
 *   3. **Does the declared way in actually render?** A rail item has to be in
 *      the rail, an account link in the account block, a page link on the page.
 *      A table that merely *said* `/c-suite` was reached from Headquarters would
 *      go on saying it after the button was deleted.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = resolve(HERE, '..', 'App.tsx');

interface MountedRoute {
  path: string;
  inShell: boolean;
}

/** A JSX attribute's string value, or null. */
function attribute(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): ts.JsxAttribute | null {
  for (const property of node.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText() === name) return property;
  }
  return null;
}

function stringAttribute(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): string | null {
  const found = attribute(node, name);
  const value = found?.initializer;
  if (value === undefined) return null;
  if (ts.isStringLiteral(value)) return value.text;
  return null;
}

/** Whether a `<Route element={...}>` renders the shell. */
function rendersShell(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  const element = attribute(node, 'element')?.initializer;
  return element !== undefined && /<AppShell\s*\/>/.test(element.getText());
}

function join(parent: string, child: string): string {
  if (child.startsWith('/') || child === '*') return child;
  if (parent === '' || parent === '/') return `/${child}`;
  return `${parent}/${child}`;
}

/** Every route `App.tsx` mounts, by full path, and whether it is inside the shell. */
function mountedRoutes(): MountedRoute[] {
  const source = ts.createSourceFile(
    APP_SOURCE,
    readFileSync(APP_SOURCE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: MountedRoute[] = [];

  const visit = (node: ts.Node, parent: string, inShell: boolean): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (opening.tagName.getText() === 'Route') {
        const path = stringAttribute(opening, 'path');
        const index = attribute(opening, 'index') !== null;
        const shell = inShell || rendersShell(opening);
        const full = index
          ? parent === ''
            ? '/'
            : parent
          : path === null
            ? parent
            : join(parent, path);
        if (path !== null || index) found.push({ path: full, inShell: inShell });
        if (ts.isJsxElement(node)) {
          for (const child of node.children) visit(child, full, shell);
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, parent, inShell);
    });
  };
  visit(source, '', false);

  // An index route under a layout repeats its parent's path.
  const unique = new Map<string, MountedRoute>();
  for (const route of found) unique.set(route.path, route);
  return [...unique.values()];
}

/* -- Rendering, for the declared ways in -------------------------------------- */

function signedIn(isAdmin: boolean): MeResponse {
  return {
    player: {
      id: '11111111-2222-3333-4444-555555555555',
      displayName: 'Reach Tester',
      avatarUrl: null,
      displayCurrency: 'USD',
      createdAt: '2026-08-17T09:00:00.000Z',
    },
    registrationOpen: false,
    signInProviders: [],
    isAdmin,
  };
}

function stubServer(isAdmin: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const body =
        url === '/api/me'
          ? signedIn(isAdmin)
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
                    playerId: '11111111-2222-3333-4444-555555555555',
                    name: 'Reach Air',
                    iataCode: 'RA',
                    icaoCode: 'RCH',
                    callsign: 'REACH',
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
              : url === '/api/version'
                ? {
                    version: '0.0.0',
                    build: 1,
                    commit: 'abcdef0',
                    environment: 'local',
                    startedAt: '2026-08-17T10:00:00.000Z',
                    serverTime: '2026-08-17T10:00:00.000Z',
                  }
                : {};
      // The console's pages read real shapes; refusing them keeps each page in
      // its broken state rather than crashing the layout whose links are asked about.
      if (url.startsWith('/api/admin/')) {
        return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

async function renderAt(path: string): Promise<void> {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('navigation', { name: 'Main' });
}

/**
 * A link to `href` somewhere inside `scope`, waited for.
 *
 * Waited for **by its href**, not for any link: the account block's "Manage
 * airline" appears once the airline has loaded, and the page links once the page
 * has, so the first links on screen are rarely the ones being asked about.
 */
async function findLinkTo(scope: () => HTMLElement, href: string): Promise<HTMLElement> {
  return waitFor(() => {
    const links = within(scope()).queryAllByRole('link');
    const match = links.find((link) => link.getAttribute('href') === href);
    if (match === undefined) {
      throw new Error(
        `No link to ${href}; found ${links.map((link) => link.getAttribute('href')).join(', ')}`,
      );
    }
    return match;
  });
}

beforeEach(() => {
  localStorage.clear();
  stubServer(false);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/* -- 1 and 2: the table and the router agree ---------------------------------- */

describe('the reachability table and the router', () => {
  const mounted = mountedRoutes();
  const inShell = mounted.filter((route) => route.inShell).map((route) => route.path);
  const outside = mounted.filter((route) => !route.inShell).map((route) => route.path);

  it('finds the router’s routes at all', () => {
    // Guards the guard: two empty sets agree perfectly.
    expect(inShell.length).toBeGreaterThan(15);
    expect(inShell).toContain('/fleet');
    expect(outside).toContain('/found');
  });

  it('gives every in-shell route a way in, or names it as no destination', () => {
    const missing = inShell.filter(
      (path) => IN_SHELL_ROUTES[path] === undefined && NOT_DESTINATIONS[path] === undefined,
    );
    expect(
      missing,
      'Add these to IN_SHELL_ROUTES in shell/reachability.ts with how a player reaches them, and why',
    ).toEqual([]);
  });

  it('gives every out-of-shell route a one-line reason', () => {
    const missing = outside.filter(
      (path) => OUT_OF_SHELL_ROUTES[path] === undefined && NOT_DESTINATIONS[path] === undefined,
    );
    expect(missing).toEqual([]);
    for (const [path, entry] of Object.entries(OUT_OF_SHELL_ROUTES)) {
      expect(entry.reason.length, path).toBeGreaterThan(10);
    }
  });

  it('names no route the router does not mount', () => {
    const all = new Set(mounted.map((route) => route.path));
    const stale = [
      ...Object.keys(IN_SHELL_ROUTES).filter((path) => !inShell.includes(path)),
      ...Object.entries(OUT_OF_SHELL_ROUTES)
        .filter(([path, entry]) => entry.notARoute !== true && !outside.includes(path))
        .map(([path]) => path),
      ...Object.keys(NOT_DESTINATIONS).filter((path) => !all.has(path)),
    ];
    expect(stale).toEqual([]);
    // And one that says it is not a route really is not one.
    for (const [path, entry] of Object.entries(OUT_OF_SHELL_ROUTES)) {
      if (entry.notARoute === true) expect(all.has(path), path).toBe(false);
    }
  });

  it('reaches a page only from somewhere that is itself reachable', () => {
    const origins = [
      ...Object.values(IN_SHELL_ROUTES).flatMap((reach) =>
        reach.means === 'page' || reach.means === 'record' ? [reach.from] : [],
      ),
      ...Object.values(OUT_OF_SHELL_ROUTES).flatMap((entry) =>
        entry.reachedFrom === null ? [] : [entry.reachedFrom],
      ),
    ];
    for (const origin of origins) expect(IN_SHELL_ROUTES[origin], origin).toBeDefined();
  });

  it('gives every destination a title, so a tab says which page it is (UX-04)', () => {
    for (const path of Object.keys(IN_SHELL_ROUTES)) {
      expect(titleFor(path.replaceAll(/:[^/]+/g, 'x')), path).not.toBe('Tailfin');
    }
  });
});

/* -- 3: the declared ways in exist ------------------------------------------- */

function entries(means: RouteReach['means']): [string, RouteReach][] {
  return Object.entries(IN_SHELL_ROUTES).filter(([, reach]) => reach.means === means);
}

describe('the declared ways in', () => {
  it('puts every rail destination in the rail', () => {
    const rail = new Set(NAV_ITEMS.map((item) => item.to));
    for (const [path] of entries('rail')) expect(rail.has(path), path).toBe(true);
    // And the rail has nothing the table does not account for.
    for (const item of NAV_ITEMS) expect(IN_SHELL_ROUTES[item.to]?.means, item.to).toBe('rail');
  });

  it.each(entries('account'))('reaches %s from the account block in the rail', async (path) => {
    await renderAt('/world');
    const rail = () => screen.getByRole('navigation', { name: 'Main' });
    expect(await findLinkTo(rail, path)).toBeInTheDocument();
  });

  it.each(entries('page'))('reaches %s from a link on another page', async (path, reach) => {
    if (reach.means !== 'page') throw new Error('unreachable');
    await renderAt(reach.from);
    expect(await findLinkTo(() => screen.getByRole('main'), path)).toBeInTheDocument();
  });

  it('reaches the admin console from the status strip, for an administrator only', async () => {
    const admin = entries('strip');
    expect(admin.map(([path]) => path)).toEqual(['/admin']);

    stubServer(true);
    await renderAt('/world');
    expect(await findLinkTo(() => screen.getByLabelText('Status'), '/admin')).toBeInTheDocument();
  });

  it('reaches every admin section from the console’s own navigation', async () => {
    stubServer(true);
    await renderAt('/admin');
    const sections = () => screen.getByRole('navigation', { name: 'Admin sections' });
    for (const [path] of entries('console')) {
      expect(await findLinkTo(sections, path)).toBeInTheDocument();
    }
  });

  it.each(Object.entries(OUT_OF_SHELL_ROUTES).filter(([, entry]) => entry.reachedFrom !== null))(
    'reaches %s, outside the shell, from the page that opens it',
    async (path, entry) => {
      await renderAt(entry.reachedFrom ?? '/world');
      expect(await findLinkTo(() => screen.getByRole('main'), path)).toBeInTheDocument();
    },
  );
});
