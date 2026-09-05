import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type DatabaseHandle } from '../db/client';
import { type EnvironmentLabel, type ServerEnv } from '../env';

import { CORS_PERMITTED_ORIGINS, resolveCorsOrigins } from './cors';

/**
 * Production is closed to cross-origin readers, and stays closed (SEC-HARD-08).
 *
 * `Access-Control-Allow-Origin` combined with a cookie session lets any website
 * read an authenticated response on a visitor's behalf — a signed-in player's
 * airline, an admin's world list. Tailfin has never had CORS, so there is
 * nothing to fix; what there was, until this file, is nothing that would *stop*
 * it being added.
 *
 * The pressure is real rather than hypothetical. The Vite dev server is a second
 * origin in local development, and the first person who points it at a remote
 * API will reach for `@fastify/cors` with `origin: true` — which reflects the
 * requesting origin, and with credentials is the worst configuration available
 * while reading like "on". Tailfin then runs the same build everywhere,
 * differing only by environment variables, so a setting added "just for dev" is
 * one variable from production.
 *
 * So three things are asserted: the responses carry no CORS headers, the
 * configuration surface cannot be pointed anywhere dangerous, and the plugin
 * that would make either possible is not in the tree.
 *
 * No database: none of this touches the pool, so it runs on every pull request.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const baseEnv: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: 'postgres://cors-policy-unused',
  databasePoolMax: 1,
  databaseConnectTimeoutMs: 1_000,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  publicOrigin: 'http://localhost:3000',
  googleClientId: 'cors.apps.googleusercontent.com',
  googleClientSecret: 'cors-secret',
  sessionSecret: 'k'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

/** A domain that ends in ours and is not ours. The whole reason matching is exact. */
const LOOKALIKE = 'https://tailfinsim.com.evil.example';

function refusalFor(raw: string, label: EnvironmentLabel): string {
  let message = '';
  try {
    resolveCorsOrigins(raw, label);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, `${label} accepted ${JSON.stringify(raw)}, which it must not`).not.toBe('');
  return message;
}

describe('what a production process can be told to trust', () => {
  it('trusts nothing cross-origin when the variable is unset', () => {
    // The shipped state on both hosts. Empty is not "permissive by omission";
    // it is the reason no `Access-Control-*` header exists to send.
    for (const label of ['production', 'dev', 'local'] as const) {
      expect(resolveCorsOrigins(undefined, label)).toEqual([]);
      expect(resolveCorsOrigins('', label)).toEqual([]);
      expect(resolveCorsOrigins('   ', label)).toEqual([]);
    }
  });

  it('refuses a wildcard in production, and says why rather than only that', () => {
    const message = refusalFor('*', 'production');
    expect(message).toMatch(/wildcard/i);
    // The consequence, not just the rule. Somebody reading this at 2am should
    // learn what would have happened, not only that it was disallowed.
    expect(message).toMatch(/read an authenticated response/i);
  });

  it('refuses every spelling of "reflect whatever asked"', () => {
    // `origin: true` is the trap this exists for, and it arrives written several
    // ways depending on what somebody copied.
    for (const value of ['*', 'true', 'all', 'any', 'null', 'TRUE', '*, https://tailfinsim.com']) {
      expect(refusalFor(value, 'production')).toMatch(/wildcard|reflecting/i);
    }
  });

  it('refuses a localhost origin in production', () => {
    // The "just for dev" setting, arriving on the live host. It is not rejected
    // by a localhost rule but by the allowlist: production may name its own
    // origin, so localhost is simply not one of the things it can be told.
    for (const value of ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'])
      expect(refusalFor(value, 'production')).toMatch(/may not trust/i);
  });

  it('refuses a lookalike domain, because the match is exact and not a suffix', () => {
    const message = refusalFor(LOOKALIKE, 'production');
    expect(message).toMatch(/may not trust/i);
    expect(message).toContain(LOOKALIKE);
    // A prefix or regular-expression match would have accepted this. Saying so
    // in the error is cheaper than the incident.
    expect(message).toMatch(/near miss/i);
  });

  it('refuses one environment being handed another environment’s origin', () => {
    // The same build runs everywhere. Dev's origin on production is a
    // configuration slip, not an attack, and it is caught the same way.
    expect(refusalFor('https://dev.tailfinsim.com', 'production')).toMatch(/may not trust/i);
    expect(refusalFor('https://tailfinsim.com', 'dev')).toMatch(/may not trust/i);
  });

  it('tells somebody with a legitimate need what to do instead', () => {
    /*
     * The value is permitted by the table and is *still* refused, because this
     * build registers no CORS plugin. Accepting it and doing nothing would leave
     * an operator staring at a header that never appears.
     *
     * This is the branch that separates "your value is wrong" from "this build
     * cannot do that", and the message has to carry the handover.
     */
    for (const [label, origins] of Object.entries(CORS_PERMITTED_ORIGINS)) {
      const message = refusalFor(origins[0]!, label as EnvironmentLabel);
      expect(message).toMatch(/registers no CORS plugin/i);
      expect(message).toMatch(/ADR-0025/);
      // The alternative that removes the need entirely.
      expect(message).toMatch(/vite/i);
      // And it confirms the value itself was fine, so nobody re-types it.
      expect(message).toContain(origins[0]!);
    }
  });

  it('permits each environment only its own origins', () => {
    // The table is the policy. Asserted so that widening it is a visible change
    // rather than a quiet edit inside a module nobody diffs.
    expect(CORS_PERMITTED_ORIGINS.production).toEqual(['https://tailfinsim.com']);
    expect(CORS_PERMITTED_ORIGINS.dev).toEqual(['https://dev.tailfinsim.com']);
    expect(CORS_PERMITTED_ORIGINS.local).toEqual([
      'http://localhost:5173',
      'http://localhost:3000',
    ]);

    // Production's list holds nothing that is not https and nothing local.
    for (const origin of CORS_PERMITTED_ORIGINS.production) {
      expect(origin.startsWith('https://')).toBe(true);
      expect(origin).not.toMatch(/localhost|127\.0\.0\.1/);
    }
  });
});

describe('what a production process actually answers', () => {
  /** A handle whose query surface throws: registering routes must not touch the pool. */
  const stubDatabase = {
    db: new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`CORS test queried the database (\`${String(property)}\`)`);
        },
      },
    ),
    pool: {},
    close: () => Promise.resolve(),
  } as unknown as DatabaseHandle;

  it('returns no Access-Control-Allow-Origin for a cross-origin GET /api/me', async () => {
    /*
     * The acceptance criterion, in a production-like configuration.
     *
     * `/api/me` by name because it is the one unauthenticated-looking endpoint
     * that answers differently once a session exists — exactly the response a
     * hostile page would want to read, and the first one anybody would try.
     */
    const app = await buildApp({
      env: { ...baseEnv, environmentLabel: 'production', publicOrigin: 'https://tailfinsim.com' },
      db: stubDatabase,
    });
    await app.ready();

    try {
      for (const origin of [LOOKALIKE, 'https://tailfinsim.com', 'null']) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { origin },
        });

        const cors = Object.keys(response.headers).filter((name) =>
          name.toLowerCase().startsWith('access-control-'),
        );
        expect(
          cors,
          `/api/me answered Origin: ${origin} with ${cors.join(', ')}. A cookie session plus a ` +
            'CORS header means any page can read this response.',
        ).toEqual([]);
      }
    } finally {
      await app.close();
    }
  });
});

