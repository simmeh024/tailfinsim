import { eq, sql } from 'drizzle-orm';

import { type Database } from '../db/client';
import { adminGrant, player } from '../db/schema';

import { writeAudit } from './audit';

/**
 * Who is an admin, and how they came to be (M1A-01).
 *
 * Every grant and every revocation is audited **in the same transaction** as the
 * change to `admin_grant`. Handing someone the keys is itself one of the actions
 * most worth having a record of, and the issue asks for it explicitly.
 */

export interface Actor {
  playerId: string | null;
  label: string;
  requestId?: string | null;
}

/**
 * The command line, before any admin exists.
 *
 * Someone has to be first, and there is nobody to authorise them. Recording that
 * honestly — a null actor and a label saying so — is better than inventing an
 * authoriser, because "who granted this?" answered with a real name that never
 * made the decision is worse than no name at all.
 */
export const BOOTSTRAP_ACTOR: Actor = {
  playerId: null,
  label: 'bootstrap (command line)',
};

export async function isAdmin(db: Database, playerId: string): Promise<boolean> {
  const rows = await db
    .select({ playerId: adminGrant.playerId })
    .from(adminGrant)
    .where(eq(adminGrant.playerId, playerId))
    .limit(1);
  return rows.length > 0;
}

export interface GrantResult {
  /** False when the player already had a grant, in which case nothing was written. */
  changed: boolean;
}

/**
 * Grants admin, idempotently.
 *
 * Re-granting is a no-op that writes **no** audit row. A log full of "granted
 * admin to someone who already had it" is a log people stop reading, and the
 * entries that matter are the ones that changed something.
 */
export async function grantAdmin(
  db: Database,
  playerId: string,
  actor: Actor,
): Promise<GrantResult> {
  return db.transaction(async (tx) => {
    const exists = await tx
      .select({ playerId: adminGrant.playerId })
      .from(adminGrant)
      .where(eq(adminGrant.playerId, playerId))
      .limit(1);
    if (exists.length > 0) return { changed: false };

    const target = await tx
      .select({ displayName: player.displayName })
      .from(player)
      .where(eq(player.id, playerId))
      .limit(1);
    const name = target[0]?.displayName;
    if (name === undefined) throw new Error(`No player ${playerId}`);

    await tx.insert(adminGrant).values({ playerId, grantedByPlayerId: actor.playerId });

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'admin.granted',
      subjectType: 'player',
      subjectId: playerId,
      before: { admin: false },
      after: { admin: true, displayName: name },
      requestId: actor.requestId,
    });

    return { changed: true };
  });
}

/**
 * Revokes admin, idempotently.
 *
 * Refuses to remove the last one. An instance with no admins cannot grant itself
 * another through the console — recovery means a shell on the server — so the
 * one thing this must not allow is a single misclick locking everybody out.
 */
export async function revokeAdmin(
  db: Database,
  playerId: string,
  actor: Actor,
): Promise<GrantResult> {
  return db.transaction(async (tx) => {
    const exists = await tx
      .select({ playerId: adminGrant.playerId })
      .from(adminGrant)
      .where(eq(adminGrant.playerId, playerId))
      .limit(1);
    if (exists.length === 0) return { changed: false };

    const counted = await tx.select({ n: sql<number>`count(*)::int` }).from(adminGrant);
    if ((counted[0]?.n ?? 0) <= 1) {
      throw new Error(
        'Refusing to revoke the last admin: nobody would be able to grant another without ' +
          'a shell on the server. Grant someone else first.',
      );
    }

    await tx.delete(adminGrant).where(eq(adminGrant.playerId, playerId));

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'admin.revoked',
      subjectType: 'player',
      subjectId: playerId,
      before: { admin: true },
      after: { admin: false },
      requestId: actor.requestId,
    });

    return { changed: true };
  });
}

export interface AdminSummary {
  playerId: string;
  displayName: string;
  grantedAt: Date;
  grantedByPlayerId: string | null;
  grantedByLabel: string | null;
}

export async function listAdmins(db: Database): Promise<AdminSummary[]> {
  const granter = sql<string | null>`(
    select p2.display_name from player p2 where p2.id = ${adminGrant.grantedByPlayerId}
  )`;

  return db
    .select({
      playerId: adminGrant.playerId,
      displayName: player.displayName,
      grantedAt: adminGrant.grantedAt,
      grantedByPlayerId: adminGrant.grantedByPlayerId,
      grantedByLabel: granter,
    })
    .from(adminGrant)
    .innerJoin(player, eq(player.id, adminGrant.playerId))
    .orderBy(adminGrant.grantedAt);
}
