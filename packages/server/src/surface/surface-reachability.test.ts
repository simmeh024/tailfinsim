import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readAuthorizationMatrix, type MatrixRow } from '../test-fixtures/route-inventory';
import {
  judgeSurfaces,
  liveClientCalls,
  renderSurfaceInventory,
  routesReached,
  surfaceInventory,
  type InventoryRow,
  type SurfaceLists,
} from '../test-fixtures/surface-inventory';

import { ADMIN_BASELINE, NOT_A_SURFACE, SURFACE_BASELINE } from './surface-allowlist';

/**
 * Every player route has a consumer, or a filed reason it does not (SURFACE-01).
 *
 * Five shipped subsystems had no player surface when this was written — the
 * maintenance and ground endpoints among them — and nothing noticed, because a
 * closed UI issue is not evidence a player can reach a feature. A consumer in
 * the client is. So this is the entry-point assertion CI already makes for
 * `dist`, applied to surfaces: **a player route nothing in the client calls fails
 * the build**, unless `surface-allowlist.ts` names it with a reason and an issue.
 *
 * ## The noise budget
 *
 * A gate that failed on every pre-existing gap would fail every pull request
 * equally and be disabled — the failure Dependency Review avoids by scoring what
 * the diff added. So today's gaps are baselined, each with the issue that will
 * close it, and the gate fails only on a **new** orphan. And it fails on a
 * **stale** baseline entry too: a baselined route that has gained a consumer must
 * be removed from the baseline in the same pull request, so the list shrinks as
 * the surfaces land rather than being trimmed by memory.
 *
 * ## Where it runs
 *
 * In the ordinary server suite, in CI's `Tests` job, needing no database — the
 * same home as the SEC-04 matrix gate it joins on. Promoting it to a check of its
 * own is the CI Safety Net Expansion milestone's (#33) call; the technique and the
 * inventory are this issue's.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INVENTORY_DOC = resolve(HERE, '..', '..', '..', '..', 'docs', 'surface-inventory.md');

const LISTS: SurfaceLists = {
  notASurface: NOT_A_SURFACE,
  baseline: SURFACE_BASELINE,
  adminBaseline: ADMIN_BASELINE,
};

/* -- The guard tests itself ---------------------------------------------------- */

function route(key: string): MatrixRow {
  const [method = 'GET', url = '/'] = key.split(' ');
  return { method, url, key, mechanism: '', guest: '', player: '', owner: '', admin: '' };
}

