import { describe, expect, it } from 'vitest';

import { AdminAction, type AdminAction as AdminActionType } from '@tailfin/shared';

import {
  ADMIN_AUDIT_ACTION_POLICY,
  auditEntryViolation,
  auditPolicyFor,
  type AuditEntry,
} from './audit';

function validEntry(action: AdminActionType): AuditEntry {
  const policy = auditPolicyFor(action);
  const base = {
    actorPlayerId: '00000000-0000-4000-8000-000000000001',
    actorLabel: 'SEC-10 test operator',
    action,
    subjectType: policy.subjectType,
    subjectId: '00000000-0000-4000-8000-000000000002',
  } as const;

  if (policy.evidence === 'created') return { ...base, after: { created: true } };
  if (policy.evidence === 'view') return { ...base, after: { disclosed: 'metadata only' } };
  return {
    ...base,
    before: { state: 'before' },
    after: policy.requiresReason
      ? { state: 'after', reason: 'SEC-10 test reason' }
      : { state: 'after' },
  };
}

describe('SEC-10 admin audit action policy', () => {
  it('covers every AdminAction exactly once', () => {
    expect(Object.keys(ADMIN_AUDIT_ACTION_POLICY).sort()).toEqual([...AdminAction.options].sort());
  });

  it.each(AdminAction.options)('%s accepts its complete audit evidence', (action) => {
    expect(auditEntryViolation(validEntry(action))).toBeNull();
  });

  it.each(AdminAction.options)('%s rejects a wrong subject type', (action) => {
    expect(auditEntryViolation({ ...validEntry(action), subjectType: 'instance' })).toMatch(
      /must target/,
    );
  });

  it.each(AdminAction.options.filter((action) => auditPolicyFor(action).evidence === 'change'))(
    '%s refuses a changed action without distinct before/after evidence',
    (action) => {
      const entry = validEntry(action);
      expect(auditEntryViolation({ ...entry, before: undefined })).toMatch(
        /needs before and after/,
      );
      expect(auditEntryViolation({ ...entry, before: entry.after })).toMatch(/must have different/);
    },
  );

  it.each(AdminAction.options.filter((action) => auditPolicyFor(action).requiresReason))(
    '%s refuses a blank reason',
    (action) => {
      expect(
        auditEntryViolation({ ...validEntry(action), after: { state: 'after', reason: ' ' } }),
      ).toMatch(/non-blank reason/);
    },
  );
});
