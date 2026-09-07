import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Account policy has one implementation (AUTH-02).
 *
 * The module exists so that Discord's callback, the magic-link verifier and the
 * passkey registration cannot each decide whether to create a player, reuse one
 * or refuse. But a shared module nobody is obliged to use is a convention, and
 * the failure mode is silent: a provider that grows its own
 * `insert(player)`—because that is genuinely the shortest path in a callback—
 * looks fine, passes its own tests, and disagrees with the other three about
 * what a login means. The disagreement is an account takeover, not a bug
 * report.
 *
 * So this reads the server's own source and holds two lines:
 *
 * 1. **Nothing outside `identity.ts` creates a player as part of authenticating.**
 * 2. **Nothing outside `identity.ts` writes `player_identity`.**
 *
 * Modelled on `product-score-source.test.ts`, which fails the build if a third
 * `ProductScore` source appears, and for the same reason: the rule is about
 * where a decision lives, and the type system has nothing to say about that.
 */

const serverSrc = fileURLToPath(new URL('..', import.meta.url));

/** The module that owns the policy, relative to `packages/server/src`. */
const POLICY_MODULE = 'auth/identity.ts';

/**
 * Modules allowed to create a `player` row, with the reason.
 *
 * Player creation outside authentication is a different act — an operator
 * fixture, a seeded world — and the rule here is specifically about the
 * *authentication* path. Each entry says why it is not that.
 */
const ALLOWED_PLAYER_WRITERS: Record<string, string> = {
  [POLICY_MODULE]: 'Owns the policy. This is the one place a sign-in may create an account.',
  'e2e/prepare.ts':
    'Browser-test harness (E2E-03). Seeds three fixed-id fixture players into a ' +
    'disposable database — `assertDisposableDatabaseUrl` refuses any other — so the ' +
    'journeys can authenticate without a real Google account. Nothing here serves a ' +
    'request, so there is no sign-in for the policy to be bypassed by.',
};

/**
 * Modules allowed to write `player_identity`.
 *
 * Deliberately shorter than the list above: an identity row *is* the link
 * between a person and an account, so writing one is exercising the policy.
 */
const ALLOWED_IDENTITY_WRITERS: Record<string, string> = {
  [POLICY_MODULE]: 'Owns the policy.',
  'airline/anonymize-player.ts': 'GDPR erasure deletes them; it never creates or moves one.',
};

const SKIP_DIRECTORIES = new Set(['node_modules', 'test-fixtures', 'test-support']);

/** `insert(player)` / `.insert(player)`, however it is spelled. */
const CREATES_PLAYER = /\.insert\(\s*player\s*\)/;
/** Any write to the identity table: insert, update or delete. */
const WRITES_IDENTITY = /\.(?:insert|update|delete)\(\s*playerIdentity\s*\)/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) sourceFiles(join(dir, entry.name), found);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    found.push(join(dir, entry.name));
  }
  return found;
}

const files = sourceFiles(serverSrc).map((path) => ({
  path: path.slice(serverSrc.length).replace(/\\/g, '/'),
  source: readFileSync(path, 'utf8'),
}));

function offenders(pattern: RegExp, allowed: Record<string, string>): string[] {
  return files.filter((f) => pattern.test(f.source) && !(f.path in allowed)).map((f) => f.path);
}

describe('account policy has a single implementation', () => {
  it('scanned the server source and found the policy module', () => {
    // A vacuous guard is worse than none: if the walk breaks, or the module is
    // renamed without updating this list, fail here rather than report a clean
    // tree that was never read.
    expect(files.length).toBeGreaterThan(100);
    const policy = files.find((f) => f.path === POLICY_MODULE);
    expect(policy, `${POLICY_MODULE} not found — was it renamed?`).toBeDefined();
    // And prove the patterns match the thing they are meant to police, so a
    // typo in either regex cannot silently permit everything.
    expect(CREATES_PLAYER.test(policy!.source)).toBe(true);
    expect(WRITES_IDENTITY.test(policy!.source)).toBe(true);
  });

  it('creates a player nowhere else', () => {
    const found = offenders(CREATES_PLAYER, ALLOWED_PLAYER_WRITERS);
    expect(
      found,
      'These modules create a player row. Authentication must go through ' +
        `${POLICY_MODULE}'s signInWithIdentity so every provider applies the same ` +
        'ALLOW_REGISTRATION gate and the same conflict rules:\n  ' +
        found.join('\n  '),
    ).toEqual([]);
  });

  it('writes player_identity nowhere else', () => {
    const found = offenders(WRITES_IDENTITY, ALLOWED_IDENTITY_WRITERS);
    expect(
      found,
      'These modules write player_identity directly. An identity row is the link ' +
        `between a person and an account — go through ${POLICY_MODULE}:\n  ` +
        found.join('\n  '),
    ).toEqual([]);
  });

  it('holds no stale allowance', () => {
    const stale = [
      ...Object.keys(ALLOWED_PLAYER_WRITERS).filter((path) => {
        const file = files.find((f) => f.path === path);
        return !file || !CREATES_PLAYER.test(file.source);
      }),
      ...Object.keys(ALLOWED_IDENTITY_WRITERS).filter((path) => {
        const file = files.find((f) => f.path === path);
        return !file || !WRITES_IDENTITY.test(file.source);
      }),
    ];
    expect(
      stale,
      'These modules are exempted but no longer do the thing they were exempted ' +
        'for. Remove the entry, or it silently covers whatever they do next:\n  ' +
        stale.join('\n  '),
    ).toEqual([]);
  });
});