describe('the guard, against a client it was written for', () => {
  let root: string;

  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'surface-fixture-'));
    write('main.ts', "import { Page } from './page';\nPage();\n");
    write(
      'page.ts',
      [
        "import { readUsed, signIn } from './api';",
        "import { deleteThing, readEither, readFallback } from './api';",
        'export function Page() {',
        '  void readUsed();',
        '  void deleteThing("x");',
        '  void readEither(30);',
        '  void readFallback();',
        '  return signIn("google");',
        '}',
        '',
      ].join('\n'),
    );
    write(
      'api.ts',
      [
        '// A comment that mentions /api/commented is not a consumer.',
        "export function readUsed() { return fetch('/api/used'); }",
        "export function readUnused() { return fetch('/api/unused'); }",
        'export function deleteThing(id: string) {',
        "  return fetch(`/api/things/${id}`, { method: 'DELETE' });",
        '}',
        'export function signIn(provider: string) { return `/api/auth/${provider}`; }',
        '// Either arm of a conditional, and a fallback, are what the call sends.',
        'function shaped(url: string) { return fetch(url); }',
        'export function readEither(days?: number) {',
        "  return shaped(days === undefined ? '/api/either' : `/api/either?days=${days}`);",
        '}',
        "export function readFallback(url?: string) { return fetch(url ?? '/api/fallback'); }",
        'export function drill(endpoint: string) {',
        '  switch (endpoint) {',
        "    case '/api/case-label': return 1;",
        '  }',
        "  return endpoint.startsWith('/api/compared') ? 2 : 3;",
        '}',
        '',
      ].join('\n'),
    );
    // Calls a route, and nothing imports it.
    write('dead.ts', "export function readDead() { return fetch('/api/dead'); }\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ROUTES = [
    'GET /api/used',
    'GET /api/either',
    'GET /api/fallback',
    'GET /api/unused',
    'GET /api/dead',
    'GET /api/commented',
    'GET /api/case-label',
    'GET /api/compared',
    'DELETE /api/things/:id',
    'GET /api/things/:id',
    'GET /api/auth/google',
    'GET /api/auth/google/callback',
  ].map(route);

  const inventory = (): InventoryRow[] =>
    surfaceInventory(ROUTES, liveClientCalls(root, 'main.ts'));

  it('counts a route a reachable page calls, and fails one nothing calls', () => {
    const rows = inventory();
    const consumed = rows.filter((row) => row.consumers.length > 0).map((row) => row.key);
    expect(consumed.sort()).toEqual([
      'DELETE /api/things/:id',
      'GET /api/auth/google',
      'GET /api/either',
      'GET /api/fallback',
      'GET /api/used',
    ]);
    // A fixture route with no consumer fails the check; one with a consumer passes.
    const verdict = judgeSurfaces(rows, { notASurface: [], baseline: [], adminBaseline: [] });
    expect(verdict.orphans).toContain('GET /api/unused');
    expect(verdict.orphans).not.toContain('GET /api/used');
  });

  it('is not fooled by a comment, a case label, a comparison, an unused export or a dead module', () => {
    const consumed = new Set(
      inventory()
        .filter((row) => row.consumers.length > 0)
        .map((row) => row.key),
    );
    for (const key of [
      'GET /api/commented',
      'GET /api/case-label',
      'GET /api/compared',
      'GET /api/unused',
      'GET /api/dead',
    ]) {
      expect(consumed.has(key), key).toBe(false);
    }
  });

  it('reads the method a call is sent with', () => {
    const rows = inventory();
    expect(rows.find((row) => row.key === 'DELETE /api/things/:id')?.consumers).toEqual([
      'api.ts#deleteThing',
    ]);
    expect(rows.find((row) => row.key === 'GET /api/things/:id')?.consumers).toEqual([]);
  });

  it('accepts an orphan only with a reason and an issue, and flags one that has gone stale', () => {
    const rows = inventory();
    const explained = judgeSurfaces(rows, {
      notASurface: [
        {
          route: 'GET /api/auth/google/callback',
          issue: 11,
          reason: 'A provider redirect target.',
        },
      ],
      baseline: [
        { route: 'GET /api/unused', issue: 1, reason: 'Ahead of its surface, consumed by #1.' },
        { route: 'GET /api/dead', issue: 2, reason: 'Ahead of its surface, consumed by #2.' },
        { route: 'GET /api/commented', issue: 3, reason: 'Ahead of its surface, consumed by #3.' },
        { route: 'GET /api/case-label', issue: 4, reason: 'Ahead of its surface, consumed by #4.' },
        { route: 'GET /api/compared', issue: 5, reason: 'Ahead of its surface, consumed by #5.' },
        { route: 'GET /api/things/:id', issue: 6, reason: 'Ahead of its surface, consumed by #6.' },
        // Consumed now: the baseline must lose it.
        { route: 'GET /api/used', issue: 7, reason: 'Ahead of its surface, consumed by #7.' },
        { route: 'GET /api/nowhere', issue: 8, reason: 'A route the matrix does not have.' },
        { route: 'GET /api/things/:id', issue: 0, reason: 'short' },
      ],
      adminBaseline: [],
    });
    expect(explained.orphans).toEqual([]);
    expect(explained.stale).toEqual(['GET /api/used']);
    expect(explained.unknown).toEqual(['GET /api/nowhere']);
    expect(explained.unexplained).toEqual(['GET /api/things/:id']);
  });

  it('matches an interpolation to a parameter before it stands for a literal', () => {
    const routes = ['GET /api/ground/:icao', 'GET /api/ground/contracts'].map(route);
    expect(routesReached('/api/ground/:', routes).map((row) => row.key)).toEqual([
      'GET /api/ground/:icao',
    ]);
    expect(routesReached('/api/ground/contracts', routes).map((row) => row.key)).toEqual([
      'GET /api/ground/contracts',
    ]);
  });
});

/* -- The guard, against the real client ----------------------------------------- */

