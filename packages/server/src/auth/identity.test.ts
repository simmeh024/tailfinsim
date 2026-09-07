import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { player, playerIdentity, type AuthProviderName } from '../db/schema';

import {
  countIdentities,
  linkIdentity,
  listIdentities,
  resolveIdentity,
  signInWithIdentity,
  unlinkIdentity,
  type ProvenIdentity,
} from './identity';

/**
 * Account policy, against a real Postgres (AUTH-02).
 *
 * These need a database rather than a mock, because the guarantees being
 * checked are the database's: `player_identity_provider_subject_key` is what
 * makes two concurrent links resolve to one, `FOR UPDATE` is what makes the
 * last-method guard more than advisory, and `ON DELETE CASCADE` is what makes a
 * deleted player take its identities. A fake repository would pass every one of
 * these tests while the real ones remained unproven.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [auth/identity.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/** Every provider the enum carries, so a policy test cannot silently cover one. */
const ALL_PROVIDERS: readonly AuthProviderName[] = ['google', 'discord', 'email', 'passkey'];

let subjectCounter = 0;
function proven(overrides: Partial<ProvenIdentity> = {}): ProvenIdentity {
  subjectCounter += 1;
  return {
    provider: 'discord',
    subject: `subject-${String(subjectCounter)}-${String(Date.now())}`,
    email: null,
    displayName: 'Proven Person',
    avatarUrl: null,
    ...overrides,
  };
}

