import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../app';

import type { DatabaseHandle } from '../db/client';
import type { ServerEnv } from '../env';

/**
 * The two lists SEC-04 exists to compare: what the router registered, and what
 * `docs/authorization-matrix.md` says is allowed to exist.
 *
 * The matrix is the *intended* boundary, written from the design rather than
 * read back off whichever hook a route currently carries. That only means
 * anything if a route cannot be added without a row — otherwise the document is
 * a description that drifts, and the drift is invisible exactly when it matters.
 * So the comparison runs both ways: a route with no row fails, and a row with no
 * route fails too, because a stale row claims a boundary nobody is enforcing.
 *
 * CONTRIBUTING.md is explicit that this must not become documentation generated
 * from the router. Generated expectations cannot catch a missing guard: they
 * would simply describe it. The document is written by hand, on purpose, and
 * this only checks that the two sets of *routes* agree.
 *
 * Neither half needs a database, which is deliberate. Route registration does
 * not touch the pool, so this gate runs on every pull request rather than only
 * where `DATABASE_URL` happens to be set — and a missing row is the failure most
 * likely to arrive from someone who never ran the database suites.
 */

/** `METHOD /path`, the shape both sides are compared in. */
export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

export interface RegisteredRoute {
  method: string;
  url: string;
  key: string;
}

export interface MatrixRow {
  method: string;
  url: string;
  key: string;
  mechanism: string;
  guest: string;
  player: string;
  owner: string;
  admin: string;
}

/**
 * Methods the matrix deliberately does not carry a row for.
 *
 * Fastify synthesises a `HEAD` for every `GET` (`exposeHeadRoutes`), so listing
 * them would double the table with rows nobody wrote and nobody maintains; the
 * `GET` row is the boundary, and `HEAD` cannot reach a different one because it
 * is the same handler. `OPTIONS` is not registered here at all and is listed so
 * that adding CORS later fails this rather than silently widening the surface.
 */
const DERIVED_METHODS = new Set(['HEAD', 'OPTIONS']);

/**
 * Environment for the enumeration build.
 *
 * `webSurface: 'holding'` on purpose. Under `app` the static plugin registers a
 * wildcard and the SPA fallback answers unmatched GETs, and neither is an
 * explicit API route registration — the matrix records both in its own section,
 * outside the compared markers, for exactly that reason.
 */
const ENUMERATION_ENV: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: 'postgres://route-inventory-unused',
  databasePoolMax: 1,
  databaseConnectTimeoutMs: 1_000,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  publicOrigin: 'http://localhost:3000',
  googleClientId: 'route-inventory.apps.googleusercontent.com',
  googleClientSecret: 'route-inventory-secret',
  sessionSecret: 'r'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

/**
 * Every route the app registers, from Fastify itself.
 *
 * The database handle is a stub and never used: registering a route closes over
 * the handle without calling it, so this needs no connection. If that ever stops
 * being true this throws on a missing method rather than quietly connecting
 * somewhere, which is the failure worth having.
 */
export async function collectRegisteredRoutes(): Promise<RegisteredRoute[]> {
  const routes: RegisteredRoute[] = [];
  /*
   * A handle whose *query* surface throws.
   *
   * Registration is allowed to read `db` and hand it to a route registrar —
   * that is all `buildApp` does with it, and a provider built at registration
   * legitimately closes over it. What must never happen is a query, because
   * then this gate would need a live database and would stop running on pull
   * requests that have none. So the trap is one level in: reading the handle is
   * fine, calling anything on the Drizzle instance is not.
   */
  const queryTrap = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `Route enumeration queried the database (\`${String(property)}\`); registering a route must not touch the pool`,
        );
      },
    },
  );
  const stubDatabase = {
    db: queryTrap,
    pool: {},
    // Nothing to close: this handle never opened a connection.
    close: () => Promise.resolve(),
  } as unknown as DatabaseHandle;

  const app = buildApp({
    env: ENUMERATION_ENV,
    db: stubDatabase,
    onRoute: ({ method, url }) => {
      for (const one of Array.isArray(method) ? method : [method]) {
        if (DERIVED_METHODS.has(one.toUpperCase())) continue;
        routes.push({ method: one.toUpperCase(), url, key: routeKey(one, url) });
      }
    },
  });

  try {
    await app.ready();
  } finally {
    await app.close();
  }

  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

const MATRIX_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'docs',
  'authorization-matrix.md',
);

const START_MARKER = '<!-- AUTHORIZATION_MATRIX_START -->';
const END_MARKER = '<!-- AUTHORIZATION_MATRIX_END -->';

/**
 * The route rows of `docs/authorization-matrix.md`.
 *
 * Bounded by the two HTML comments rather than by "the first table in the file",
 * because the document has other tables — the static surface and the worker
 * routes — and they are outside the markers on purpose. Reading them as route
 * registrations would demand rows for things that are not registrations.
 */
export function readAuthorizationMatrix(): MatrixRow[] {
  const document = readFileSync(MATRIX_PATH, 'utf8');
  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (start < 0 || end < 0) {
    throw new Error(`${MATRIX_PATH} is missing its ${START_MARKER} / ${END_MARKER} markers`);
  }

  const rows: MatrixRow[] = [];
  for (const line of document.slice(start + START_MARKER.length, end).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    // The header and its `| --- |` underline.
    if (cells[0] === 'Route' || /^-+$/.test(cells[0] ?? '')) continue;

    const route = /^`([A-Z]+)\s+(\S+)`$/.exec(cells[0] ?? '');
    if (!route) {
      throw new Error(
        `Unreadable authorization matrix route cell: ${cells[0] ?? '<empty>'}. Expected \`METHOD /path\`.`,
      );
    }
    rows.push({
      method: route[1]!,
      url: route[2]!,
      key: routeKey(route[1]!, route[2]!),
      mechanism: cells[1] ?? '',
      guest: cells[2] ?? '',
      player: cells[3] ?? '',
      owner: cells[4] ?? '',
      admin: cells[5] ?? '',
    });
  }

  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/** Admin API routes, which are the ones SEC-04 is really about. */
export function isAdminRoute(url: string): boolean {
  return url.startsWith('/api/admin/');
}
