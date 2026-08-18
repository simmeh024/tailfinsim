import { desc } from 'drizzle-orm';

import { type AdminAction, type AdminSubjectType } from '@tailfin/shared';

import { type Database } from '../db/client';
import { adminAudit, type AdminAuditRow } from '../db/schema';

/**
 * The admin audit log (M1A-01, §22).
 *
 * Append-only, and the database enforces it — migration 0008 installs triggers
 * that refuse UPDATE, DELETE and TRUNCATE. Nothing here could remove a row even
 * if it tried, which is the point: the guarantee does not depend on this file
 * staying correct.
 *
 * ## Written in the same transaction as the change
 *
 * `writeAudit` takes a transaction rather than opening one. An audit row written
 * after the change has committed is a row that can go missing exactly when the
 * change was the one somebody wanted hidden — the process dies, the network
 * drops, the second statement never runs, and the log says nothing happened.
 *
 * Passing the transaction in makes the coupling structural: the only way to
 * record an action is to record it alongside the action itself, and a change
 * that rolls back takes its audit row with it.
 */

export interface AuditEntry {
  actorPlayerId: string | null;
  /**
   * Who, in words that outlive the account.
   *
   * §22.10 anonymises a departing player rather than deleting them, but an audit
   * log still has to be readable afterwards — "someone reset the world" is not an
   * audit log.
   */
  actorLabel: string;
  action: AdminAction;
  subjectType: AdminSubjectType;
  subjectId: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requestId?: string | null;
}

/** Records one action. Must be called with the transaction that performs it. */
export async function writeAudit(tx: Database, entry: AuditEntry): Promise<void> {
  await tx.insert(adminAudit).values({
    actorPlayerId: entry.actorPlayerId,
    actorLabel: entry.actorLabel,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    before: entry.before == null ? null : JSON.stringify(entry.before),
    after: entry.after == null ? null : JSON.stringify(entry.after),
    requestId: entry.requestId ?? null,
  });
}

/** Newest first. `limit` is capped so a stray query cannot pull the whole log. */
export async function readAudit(db: Database, limit = 100): Promise<AdminAuditRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  return db
    .select()
    .from(adminAudit)
    .orderBy(desc(adminAudit.at), desc(adminAudit.id))
    .limit(capped);
}

/** Parses a stored JSON column back, tolerating anything unparseable rather than throwing. */
export function parseAuditJson(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A row that cannot be parsed is still a row that says something happened.
    // Losing the whole entry because its payload is malformed would be the
    // wrong trade for a log read during an incident.
    return null;
  }
}
