import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, eq, gt } from 'drizzle-orm';

import { DEFAULT_CURRENCY, type DisplayCurrency } from '@tailfin/shared';

import { type Database } from '../db/client';
import { player, session } from '../db/schema';

/**
 * Session storage (M0-11).
 *
 * Sessions live in Postgres, not memory: every deploy restarts the process, so
 * in-memory sessions would sign everyone out on each release.
 *
 * **The token is never stored — only its SHA-256.** A dump of the `session`
 * table therefore does not yield a set of usable sessions, for the same reason
 * password hashes exist. The token is 256 bits of CSPRNG output, so a plain hash
 * with no salt or stretching is appropriate: there is no low-entropy secret to
 * brute-force.
 */

export const SESSION_COOKIE = 'tailfin_session';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionPlayer {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: Date;
  /** The player's display currency (M8-02), null column resolved to the default. */
  displayCurrency: DisplayCurrency;
}

/** Issues a session and returns the opaque token to put in the cookie. */
export async function createSession(
  db: Database,
  playerId: string,
  ttlHours: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await db.insert(session).values({
    playerId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return { token, expiresAt };
}

/**
 * Replaces any session presented at login with a fresh token, atomically.
 *
 * A browser-controlled pre-login token must not survive authentication: that
 * would turn it into a session-fixation primitive. Keeping the delete and
 * insert in one transaction also avoids signing somebody out if issuance fails.
 */
export async function replaceSession(
  db: Database,
  previousToken: string | undefined,
  playerId: string,
  ttlHours: number,
): Promise<{ token: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    if (previousToken) await destroySession(tx, previousToken);
    return createSession(tx, playerId, ttlHours);
  });
}

/**
 * Resolves a token to its player, or null.
 *
 * Expiry is enforced in the query rather than after it, so an expired row can
 * never be treated as valid by a caller that forgets to check.
 */
export async function findSessionPlayer(
  db: Database,
  token: string,
): Promise<SessionPlayer | null> {
  if (!token) return null;

  const rows = await db
    .select({
      sessionId: session.id,
      id: player.id,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl,
      createdAt: player.createdAt,
      displayCurrency: player.displayCurrency,
    })
    .from(session)
    .innerJoin(player, eq(player.id, session.playerId))
    .where(and(eq(session.tokenHash, hashToken(token)), gt(session.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Best-effort recency for the sessions UI.
  // Deliberately not awaited into the request path's critical section.
  void db
    .update(session)
    .set({ lastSeenAt: new Date() })
    .where(eq(session.id, row.sessionId))
    .catch(() => undefined);

  return {
    id: row.id,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
    displayCurrency: row.displayCurrency ?? DEFAULT_CURRENCY,
  };
}

/** Invalidates a session server-side. Idempotent. */
export async function destroySession(db: Database, token: string): Promise<void> {
  if (!token) return;
  await db.delete(session).where(eq(session.tokenHash, hashToken(token)));
}

/** Invalidates every session belonging to a player and returns how many were removed. */
export async function destroyPlayerSessions(db: Database, playerId: string): Promise<number> {
  const deleted = await db
    .delete(session)
    .where(eq(session.playerId, playerId))
    .returning({ id: session.id });
  return deleted.length;
}

/**
 * Constant-time string comparison for the OAuth `state` value.
 *
 * `===` on a secret leaks its prefix through timing. The margin is tiny over a
 * network, but the correct comparison costs nothing and means nobody has to
 * reason about whether it matters here.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
