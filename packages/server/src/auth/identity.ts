import { and, asc, eq, sql } from 'drizzle-orm';

import { type Database } from '../db/client';
import { uniqueViolation } from '../db/constraint-violation';
import { player, playerIdentity, type AuthProviderName } from '../db/schema';

/**
 * One place that decides whether an identity may become, or join, an account
 * (AUTH-02).
 *
 * Four providers means four opportunities to get account-linking policy subtly
 * wrong, and if Discord's callback, the magic-link verifier and the passkey
 * registration each decide independently whether to create a player, reuse one
 * or refuse, then three of them will eventually disagree — and the disagreement
 * will be an account takeover rather than a bug report.
 *
 * So the split is: **protocol code per provider, account policy here.**
 * Exchanging a Discord code, verifying a WebAuthn assertion and checking a
 * magic-link token look nothing like each other and belong apart. What must be
 * identical is the *consequence* of "this identity proved itself", and that is
 * everything below.
 *
 * Two rules worth stating before the code, because both are structural rather
 * than observed:
 *
 * **Sign-in never links.** `signInWithIdentity` takes no player id. There is no
 * argument it could be given to attach an unknown identity to whoever happens
 * to be signed in, which is the shape of the attack AUTH-04 exists to refuse.
 * Linking is a separate function that *requires* a player id, and the caller
 * can only have one from a resolved session.
 *
 * **The database decides duplicates, not the check.** Every path here reads
 * before it writes, and none of them trusts that read. The guarantee is
 * `player_identity_provider_subject_key`; the pre-check exists to produce a
 * clean refusal in the common case, and the unique violation is what makes two
 * concurrent attempts resolve to one link. A pre-check without the constraint
 * would be a race; the constraint without a pre-check would be a 500.
 */

/**
 * What a provider proved, reduced to the fields account policy may use.
 *
 * Deliberately narrow. A provider hands over whatever its protocol returns, and
 * the moment that whole payload reaches this module somebody will match on a
 * field in it. `subject` is the only identifying value here.
 */
export interface ProvenIdentity {
  provider: AuthProviderName;
  /**
   * The provider's stable subject claim — Google's `sub`, Discord's `id`. Never
   * a username, which changes, and never an email address (ADR-0004).
   */
  subject: string;
  /**
   * Informational only, recorded and never matched on. `identity-email.test.ts`
   * fails the build if any module compares this column.
   */
  email: string | null;
  /** Used only when creating a *new* player; never overwrites an existing one. */
  displayName: string | null;
  /** As `displayName` — a provider does not get to restyle an existing account. */
  avatarUrl: string | null;
}

/** Why an identity operation was refused. Stable, and safe to show a client. */
export type IdentityFailure =
  /** A valid identity with no account, on an instance that is not taking new ones. */
  | { code: 'registration_closed' }
  /**
   * That identity belongs to some other account.
   *
   * Deliberately carries nothing about which one. "This Discord account is
   * already connected to a Tailfin account" is the correct amount of
   * information; a display name or email address is a map drawn for the wrong
   * person.
   */
  | { code: 'identity_already_linked' }
  /** Unlinking this would leave the player no way back in (AUTH-03). */
  | { code: 'last_method' }
  /** No such identity *for this player* — see the concealment note on `unlinkIdentity`. */
  | { code: 'not_found' };

export type IdentityResult<T> = { ok: true; value: T } | { ok: false; failure: IdentityFailure };

/** One of a player's ways in, as the account page may see it. */
export interface IdentitySummary {
  id: string;
  provider: AuthProviderName;
  /** Informational; shown to the owner to tell two identities apart. */
  email: string | null;
  createdAt: Date;
  /** Null means never used to sign in — not "used at the epoch" (AUTH-01). */
  lastUsedAt: Date | null;
}

const IDENTITY_UNIQUE_CONSTRAINT = 'player_identity_provider_subject_key';

/** Whether a failed write lost the race for `(provider, subject)`. */
function lostIdentityRace(error: unknown): boolean {
  return uniqueViolation(error)?.constraint === IDENTITY_UNIQUE_CONSTRAINT;
}

/**
 * Which player owns an identity, if anyone.
 *
 * Keyed on `(provider, subject)` and nothing else. This is the only lookup in
 * the codebase entitled to answer "whose account is this?".
 */
