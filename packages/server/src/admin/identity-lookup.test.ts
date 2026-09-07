import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolvePlayerIdFromIdentities } from './identity-lookup';

/**
 * `admin-cli --email` refuses an address that names two accounts.
 *
 * The tests that can actually fail:
 *
 *   - **Two identities on two players is refused**, naming both player ids and
 *     the provider that pointed at each. This is the bug: `player_identity.email`
 *     is not unique, and once a second provider reports an address the address
 *     can name two accounts that AUTH-04 deliberately did not merge. Picking one
 *     grants or revokes admin on a coin toss, and says nothing about it.
 *   - **Two identities on *one* player proceeds**, because every candidate row
 *     names the same account. A guard that counted rows instead of players would
 *     refuse the ordinary case of one human with two sign-ins.
 *   - **The lookup in `admin-cli.ts` still reads every match.** The two cases
 *     above pass against a `limit(1)` query, because they never see the query --
 *     so a guard reads the source, which is where the ordering bug lives.
 *
 * No database: the decision is a pure function of the rows, and the source guard
 * covers the read that produces them.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('resolvePlayerIdFromIdentities', () => {
  it('resolves an address held by exactly one identity', () => {
    expect(resolvePlayerIdFromIdentities('a@b.c', [{ playerId: ALICE, provider: 'google' }])).toBe(
      ALICE,
    );
  });

  it('resolves an address held by two identities on the same player', () => {
    // One human, a Google sign-in and a Discord one, one account. Nothing to
    // guess: both rows name Alice.
    expect(
      resolvePlayerIdFromIdentities('a@b.c', [
        { playerId: ALICE, provider: 'google' },
        { playerId: ALICE, provider: 'discord' },
      ]),
    ).toBe(ALICE);
  });

  it('refuses an address held by two identities on different players', () => {
    const message = resolveMessage([
      { playerId: ALICE, provider: 'google' },
      { playerId: BOB, provider: 'discord' },
    ]);

    // Both candidates, each with the provider that matched, so the operator can
    // tell which account is which without a second query.
    expect(message).toContain(`${ALICE}  google`);
    expect(message).toContain(`${BOB}  discord`);
    expect(message).toContain('a@b.c');
    // The escape hatch, named. It already existed; the refusal is where an
    // operator finds out it is what they need.
    expect(message).toContain('--player <uuid>');
  });

  it('names the candidates in the order the rows arrived', () => {
    const forwards = resolveMessage([
      { playerId: ALICE, provider: 'google' },
      { playerId: BOB, provider: 'discord' },
    ]);
    const backwards = resolveMessage([
      { playerId: BOB, provider: 'discord' },
      { playerId: ALICE, provider: 'google' },
    ]);

    expect(forwards.indexOf(ALICE)).toBeLessThan(forwards.indexOf(BOB));
    expect(backwards.indexOf(BOB)).toBeLessThan(backwards.indexOf(ALICE));
  });

  it('lists a player once however many identities matched it', () => {
    const message = resolveMessage([
      { playerId: ALICE, provider: 'google' },
      { playerId: ALICE, provider: 'discord' },
      { playerId: BOB, provider: 'google' },
    ]);

    expect(message).toContain('matches 2 accounts');
    expect(message).toContain(`${ALICE}  google, discord`);
  });

  it('keeps the sign-in-first message when nothing matches', () => {
    expect(() => resolvePlayerIdFromIdentities('nobody@b.c', [])).toThrow(
      /No account with the sign-in address nobody@b\.c\..*sign in once/s,
    );
  });
});

function resolveMessage(matches: { playerId: string; provider: string }[]): string {
  try {
    resolvePlayerIdFromIdentities('a@b.c', matches);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a refusal');
}

const adminCliPath = fileURLToPath(new URL('../admin-cli.ts', import.meta.url));
const adminCli = readFileSync(adminCliPath, 'utf8');

/** The one `player_identity` read in `admin-cli.ts`, as source text. */
function emailLookupSource(): string {
  const emailAt = adminCli.indexOf('playerIdentity.email');
  const start = adminCli.lastIndexOf('await db.db', emailAt);
  const end = adminCli.indexOf(';', emailAt);
  return adminCli.slice(start, end);
}

describe("admin-cli's email lookup", () => {
  it('has exactly one place that matches on an address', () => {
    // A vacuous guard is worse than none, and a second lookup would be a second
    // chance to guess: the refusal only protects the read it is wired to.
    expect(adminCli.split('playerIdentity.email').length - 1).toBe(1);
    expect(emailLookupSource()).toContain('playerIdentity.email');
  });

  it('reads every match rather than an arbitrary first row', () => {
    const lookup = emailLookupSource();
    // `.limit(1)` with no `ORDER BY` is the bug: it resolves to whichever row
    // Postgres returned first, which is not a decision anybody made.
    expect(lookup).not.toContain('.limit(');
    expect(lookup).toContain('.orderBy(');
    expect(lookup).toContain('selectDistinct');
    // Without the provider the refusal cannot say which sign-in named which
    // candidate, which is the only thing that makes it actionable.
    expect(lookup).toContain('playerIdentity.provider');
  });

  it('hands the matches to the resolver rather than deciding inline', () => {
    expect(adminCli).toContain('resolvePlayerIdFromIdentities(');
  });
});
