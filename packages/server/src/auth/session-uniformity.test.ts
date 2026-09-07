import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { player, playerIdentity, session, type AuthProviderName } from '../db/schema';

import { linkIdentity } from './identity';
import {
  createSession,
  destroyPlayerSessions,
  destroySession,
  findSessionPlayer,
  replaceSession,
} from './session';

/**
 * Four ways in, one kind of session (AUTH-05).
 *
 * **The target state is the current state**, which is why this file is almost
 * entirely tests and adds no production code. `createSession` takes a player id
 * and a TTL and nothing else; the `session` table has no provider column; and
 * ADR-0015's lifetimes, rotation and revocation are decided per *player kind*,
 * never per provider.
 *
 * This exists because that will be under pressure. Passkeys in particular
 * invite the argument that a stronger authentication deserves a longer session,
 * and it is a reasonable-sounding argument that would quietly create two
 * session models — after which the security of an account is set by whichever
 * model is weakest. If that decision is ever made it should be made in an ADR
 * and this file should fail loudly first.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [auth/session-uniformity.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const ALL_PROVIDERS: readonly AuthProviderName[] = ['google', 'discord', 'email', 'passkey'];

const TTL_HOURS = 24;

let subjectCounter = 0;
function nextSubject(): string {
  subjectCounter += 1;
  return `session-uniformity-${String(subjectCounter)}-${String(Date.now())}`;
}

describeDb('a session is the same thing however it was obtained', () => {
  let db: DatabaseHandle;
  const madePlayers: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    const ids = madePlayers.splice(0);
    if (ids.length > 0) await db.db.delete(player).where(inArray(player.id, ids));
  });

  afterAll(async () => {
    await db.close();
  });

  /** A player whose only way in is `provider`. */
  async function playerWithIdentity(provider: AuthProviderName): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `Via ${provider}` })
      .returning({ id: player.id });
    const id = rows[0]!.id;
    madePlayers.push(id);

    const linked = await linkIdentity(db.db, id, {
      provider,
      subject: nextSubject(),
      email: null,
      displayName: null,
      avatarUrl: null,
    });
    if (!linked.ok) throw new Error(`could not link a ${provider} identity`);
    return id;
  }

  describe.each(ALL_PROVIDERS)('a player who signed in with %s', (provider) => {
    it('gets a session that resolves back to them', async () => {
      const playerId = await playerWithIdentity(provider);
      const { token } = await createSession(db.db, playerId, TTL_HOURS);

      const resolved = await findSessionPlayer(db.db, token);
      expect(resolved?.id).toBe(playerId);
    });

    it('gets the same TTL as every other provider', async () => {
      const playerId = await playerWithIdentity(provider);
      const { expiresAt } = await createSession(db.db, playerId, TTL_HOURS);

      // Not "roughly a day" — the same arithmetic on the same argument. A
      // provider-specific TTL would show up here as a different number, which
      // is the whole point of asserting it per provider.
      const hours = (expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(TTL_HOURS - 0.05);
      expect(hours).toBeLessThanOrEqual(TTL_HOURS);
    });

    it('stores only a hash, never the token', async () => {
      const playerId = await playerWithIdentity(provider);
      const { token } = await createSession(db.db, playerId, TTL_HOURS);

      const rows = await db.db
        .select({ tokenHash: session.tokenHash })
        .from(session)
        .where(eq(session.playerId, playerId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).not.toBe(token);
      expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is rejected after logout', async () => {
      const playerId = await playerWithIdentity(provider);
      const { token } = await createSession(db.db, playerId, TTL_HOURS);

      await destroySession(db.db, token);
      // Server-side invalidation, not merely a cleared cookie: a copied token
      // has to stop working too, whichever provider minted it.
      expect(await findSessionPlayer(db.db, token)).toBeNull();
    });

    it('is rejected after expiry', async () => {
      const playerId = await playerWithIdentity(provider);
      const { token } = await createSession(db.db, playerId, TTL_HOURS);

      // Expire it in the database rather than waiting: expiry is enforced
      // inside the lookup query, so moving the row is a faithful test of the
      // thing that actually guards the request path.
      //
      // **Both** timestamps move. `session_expires_after_creation` requires
      // `expires_at > created_at`, so backdating the expiry alone is refused by
      // the database — and refused behind Drizzle's `Failed query: …` wrapper,
      // which names the statement and not the constraint. A session that
      // expired an hour after it was created, two hours ago, is also a more
      // honest fixture than one that expired before it existed.
      const createdAt = new Date(Date.now() - 2 * 3_600_000);
      await db.db
        .update(session)
        .set({ createdAt, expiresAt: new Date(createdAt.getTime() + 3_600_000) })
        .where(eq(session.playerId, playerId));

      expect(await findSessionPlayer(db.db, token)).toBeNull();
    });

    it('is rejected after every session for the player is revoked', async () => {
      const playerId = await playerWithIdentity(provider);
      const first = await createSession(db.db, playerId, TTL_HOURS);
      const second = await createSession(db.db, playerId, TTL_HOURS);

      const destroyed = await destroyPlayerSessions(db.db, playerId);
      expect(destroyed).toBe(2);
      expect(await findSessionPlayer(db.db, first.token)).toBeNull();
      expect(await findSessionPlayer(db.db, second.token)).toBeNull();
    });

    it('rotates the pre-login token instead of keeping it', async () => {
      const playerId = await playerWithIdentity(provider);
      const before = await createSession(db.db, playerId, TTL_HOURS);

      const after = await replaceSession(db.db, before.token, playerId, TTL_HOURS);

      // Session fixation: a browser-controlled token must not survive
      // authentication, for every provider and not just the one that had a
      // test when it was written.
      expect(after.token).not.toBe(before.token);
      expect(await findSessionPlayer(db.db, before.token)).toBeNull();
      expect((await findSessionPlayer(db.db, after.token))?.id).toBe(playerId);
    });
  });

  /**
   * Unlinking the identity a session came from does not end the session.
   *
   * AUTH-05 asks for this to be *decided* rather than to drift, so: it is
   * decided here as no. A session belongs to the `player`, not to the identity
   * that minted it — there is no `created_via_identity_id`, deliberately — and
   * revocation is already available and explicit through `logout-all` and the
   * admin action. Ending sessions as a side effect of a change on the account
   * page would be a surprising second meaning for a button that says
   * "disconnect".
   */
  it('leaves sessions alone when an identity is unlinked', async () => {
    const playerId = await playerWithIdentity('google');
    const second = await linkIdentity(db.db, playerId, {
      provider: 'discord',
      subject: nextSubject(),
      email: null,
      displayName: null,
      avatarUrl: null,
    });
    if (!second.ok) throw new Error('could not link the second identity');

    const { token } = await createSession(db.db, playerId, TTL_HOURS);
    await db.db.delete(playerIdentity).where(eq(playerIdentity.id, second.value.identityId));

    expect((await findSessionPlayer(db.db, token))?.id).toBe(playerId);
  });
});