export async function resolveIdentity(
  db: Database,
  provider: AuthProviderName,
  subject: string,
): Promise<{ identityId: string; playerId: string } | null> {
  const rows = await db
    .select({ identityId: playerIdentity.id, playerId: playerIdentity.playerId })
    .from(playerIdentity)
    .where(and(eq(playerIdentity.provider, provider), eq(playerIdentity.subject, subject)))
    .limit(1);

  return rows[0] ?? null;
}

/** Records that an identity was just used to authenticate. */
export async function touchIdentity(db: Database, identityId: string): Promise<void> {
  const now = new Date();
  await db
    .update(playerIdentity)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(playerIdentity.id, identityId));
}

/**
 * A provider proved an identity and nobody is being linked: sign in, or create
 * the account if this instance is taking new ones.
 *
 * Note what is *not* a parameter: any notion of a current player. See the
 * module comment.
 */
export async function signInWithIdentity(
  db: Database,
  proven: ProvenIdentity,
  options: {
    allowRegistration: boolean;
    /**
     * The player already holding a session, if there is one. **Refusal-only.**
     *
     * This is the one thing sign-in is told about the current session, and the
     * invariant is that it can only ever *narrow* the outcome: it can turn a
     * success into `identity_already_linked`, and there is no path on which it
     * causes an identity to be attached to it. That is what keeps "sign-in
     * never links" true even though a player id is now in scope — and
     * `identity.test.ts` asserts the narrowing rather than trusting the comment.
     *
     * AUTH-04's rule: a callback must not silently move somebody between
     * accounts. Signing in as B while signed in as A would discard A's session
     * for an account the player may not have meant to reach — recoverable, but
     * indistinguishable from a takeover from the inside.
     */
    currentPlayerId?: string | null;
  },
): Promise<IdentityResult<{ playerId: string; created: boolean }>> {
  const existing = await resolveIdentity(db, proven.provider, proven.subject);
  if (existing) {
    // Refuse before touching anything: a refused attempt must leave
    // `last_used_at` alone, or the account page reports a sign-in that did not
    // happen.
    if (options.currentPlayerId != null && options.currentPlayerId !== existing.playerId) {
      return { ok: false, failure: { code: 'identity_already_linked' } };
    }
    await touchIdentity(db, existing.identityId);
    return { ok: true, value: { playerId: existing.playerId, created: false } };
  }

  // The pre-launch front door, and it must hold for *every* provider — adding a
  // second way in must not become a way around it (AUTH-02).
  if (!options.allowRegistration) {
    return { ok: false, failure: { code: 'registration_closed' } };
  }

  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const created = await tx
        .insert(player)
        .values({
          displayName: proven.displayName ?? 'New player',
          avatarUrl: proven.avatarUrl,
        })
        .returning({ id: player.id });

      const playerId = created[0]?.id;
      if (playerId === undefined) throw new Error('player insert returned no row');

      await tx.insert(playerIdentity).values({
        playerId,
        provider: proven.provider,
        subject: proven.subject,
        email: proven.email,
        // Being used right now, by definition — this row exists because an
        // authentication just succeeded.
        lastUsedAt: now,
        updatedAt: now,
      });

      return { ok: true as const, value: { playerId, created: true } };
    });
  } catch (error) {
    if (!lostIdentityRace(error)) throw error;

    // Two first sign-ins for the same brand-new identity raced. The loser's
    // `player` row rolled back with its transaction, so there is no orphan; the
    // winner's account is *this same person's* account, and signing them into it
    // is the correct outcome rather than an error to show them.
    const settled = await resolveIdentity(db, proven.provider, proven.subject);
    if (!settled) throw error;

    // The same refusal as the fast path above. Without it, losing a race would
    // be a way *past* AUTH-04's rule rather than a slower route to the same
    // answer — narrow, but it is the kind of gap that only exists on the branch
    // nobody re-reads.
    if (options.currentPlayerId != null && options.currentPlayerId !== settled.playerId) {
      return { ok: false, failure: { code: 'identity_already_linked' } };
    }

    await touchIdentity(db, settled.identityId);
    return { ok: true, value: { playerId: settled.playerId, created: false } };
  }
}

/**
 * Attaches an identity to an account that already exists.
 *
 * The caller must already hold a resolved session — that is what `playerId`
 * means here, and there is no path that derives it from anything the client
 * sent. AUTH-09 carries the intent through a *signed* state cookie for the same
 * reason: "turn this sign-in into a link onto my account" is precisely the
 * attack, and a query parameter is attacker-supplied.
 */