describe('the plugin that would make it possible is not in the tree', () => {
  /**
   * The guard that actually stops the careless change.
   *
   * Everything above tests a configuration surface. This tests that the surface
   * is the *only* route — because `app.register(fastifyCors, { origin: true })`
   * is one line, needs no environment variable, and would pass every other
   * assertion in this file by making them irrelevant.
   *
   * Reading the manifests rather than trying to import: a dependency that is
   * declared but unused is still a dependency somebody will reach for, and this
   * is meant to fail at the moment it is added rather than at the moment it is
   * wired up.
   */
  const MANIFESTS = [
    'package.json',
    'packages/server/package.json',
    'packages/web/package.json',
    'packages/shared/package.json',
    'packages/sim/package.json',
    'packages/assets/package.json',
  ];

  const CORS_PACKAGES = ['@fastify/cors', 'cors', 'fastify-cors'];

  it('declares no CORS middleware in any workspace manifest', () => {
    for (const manifest of MANIFESTS) {
      const parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, manifest), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies });
      const found = declared.filter((name) => CORS_PACKAGES.includes(name));

      expect(
        found,
        `${manifest} declares ${found.join(', ')}. ADR-0025 treats the absence of CORS as one of ` +
          'the four facts that replace a CSRF token, and `origin: true` reflects the requesting ' +
          'origin — with credentials, the worst configuration available. If cross-origin access ' +
          'is genuinely needed, use the allowlist in security/cors.ts and amend ADR-0025 in the ' +
          'same change. See SEC-HARD-08.',
      ).toEqual([]);
    }
  });

  it('has no CORS middleware anywhere in the resolved dependency tree', () => {
    // The manifests are the deliberate route; the lockfile is the accidental
    // one. A transitive `cors` that a plugin decided to register on our behalf
    // would be invisible to the check above.
    const lockfile = readFileSync(resolve(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    for (const name of CORS_PACKAGES) {
      expect(
        lockfile.includes(`\n  ${name}@`),
        `${name} appears in pnpm-lock.yaml. See SEC-HARD-08 and ADR-0025 before adding it.`,
      ).toBe(false);
    }
  });
});
