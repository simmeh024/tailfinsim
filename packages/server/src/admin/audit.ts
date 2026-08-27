import { desc, notInArray } from 'drizzle-orm';

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

type AuditEvidence = 'change' | 'created' | 'view';

interface AuditActionPolicy {
  subjectType: AdminSubjectType;
  evidence: AuditEvidence;
  requiresReason?: true;
}

/**
 * The contract every sensitive administrative operation must meet (SEC-10).
 *
 * `satisfies Record<AdminAction, ...>` makes the action enum and this policy
 * grow together: adding a new action without deciding its subject and evidence
 * is a type error, and `audit-policy.test.ts` exercises every entry.
 */
export const ADMIN_AUDIT_ACTION_POLICY = {
  'admin.granted': { subjectType: 'player', evidence: 'change' },
  'admin.revoked': { subjectType: 'player', evidence: 'change' },
  'world.created': { subjectType: 'world', evidence: 'created' },
  'world.opened': { subjectType: 'world', evidence: 'change' },
  'world.locked': { subjectType: 'world', evidence: 'change' },
  'world.unlocked': { subjectType: 'world', evidence: 'change' },
  'world.archived': { subjectType: 'world', evidence: 'change' },
  'world.reset': { subjectType: 'world', evidence: 'change', requiresReason: true },
  'world.speed_changed': { subjectType: 'world', evidence: 'change' },
  'player.viewed': { subjectType: 'player', evidence: 'view' },
  'sessions.revoked': { subjectType: 'player', evidence: 'change' },
  'airline.identity_changed': { subjectType: 'airline', evidence: 'change', requiresReason: true },
  'airline.cash_adjusted': { subjectType: 'airline', evidence: 'change', requiresReason: true },
  'economy.version_created': { subjectType: 'economy_config', evidence: 'change' },
  'world.economy_pinned': { subjectType: 'world', evidence: 'change' },
  'events.requeued': { subjectType: 'world_event', evidence: 'change' },
} as const satisfies Record<AdminAction, AuditActionPolicy>;

export function auditPolicyFor(action: AdminAction): AuditActionPolicy {
  return ADMIN_AUDIT_ACTION_POLICY[action];
}

function jsonEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Returns the policy failure rather than writing an ambiguous audit row. */
export function auditEntryViolation(entry: AuditEntry): string | null {
  const policy = auditPolicyFor(entry.action);
  if (entry.actorLabel.trim() === '') return 'Audit actorLabel must be non-blank';
  if (entry.subjectType !== policy.subjectType) {
    return `Audit action ${entry.action} must target ${policy.subjectType}, not ${entry.subjectType}`;
  }
  if (entry.subjectId === '') return 'Audit subjectId must be null or non-blank';

  if (policy.evidence === 'created') {
    if (entry.before != null) return `Created action ${entry.action} cannot have a before snapshot`;
    if (entry.after == null) return `Created action ${entry.action} needs an after snapshot`;
  } else if (policy.evidence === 'view') {
    if (entry.before != null) return `View action ${entry.action} cannot have a before snapshot`;
    if (entry.after == null) return `View action ${entry.action} needs a disclosure summary`;
  } else {
    if (entry.before == null || entry.after == null) {
      return `Changed action ${entry.action} needs before and after snapshots`;
    }
    if (jsonEqual(entry.before, entry.after)) {
      return `Changed action ${entry.action} must have different before and after snapshots`;
    }
  }

  if (policy.requiresReason) {
    const reason = entry.after?.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      return `Audit action ${entry.action} needs a non-blank reason in its after snapshot`;
    }
  }
  return null;
}

/** Records one action. Must be called with the transaction that performs it. */
export async function writeAudit(tx: Database, entry: AuditEntry): Promise<void> {
  const violation = auditEntryViolation(entry);
  if (violation) throw new Error(violation);

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

/**
 * Actions that record a *look* rather than a change.
 *
 * Left out of the log by default (M1A-08). Opening somebody's account is an act
 * worth recording — §22.1 asks for a log of every admin action, and a support
 * tool that can read any account without leaving a trace is one nobody can be
 * held to. But views will outnumber changes by orders of magnitude, and a log
 * where "who reset the world?" is buried under three hundred page views is a log
 * that stops being read at exactly the moment it matters.
 *
 * So both are true at once: the row is always written, and the default view
 * leaves it out. Asking for it is one parameter.
 */
const VIEW_ACTIONS: readonly AdminAction[] = ['player.viewed'];

export interface AuditQuery {
  limit?: number;
  /** Include the read-only actions listed above. Default false. */
  includeViews?: boolean;
}

/** Newest first. `limit` is capped so a stray query cannot pull the whole log. */
export async function readAudit(db: Database, options: AuditQuery = {}): Promise<AdminAuditRow[]> {
  const capped = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);

  // Filtered in the query rather than after it: excluding rows in JavaScript
  // would mean a page of 100 that arrives as 12 once the views are dropped.
  const where = options.includeViews ? undefined : notInArray(adminAudit.action, [...VIEW_ACTIONS]);

  return db
    .select()
    .from(adminAudit)
    .where(where)
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
