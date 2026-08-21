import { eq } from 'drizzle-orm';

import { type Database } from '../db/client';
import { adminGrant, airline, player, playerIdentity, session } from '../db/schema';

import { transitionAirlineStatusInTransaction } from './lifecycle';

export type AnonymizePlayerResult =
  | { kind: 'not-found' }
  | {
      kind: 'anonymized';
      alreadyAnonymized: boolean;
      airlinesCeased: number;
      identitiesRemoved: number;
      sessionsRemoved: number;
      adminGrantsRemoved: number;
    };

/**
 * Remove one player's sign-in identity while preserving world history (§22.10).
 *
 * This is AIR-09's tested domain primitive, not the complete GDPR request,
 * retention and export workflow owned by #123. The pseudonymous `player` row
 * remains solely as the required owner anchor for historical airline rows.
 */
export async function anonymizePlayerForWorldHistory(
  db: Database,
  playerId: string,
  realNow: Date = new Date(),
): Promise<AnonymizePlayerResult> {
  return db.transaction(async (tx): Promise<AnonymizePlayerResult> => {
    const players = await tx
      .select()
      .from(player)
      .where(eq(player.id, playerId))
      .limit(1)
      .for('update');
    const current = players[0];
    if (!current) return { kind: 'not-found' };

    const owned = await tx
      .select({ id: airline.id, status: airline.status })
      .from(airline)
      .where(eq(airline.playerId, playerId));
    let airlinesCeased = 0;
    for (const ownedAirline of owned) {
      if (ownedAirline.status === 'ceased') continue;
      const transition = await transitionAirlineStatusInTransaction(
        tx,
        ownedAirline.id,
        { to: 'ceased', reason: 'account anonymization' },
        realNow,
      );
      if (transition.kind === 'transitioned') airlinesCeased += 1;
    }

    const removedIdentities = await tx
      .delete(playerIdentity)
      .where(eq(playerIdentity.playerId, playerId))
      .returning({ id: playerIdentity.id });
    const removedSessions = await tx
      .delete(session)
      .where(eq(session.playerId, playerId))
      .returning({ id: session.id });

    // An anonymized account cannot retain authority or remain the named grantor
    // of another account. Audit rows keep their denormalized historical label.
    await tx
      .update(adminGrant)
      .set({ grantedByPlayerId: null })
      .where(eq(adminGrant.grantedByPlayerId, playerId));
    const removedGrants = await tx
      .delete(adminGrant)
      .where(eq(adminGrant.playerId, playerId))
      .returning({ id: adminGrant.playerId });

    await tx
      .update(player)
      .set({ displayName: 'Deleted player', avatarUrl: null, anonymizedAt: realNow })
      .where(eq(player.id, playerId));

    return {
      kind: 'anonymized',
      alreadyAnonymized: current.anonymizedAt !== null,
      airlinesCeased,
      identitiesRemoved: removedIdentities.length,
      sessionsRemoved: removedSessions.length,
      adminGrantsRemoved: removedGrants.length,
    };
  });
}