describe('the player routes and the client that calls them', () => {
  let rows: InventoryRow[];

  beforeAll(() => {
    rows = surfaceInventory(readAuthorizationMatrix(), liveClientCalls());
  }, 120_000);

  it('reads a real inventory at all', () => {
    // Guards the guard: an empty client or an empty matrix agrees with anything.
    expect(rows.filter((row) => row.audience === 'player').length).toBeGreaterThan(80);
    expect(rows.filter((row) => row.consumers.length > 0).length).toBeGreaterThan(80);
    // The two SURFACE-04 and SURFACE-05 built, by name.
    expect(rows.find((row) => row.key === 'POST /api/fleet/maintenance/checks')?.consumers).toEqual(
      ['fleet/api.ts#bookMaintenanceCheck'],
    );
    expect(rows.find((row) => row.key === 'GET /api/ground/:icao')?.consumers).toEqual([
      'network/ground-api.ts#fetchGroundStation',
    ]);
  });

  it('has no player route that nothing calls and nothing explains', () => {
    const verdict = judgeSurfaces(rows, LISTS);
    expect(
      verdict.orphans,
      'These player routes have no client consumer. Build the surface, or add the route to ' +
        'SURFACE_BASELINE in packages/server/src/surface/surface-allowlist.ts with the issue that ' +
        'will consume it and a one-line reason:\n  ' +
        verdict.orphans.join('\n  '),
    ).toEqual([]);
  });

  it('has no baselined route that has since gained a consumer', () => {
    const verdict = judgeSurfaces(rows, LISTS);
    expect(
      verdict.stale,
      'These routes are allowlisted or baselined in surface-allowlist.ts but now have a consumer. ' +
        'Remove them from the list in the same pull request:\n  ' +
        verdict.stale.join('\n  '),
    ).toEqual([]);
  });

  it('names exactly the routes nothing calls — no more and no fewer', () => {
    // The issue's own test: a guard that reports one gap too many is as wrong as
    // one that reports one too few. Every unconsumed player route is in a list,
    // and every list entry is an unconsumed route.
    const unconsumed = rows
      .filter((row) => row.audience === 'player' && row.consumers.length === 0)
      .map((row) => row.key)
      .sort();
    const listed = [...NOT_A_SURFACE, ...SURFACE_BASELINE].map((entry) => entry.route).sort();
    expect(unconsumed).toEqual(listed);
  });

  it('allowlists only routes the matrix has, each with a reason and an issue', () => {
    const verdict = judgeSurfaces(rows, LISTS);
    expect(verdict.unknown).toEqual([]);
    expect(verdict.unexplained).toEqual([]);
    const all = [...NOT_A_SURFACE, ...SURFACE_BASELINE, ...ADMIN_BASELINE].map((e) => e.route);
    expect(new Set(all).size, 'a route listed twice').toBe(all.length);
  });

  it('scores the admin console apart, with its own baseline', () => {
    const verdict = judgeSurfaces(rows, LISTS);
    expect(
      verdict.adminOrphans,
      'These admin routes have no console control. Add the control, or add the route to ' +
        'ADMIN_BASELINE with its M11 issue and a reason:\n  ' +
        verdict.adminOrphans.join('\n  '),
    ).toEqual([]);
    for (const entry of ADMIN_BASELINE)
      expect(entry.route.includes(' /api/admin/'), entry.route).toBe(true);
    for (const entry of [...NOT_A_SURFACE, ...SURFACE_BASELINE]) {
      expect(entry.route.includes(' /api/admin/'), entry.route).toBe(false);
    }
  });

  it('keeps docs/surface-inventory.md current — it is generated, never written by hand', async () => {
    const options = (await prettier.resolveConfig(INVENTORY_DOC)) ?? {};
    const generated = await prettier.format(renderSurfaceInventory(rows, LISTS), {
      ...options,
      filepath: INVENTORY_DOC,
    });
    if (process.env.SURFACE_INVENTORY_WRITE === '1') writeFileSync(INVENTORY_DOC, generated);
    expect(
      readFileSync(INVENTORY_DOC, 'utf8'),
      'docs/surface-inventory.md is out of date. Regenerate it with ' +
        '`SURFACE_INVENTORY_WRITE=1 npx vitest run --project server surface-reachability`.',
    ).toBe(generated);
  });
});
