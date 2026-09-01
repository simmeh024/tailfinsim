import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MeshyArchiveRecoveryApproval,
  MeshyArchiveRecoveryState,
  MeshyArchiveRecoveryStore,
} from './meshy-archive-recovery-store';

const time = '2026-09-01T18:40:00.000Z';
const source = {
  taskId: '00000000-0000-4000-8000-000000000001',
  exportSha256: 'a'.repeat(64),
  exportBytes: 280404,
};
const approval = MeshyArchiveRecoveryApproval.parse({
  format: 'tailfin-meshy-archive-recovery-approval',
  formatVersion: 1,
  runId: 'a320neo-archive-retexture-recovery-v1',
  authority: 'explicit-user-confirmation',
  recordedAt: time,
  confirmationSha256: 'b'.repeat(64),
  originalRunApprovalSha256: 'c'.repeat(64),
  originalRetainedExposure: 30,
  totalCreditCeiling: 50,
  recoveryReservation: 10,
  source,
  scope: 'one-archive-backed-4k-pbr-retexture-only',
  productionPublicationApproved: false,
});

let root: string;
let store: MeshyArchiveRecoveryStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tailfin-meshy-archive-recovery-'));
  store = new MeshyArchiveRecoveryStore(join(root, 'recovery.sqlite'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('archive retexture recovery ledger', () => {
  it('records a write-ahead reservation and cannot reuse or rewrite it', () => {
    expect(store.initialize(approval).reservation).toBeNull();
    const reserved = store.reserve('d'.repeat(64), source.exportSha256, 'e'.repeat(64), time);
    expect(reserved.reservation).toMatchObject({
      reservedCredits: 10,
      sourceSha256: source.exportSha256,
      proofSha256: 'e'.repeat(64),
    });
    expect(() => store.reserve('f'.repeat(64), source.exportSha256, 'e'.repeat(64), time)).toThrow(
      'ledger refused',
    );

    const observed = store.observe({
      taskId: '00000000-0000-4000-8000-000000000010',
      status: 'PENDING',
      consumedCredits: null,
      observedAt: time,
    });
    expect(observed.task).toMatchObject({ status: 'PENDING' });
    expect(() =>
      store.observe({
        taskId: '00000000-0000-4000-8000-000000000011',
        status: 'PENDING',
        consumedCredits: null,
        observedAt: time,
      }),
    ).toThrow('ledger refused');
  });

  it('refuses an approval that exceeds the aggregate credit ceiling', () => {
    expect(() =>
      MeshyArchiveRecoveryApproval.parse({ ...approval, originalRetainedExposure: 41 }),
    ).toThrow('Aggregate');
  });

  it('rejects a task in a state without a reservation', () => {
    expect(() =>
      MeshyArchiveRecoveryState.parse({
        format: 'tailfin-meshy-archive-recovery-state',
        formatVersion: 1,
        approval,
        reservation: null,
        task: {
          taskId: '00000000-0000-4000-8000-000000000010',
          status: 'PENDING',
          consumedCredits: null,
          observedAt: time,
        },
      }),
    ).toThrow('task has no durable reservation');
  });
});