describeDb('identity policy', () => {
  let db: DatabaseHandle;
  const madePlayers: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    // Identities go with the player by cascade — which test
    // `schema.test.ts` proves, so relying on it here is not an assumption.
    const ids = madePlayers.splice(0);
    if (ids.length > 0) await db.db.delete(player).where(inArray(player.id, ids));
  });

  afterAll(async () => {
    await db.close();
  });

  /** A player with no identities, standing in for one made some other way. */
  async function makePlayer(displayName = 'Existing Player'): Promise<string> {
    const rows = await db.db.insert(player).values({ displayName }).returning({ id: player.id });
    const id = rows[0]!.id;
    madePlayers.push(id);
    return id;
  }

  /** Signs in with no session in scope, and records the player for cleanup. */
  async function signIn(identity: ProvenIdentity, allowRegistration = true) {
    const result = await signInWithIdentity(db.db, identity, { allowRegistration });
    if (result.ok) madePlayers.push(result.value.playerId);
    return result;
  }

  /** As `signIn`, for the cases that need to pass a current session. */
  async function signInWithSession(
    identity: ProvenIdentity,
    options: { allowRegistration: boolean; currentPlayerId?: string | null },
  ) {
    const result = await signInWithIdentity(db.db, identity, options);
    if (result.ok) madePlayers.push(result.value.playerId);
    return result;
  }

  // ------------------------------------------------------------------ sign-in

  describe('signInWithIdentity', () => {
    it('creates a player and its identity on a first sign-in', async () => {
      const identity = proven({ displayName: 'Amelia', avatarUrl: 'https://example.test/a.png' });
      const result = await signIn(identity);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.created).toBe(true);

      const rows = await db.db
        .select()
        .from(playerIdentity)
        .where(eq(playerIdentity.playerId, result.value.playerId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.provider).toBe(identity.provider);
      expect(rows[0]!.subject).toBe(identity.subject);
      // Used *now*: this row exists because an authentication just succeeded.
      expect(rows[0]!.lastUsedAt).toBeInstanceOf(Date);

      const players = await db.db.select().from(player).where(eq(player.id, result.value.playerId));
      expect(players[0]!.displayName).toBe('Amelia');
    });

    it('returns the same player every time and moves last_used_at', async () => {
      const identity = proven();
      const first = await signIn(identity);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const before = await resolveIdentity(db.db, identity.provider, identity.subject);
      const firstUse = (
        await db.db
          .select({ lastUsedAt: playerIdentity.lastUsedAt })
          .from(playerIdentity)
          .where(eq(playerIdentity.id, before!.identityId))
      )[0]!.lastUsedAt;

      // A distinguishable instant later; timestamptz has microsecond resolution
      // but two writes inside the same millisecond would make this vacuous.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const second = await signIn(identity);
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.value.playerId).toBe(first.value.playerId);
      expect(second.value.created).toBe(false);

      const secondUse = (
        await db.db
          .select({ lastUsedAt: playerIdentity.lastUsedAt })
          .from(playerIdentity)
          .where(eq(playerIdentity.id, before!.identityId))
      )[0]!.lastUsedAt;

      expect(secondUse!.getTime()).toBeGreaterThan(firstUse!.getTime());
      // Still one identity and one player, not a second of either.
      expect(await countIdentities(db.db, first.value.playerId)).toBe(1);
    });

    it('does not overwrite an existing player from the provider profile', async () => {
      const identity = proven({ displayName: 'Original' });
      const first = await signIn(identity);
      if (!first.ok) return;

      await signIn({ ...identity, displayName: 'Renamed At Provider' });

      const players = await db.db
        .select({ displayName: player.displayName })
        .from(player)
        .where(eq(player.id, first.value.playerId));
      // A provider does not get to restyle an account on every login — the
      // player may have chosen their own name since.
      expect(players[0]!.displayName).toBe('Original');
    });

    /**
     * The pre-launch front door. Adding providers must not become a way around
     * it, so this asserts the refusal for *every* enum value rather than for
     * the one provider that happens to be wired up.
     */
    it.each(ALL_PROVIDERS)(
      'refuses a new account through %s when registration is closed',
      async (provider) => {
        const identity = proven({ provider });
        const result = await signIn(identity, false);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.code).toBe('registration_closed');

        // Nothing written: not a player, not an identity.
        expect(await resolveIdentity(db.db, provider, identity.subject)).toBeNull();
      },
    );

    it('signs an existing identity in even when registration is closed', async () => {
      const identity = proven();
      const created = await signIn(identity, true);
      if (!created.ok) return;

      const again = await signIn(identity, false);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      // Closing registration locks the door to new accounts, not to the people
      // who already have one.
      expect(again.value.playerId).toBe(created.value.playerId);
    });

    /**
     * The structural rule: sign-in never links. `signInWithIdentity` has no
     * parameter for a current player, so an unknown identity arriving while
     * somebody is signed in cannot attach itself to them — it gets its own
     * account. This test pins the behaviour that absence produces.
     */
    it('gives an unknown identity its own account rather than an existing one', async () => {
      const incumbent = await makePlayer('Incumbent');
      await linkIdentity(db.db, incumbent, proven({ provider: 'google' }));

      const stranger = await signIn(proven({ provider: 'discord' }));
      expect(stranger.ok).toBe(true);
      if (!stranger.ok) return;

      expect(stranger.value.created).toBe(true);
      expect(stranger.value.playerId).not.toBe(incumbent);
      expect(await countIdentities(db.db, incumbent)).toBe(1);
    });

    /**
     * AUTH-04's least intuitive rule and the most important one: an email
     * address two providers agree on is *not* evidence of one account.
     */
    it('never merges two providers reporting the same email address', async () => {
      const shared = 'same-human@example.test';
      const viaGoogle = await signIn(proven({ provider: 'google', email: shared }));
      const viaDiscord = await signIn(proven({ provider: 'discord', email: shared }));

      expect(viaGoogle.ok && viaDiscord.ok).toBe(true);
      if (!viaGoogle.ok || !viaDiscord.ok) return;

      expect(viaDiscord.value.created).toBe(true);
      expect(viaDiscord.value.playerId).not.toBe(viaGoogle.value.playerId);
      expect(await countIdentities(db.db, viaGoogle.value.playerId)).toBe(1);
      expect(await countIdentities(db.db, viaDiscord.value.playerId)).toBe(1);
    });

    /**
     * AUTH-04's decision table, sign-in half.
     *
     * The two rows differ only in whether a session exists, and they were
     * chosen to have opposite answers: with nobody signed in the identity's
     * owner is signed in, because it is their identity; with somebody else
     * signed in the attempt is refused, because a callback must not move a
     * player between accounts.
     */
    describe('when the identity belongs to another player', () => {
      it('signs that player in when nobody is signed in', async () => {
        const identity = proven();
        const owner = await signIn(identity);
        if (!owner.ok) return;

        const again = await signInWithIdentity(db.db, identity, {
          allowRegistration: false,
          currentPlayerId: null,
        });

        expect(again.ok).toBe(true);
        if (!again.ok) return;
        expect(again.value.playerId).toBe(owner.value.playerId);
      });

      it('refuses when a different player is signed in, and changes nothing', async () => {
        const identity = proven();
        const owner = await signIn(identity);
        if (!owner.ok) return;
        const bystander = await makePlayer('Bystander');

        const resolved = await resolveIdentity(db.db, identity.provider, identity.subject);
        const usedBefore = (
          await db.db
            .select({ lastUsedAt: playerIdentity.lastUsedAt })
            .from(playerIdentity)
            .where(eq(playerIdentity.id, resolved!.identityId))
        )[0]!.lastUsedAt;

        const result = await signInWithIdentity(db.db, identity, {
          allowRegistration: true,
          currentPlayerId: bystander,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.code).toBe('identity_already_linked');
        expect(Object.keys(result.failure)).toEqual(['code']);

        // Nothing moved: not the ownership, not the bystander's identities, and
        // not `last_used_at` — a refused attempt must not report a sign-in that
        // never happened.
        const after = await resolveIdentity(db.db, identity.provider, identity.subject);
        expect(after!.playerId).toBe(owner.value.playerId);
        expect(await countIdentities(db.db, bystander)).toBe(0);

        const usedAfter = (
          await db.db
            .select({ lastUsedAt: playerIdentity.lastUsedAt })
            .from(playerIdentity)
            .where(eq(playerIdentity.id, resolved!.identityId))
        )[0]!.lastUsedAt;
        expect(usedAfter!.getTime()).toBe(usedBefore!.getTime());
      });

      it('still signs the owner in when they are the one signed in', async () => {
        const identity = proven();
        const owner = await signIn(identity);
        if (!owner.ok) return;

        // Re-authenticating as yourself is not a conflict — it is the ordinary
        // case of signing in again on a live session.
        const result = await signInWithIdentity(db.db, identity, {
          allowRegistration: false,
          currentPlayerId: owner.value.playerId,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.playerId).toBe(owner.value.playerId);
      });
    });

    /**
     * The invariant that keeps "sign-in never links" true now that a player id
     * is in scope: `currentPlayerId` may only ever *narrow* the outcome. It can
     * turn a success into a refusal, and it must never cause an identity to be
     * attached to it.
     */
    it('never attaches an unknown identity to the signed-in player', async () => {
      const incumbent = await makePlayer('Incumbent');
      await linkIdentity(db.db, incumbent, proven({ provider: 'google' }));

      const result = await signInWithSession(proven({ provider: 'discord' }), {
        allowRegistration: true,
        currentPlayerId: incumbent,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A brand-new identity gets a brand-new account, even though a session
      // was in scope. Connecting it to the incumbent is AUTH-09's `Connect`
      // button, never a side effect of signing in.
      expect(result.value.created).toBe(true);
      expect(result.value.playerId).not.toBe(incumbent);
      expect(await countIdentities(db.db, incumbent)).toBe(1);
    });

    it('resolves two concurrent first sign-ins to one account', async () => {
      const identity = proven();
      const [a, b] = await Promise.all([
        signInWithIdentity(db.db, identity, { allowRegistration: true }),
        signInWithIdentity(db.db, identity, { allowRegistration: true }),
      ]);

      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      madePlayers.push(a.value.playerId, b.value.playerId);

      // Both succeed — it is the same person twice — and both land on the same
      // account. The loser's player insert rolled back with its transaction, so
      // there is no orphan account with no way to sign into it.
      expect(a.value.playerId).toBe(b.value.playerId);

      const rows = await db.db
        .select({ id: playerIdentity.id })
        .from(playerIdentity)
        .where(eq(playerIdentity.subject, identity.subject));
      expect(rows).toHaveLength(1);

      const players = await db.db
        .select({ id: player.id })
        .from(player)
        .where(eq(player.id, a.value.playerId));
      expect(players).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------- link

  describe('linkIdentity', () => {
    it('attaches a second identity to an existing player, unused', async () => {
      const owner = await makePlayer();
      const result = await linkIdentity(db.db, owner, proven({ provider: 'google' }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.alreadyLinked).toBe(false);

      const rows = await db.db
        .select({ lastUsedAt: playerIdentity.lastUsedAt })
        .from(playerIdentity)
        .where(eq(playerIdentity.id, result.value.identityId));
      // Linked is not used. AUTH-03 needs to be able to tell the difference.
      expect(rows[0]!.lastUsedAt).toBeNull();
    });

    it('refuses an identity that belongs to another player, and discloses nothing', async () => {
      const identity = proven();
      const first = await signIn(identity);
      if (!first.ok) return;

      const interloper = await makePlayer('Interloper');
      const result = await linkIdentity(db.db, interloper, identity);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe('identity_already_linked');
      // The refusal carries a code and nothing else — no display name, no id,
      // no email of the account that holds it.
      expect(Object.keys(result.failure)).toEqual(['code']);

      // Ownership did not move, and the interloper gained nothing.
      const settled = await resolveIdentity(db.db, identity.provider, identity.subject);
      expect(settled!.playerId).toBe(first.value.playerId);
      expect(await countIdentities(db.db, interloper)).toBe(0);
    });

    it('is idempotent when the identity is already this player’s', async () => {
      const owner = await makePlayer();
      const identity = proven();

      const first = await linkIdentity(db.db, owner, identity);
      const second = await linkIdentity(db.db, owner, identity);

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.value.alreadyLinked).toBe(true);
      expect(second.value.identityId).toBe(first.value.identityId);
      expect(await countIdentities(db.db, owner)).toBe(1);
    });

    it('produces exactly one link when two players race for the same identity', async () => {
      const a = await makePlayer('Racer A');
      const b = await makePlayer('Racer B');
      const identity = proven();

      const [first, second] = await Promise.all([
        linkIdentity(db.db, a, identity),
        linkIdentity(db.db, b, identity),
      ]);

      // One succeeds, one is refused — decided by the unique constraint rather
      // than by either call's pre-check, which both pass.
      const outcomes = [first.ok, second.ok].sort();
      expect(outcomes).toEqual([false, true]);

      const refused = first.ok ? second : first;
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.failure.code).toBe('identity_already_linked');

      const rows = await db.db
        .select({ playerId: playerIdentity.playerId })
        .from(playerIdentity)
        .where(eq(playerIdentity.subject, identity.subject));
      expect(rows).toHaveLength(1);
      expect([a, b]).toContain(rows[0]!.playerId);
    });
  });

  // ------------------------------------------------------------------- unlink

  describe('unlinkIdentity', () => {
    it('removes one identity when the player has another', async () => {
      const owner = await makePlayer();
      const keep = await linkIdentity(db.db, owner, proven({ provider: 'google' }));
      const drop = await linkIdentity(db.db, owner, proven({ provider: 'discord' }));
      if (!keep.ok || !drop.ok) return;

      const result = await unlinkIdentity(db.db, owner, drop.value.identityId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.provider).toBe('discord');

      const remaining = await listIdentities(db.db, owner);
      expect(remaining.map((i) => i.id)).toEqual([keep.value.identityId]);
    });

    it('refuses to remove the last way into an account', async () => {
      const owner = await makePlayer();
      const only = await linkIdentity(db.db, owner, proven());
      if (!only.ok) return;

      const result = await unlinkIdentity(db.db, owner, only.value.identityId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe('last_method');

      // Still there. An account with no identity cannot be signed into by
      // anyone, ever, and nothing recovers it.
      expect(await countIdentities(db.db, owner)).toBe(1);
    });

    it('conceals another player’s identity behind the same not_found', async () => {
      const owner = await makePlayer('Owner');
      const other = await makePlayer('Other');
      await linkIdentity(db.db, other, proven({ provider: 'google' }));
      const theirs = await linkIdentity(db.db, other, proven({ provider: 'discord' }));
      if (!theirs.ok) return;

      const crossOwner = await unlinkIdentity(db.db, owner, theirs.value.identityId);
      const absent = await unlinkIdentity(db.db, owner, '00000000-0000-0000-0000-000000000000');

      expect(crossOwner.ok).toBe(false);
      expect(absent.ok).toBe(false);
      if (crossOwner.ok || absent.ok) return;
      // ADR-0020: a cross-owner id and an id that never existed are the same
      // answer. Anything else confirms the other identity exists.
      expect(crossOwner.failure).toEqual(absent.failure);
      expect(crossOwner.failure.code).toBe('not_found');

      expect(await countIdentities(db.db, other)).toBe(2);
    });
  });

  // --------------------------------------------------------------------- list

  it('lists a player’s identities oldest first', async () => {
    const owner = await makePlayer();
    const first = await linkIdentity(db.db, owner, proven({ provider: 'google' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await linkIdentity(db.db, owner, proven({ provider: 'discord' }));
    if (!first.ok || !second.ok) return;

    const listed = await listIdentities(db.db, owner);
    expect(listed.map((i) => i.provider)).toEqual(['google', 'discord']);
    expect(listed.every((i) => i.lastUsedAt === null)).toBe(true);
  });
});