/**
 * The structural half, which needs no database.
 *
 * A parameterised test proves the four providers behave alike *today*. These
 * two prove there is nowhere for them to stop behaving alike: no provider
 * column to branch on, and no provider mentioned in the session modules at all.
 */
describe('the session path cannot see which provider was used', () => {
  const sessionSource = readFileSync(
    fileURLToPath(new URL('./session.ts', import.meta.url)),
    'utf8',
  );
  const revocationSource = readFileSync(
    fileURLToPath(new URL('./revocation.ts', import.meta.url)),
    'utf8',
  );
  const schemaSource = readFileSync(
    fileURLToPath(new URL('../db/schema.ts', import.meta.url)),
    'utf8',
  );

  it('never names a provider in the session modules', () => {
    // Not a style rule. A provider name appearing in these files means a branch
    // on how somebody signed in, which is the fork AUTH-05 exists to prevent.
    for (const [name, source] of [
      ['session.ts', sessionSource],
      ['revocation.ts', revocationSource],
    ] as const) {
      for (const provider of ALL_PROVIDERS) {
        expect(
          new RegExp(`['"\`]${provider}['"\`]`).test(source),
          `${name} mentions the ${provider} provider — session behaviour must not depend on it. ` +
            'If this is a deliberate fork, ADR-0015 has to say so first.',
        ).toBe(false);
      }
      expect(/\bplayerIdentity\b/.test(source), `${name} reads player_identity`).toBe(false);
    }
  });

  it('gives the session table no provider column', () => {
    const table = /export const session = pgTable\(([\s\S]*?)\n\);/.exec(schemaSource);
    expect(table, 'could not find the session table — was it renamed?').not.toBeNull();

    const body = table![1]!;
    // Anti-vacuity: prove the extracted block is the real table before
    // concluding anything from its contents.
    expect(body).toContain("text('token_hash')");
    expect(body).toContain("timestamp('expires_at'");

    expect(
      /provider/i.test(body),
      'the session table gained a provider column. A session belongs to a player, not to the ' +
        'identity that minted it (AUTH-05). If this is `created_via_identity_id`, it must be ' +
        'informational and nothing may branch on it.',
    ).toBe(false);
  });
});
