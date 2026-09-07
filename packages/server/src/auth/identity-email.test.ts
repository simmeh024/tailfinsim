import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * An email address is never how an identity is found (AUTH-01, ADR-0004).
 *
 * `player_identity.email` is documented in `schema.ts` as informational only,
 * and AUTH-04 turns that into a rule with teeth: a provider reporting an
 * address some other account already uses changes **nothing at all**. The
 * reason is the oldest account-takeover bug there is — people change email
 * addresses, providers differ on whether they verify them, and an attacker who
 * can put a victim's address on a fresh account at any one provider inherits
 * the victim's airline the moment a lookup matches on it.
 *
 * With four providers arriving (AUTH-08 Discord, AUTH-10 magic link, AUTH-15
 * passkeys) that rule stops being something one careful callback observes and
 * becomes something four of them have to. A comment cannot enforce it, so this
 * reads the server's own source and fails on any **comparison** against that
 * column. Projections are deliberately still allowed: the admin console
 * discloses the address to a support operator, which is a different act from
 * resolving an account by it.
 *
 * Its blind spot, stated rather than pretended away: dynamically built SQL. The
 * guard is a grep, so `sql.raw(userSuppliedColumn)` would pass it. Nothing in
 * the tree does that, and `request-body-policy.test.ts` owns the boundary that
 * would let a client name a column at all.
 */

const serverSrc = fileURLToPath(new URL('..', import.meta.url));

/** Comparison helpers Drizzle exposes; any of them against `email` is a lookup. */
const DRIZZLE_COMPARISONS =
  '(?:eq|ne|gt|gte|lt|lte|like|ilike|notLike|notIlike|inArray|notInArray)';

const DRIZZLE_EMAIL_LOOKUP = new RegExp(
  `${DRIZZLE_COMPARISONS}\\s*\\(\\s*playerIdentity\\.email\\b`,
);

/** The same thing written as SQL, quoted or not. */
const RAW_SQL_EMAIL_LOOKUP =
  /player_identity"?\s*\.\s*"?email"?\s*(?:=|<>|!=|~~\*?|\bILIKE\b|\bLIKE\b|\bIN\b)/i;

/** Proves the scan actually reaches the code that resolves identities. */
const LEGITIMATE_SUBJECT_LOOKUP = new RegExp(
  `${DRIZZLE_COMPARISONS}\\s*\\(\\s*playerIdentity\\.subject\\b`,
);

const SKIP_DIRECTORIES = new Set(['node_modules', 'test-fixtures', 'test-support']);

/**
 * The places entitled to compare that column, each with the reason.
 *
 * An allowlist rather than a blanket exemption for a directory, because the
 * reason is what makes each one safe and a reason has to be written down to be
 * reviewable. Adding an entry here is a deliberate act in a diff, which is the
 * point.
 */
const ALLOWED_EMAIL_LOOKUPS: Record<string, string> = {
  'admin-cli.ts':
    'Bootstrap `admin grant --email`. This resolves an *operator argument* on the box, ' +
    'under a shell that operator already holds — it authenticates nobody, and it is how ' +
    'the first admin exists at all before any admin can grant one. The takeover ADR-0004 ' +
    'forbids needs an attacker who can present an address to a sign-in flow; there is no ' +
    'sign-in flow here.',
};

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
  path,
  source: readFileSync(path, 'utf8'),
}));

function relative(path: string): string {
  return path.slice(serverSrc.length).replace(/\\/g, '/');
}

describe('player_identity.email is informational, never a lookup key', () => {
  it('scanned the server source', () => {
    // A vacuous guard is worse than none. If the walk breaks, this fails here
    // rather than reporting a clean tree it never read.
    expect(files.length).toBeGreaterThan(100);
  });

  it('can see the identity resolution it is guarding', () => {
    // The companion anti-vacuity check: the rule is only meaningful if the scan
    // reaches whichever module resolves an identity. That module moves — it was
    // inline in `auth/routes.ts` and AUTH-02 lifts it into `auth/identity.ts` —
    // so this asserts the *pattern* is present somewhere rather than naming a file.
    const resolvers = files.filter((f) => LEGITIMATE_SUBJECT_LOOKUP.test(f.source));
    expect(
      resolvers.map((f) => relative(f.path)),
      'no module compares playerIdentity.subject — either identity resolution moved ' +
        'somewhere this scan cannot see, or it stopped keying on the provider subject',
    ).not.toEqual([]);
  });

  it('never compares playerIdentity.email through Drizzle', () => {
    const offenders = files
      .filter((f) => DRIZZLE_EMAIL_LOOKUP.test(f.source))
      .map((f) => relative(f.path))
      .filter((path) => !(path in ALLOWED_EMAIL_LOOKUPS));
    expect(
      offenders,
      'These modules look up an identity by email address, which ADR-0004 forbids:\n  ' +
        `${offenders.join('\n  ')}\n` +
        'Match on (provider, subject) instead. If a provider reports an address another ' +
        'account uses, AUTH-04 says do nothing about it. If the lookup authenticates ' +
        'nobody, add it to ALLOWED_EMAIL_LOOKUPS with the reason.',
    ).toEqual([]);
  });

  /**
   * An allowlist nobody prunes is a permission nobody remembers granting. If a
   * listed module stops comparing the column, the exemption must go with it —
   * otherwise it silently covers whatever that file does next.
   */
  it('holds no stale allowlist entry', () => {
    const stale = Object.keys(ALLOWED_EMAIL_LOOKUPS).filter((allowed) => {
      const file = files.find((f) => relative(f.path) === allowed);
      return !file || !DRIZZLE_EMAIL_LOOKUP.test(file.source);
    });
    expect(
      stale,
      'These files are exempted but no longer compare playerIdentity.email. ' +
        'Remove the entry:\n  ' +
        `${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('never compares player_identity.email in raw SQL', () => {
    const offenders = files
      .filter((f) => RAW_SQL_EMAIL_LOOKUP.test(f.source))
      .map((f) => relative(f.path));
    expect(
      offenders,
      'These modules compare player_identity.email in SQL:\n  ' + `${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