export async function linkIdentity(
  db: Database,
  playerId: string,
  proven: ProvenIdentity,
): Promise<IdentityResult<{ identityId: string; alreadyLinked: boolean }>> {
  const existing = await resolveIdentity(db, proven.provider, proven.subject);
  if (existing) {
    // Already this player's: idempotent success, not an error. A player who
    // double-clicks Connect has not done anything wrong, and AUTH-04 says so
    // explicitly for the passkey case.
    if (existing.playerId === playerId) {
      return { ok: true, value: { identityId: existing.identityId, alreadyLinked: true } };
    }
    return { ok: false, failure: { code: 'identity_already_linked' } };
  }

  try {
    const now = new Date();
    const inserted = await db
      .insert(playerIdentity)
      .values({
        playerId,
        provider: proven.provider,
        subject: proven.subject,
        email: proven.email,
        // Linked, not yet used to sign in. Null is the honest value and the one
        // AUTH-03 needs in order to spot a method nobody has ever used.
        lastUsedAt: null,
        updatedAt: now,
      })
      .returning({ id: playerIdentity.id });

    const identityId = inserted[0]?.id;
    if (identityId === undefined) throw new Error('identity insert returned no row');
    return { ok: true, value: { identityId, alreadyLinked: false } };
  } catch (error) {
    if (!lostIdentityRace(error)) throw error;

    // Lost the race. Whoever won owns it now — possibly this same player from a
    // second tab, which is a success, and otherwise a refusal that still says
    // nothing about them.
    const settled = await resolveIdentity(db, proven.provider, proven.subject);
    if (settled?.playerId === playerId) {
      return { ok: true, value: { identityId: settled.identityId, alreadyLinked: true } };
    }
    return { ok: false, failure: { code: 'identity_already_linked' } };
  }
}

/**
 * Removes one of a player's own identities, unless it is the last one.
 *
 * **Concealment is by resolution, not by a post-query owner check** (ADR-0020):
 * the delete is scoped by `playerId`, so another player's identity id and an id
 * that never existed produce the identical `not_found`. Reading the row first
 * and then comparing owners would answer "that exists but is not yours", which
 * is a different and worse answer.
 */
export async function unlinkIdentity(
  db: Database,
  playerId: string,
  identityId: string,
): Promise<IdentityResult<{ provider: AuthProviderName }>> {
  return db.transaction(async (tx) => {
    // `FOR UPDATE` over this player's identities, so two concurrent unlinks
    // cannot each observe two methods and each remove one. Without it the
    // last-method guard is advisory.
    const owned = await tx
      .select({ id: playerIdentity.id, provider: playerIdentity.provider })
      .from(playerIdentity)
      .where(eq(playerIdentity.playerId, playerId))
      .for('update');

    const target = owned.find((row) => row.id === identityId);
    if (!target) return { ok: false as const, failure: { code: 'not_found' as const } };

    // AUTH-03 owns the full rule, including what makes a method *usable*. The
    // floor is here because this is the function that could breach it: an
    // account with no identity cannot be signed into by anyone, ever, and there
    // is no recovery flow that does not start from one.
    if (owned.length <= 1) {
      return { ok: false as const, failure: { code: 'last_method' as const } };
    }

    await tx.delete(playerIdentity).where(eq(playerIdentity.id, identityId));
    return { ok: true as const, value: { provider: target.provider } };
  });
}

/** Every way this player can get in, oldest first, for the account page (AUTH-18). */
export async function listIdentities(db: Database, playerId: string): Promise<IdentitySummary[]> {
  return db
    .select({
      id: playerIdentity.id,
      provider: playerIdentity.provider,
      email: playerIdentity.email,
      createdAt: playerIdentity.createdAt,
      lastUsedAt: playerIdentity.lastUsedAt,
    })
    .from(playerIdentity)
    .where(eq(playerIdentity.playerId, playerId))
    .orderBy(asc(playerIdentity.createdAt));
}

/**
 * How many ways in a player has.
 *
 * Exported for the surfaces that need to *warn* before an unlink rather than be
 * refused by it. Counted in SQL rather than by reading rows, because the caller
 * has no business with the identities themselves to answer this.
 */
export async function countIdentities(db: Database, playerId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(playerIdentity)
    .where(eq(playerIdentity.playerId, playerId));

  return rows[0]?.n ?? 0;
}
