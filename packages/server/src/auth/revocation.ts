import { eq } from 'drizzle-orm';

import { writeAudit } from '../admin/audit';
import { type Actor } from '../admin/grants';
import { type Database } from '../db/client';
import { player } from '../db/schema';

import { destroyPlayerSessions } from './session';

/**
 * Ends every session for one player and records only the count, never a token or hash.
 *
 * The deletion and audit row commit together. An incident-response action that succeeds
 * without a durable record, or a record claiming revocation after the delete rolled back,
 * would both be worse than an honest failure.
 */
export async function revokePlayerSessions(
  db: Database,
  playerId: string,
  actor: Actor,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const target = await tx
      .select({ id: player.id })
      .from(player)
      .where(eq(player.id, playerId))
      .limit(1);
    if (!target[0]) return null;

    const revokedSessions = await destroyPlayerSessions(tx, playerId);
    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'sessions.revoked',
      subjectType: 'player',
      subjectId: playerId,
      before: { activeSessions: revokedSessions },
      after: { activeSessions: 0, result: 'success', revokedSessions },
      requestId: actor.requestId,
    });
    return revokedSessions;
  });
}
