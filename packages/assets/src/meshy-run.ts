import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import {
  MeshyBudget,
  MeshyCreditCeiling,
  MeshyGenerationSpec,
  MeshyOperationId,
  createMeshyBudget,
  meshySpecIdentity,
  recordMeshyCharge,
  reserveMeshyOperation,
} from './meshy';

export const MeshySha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime();
const Credits = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A local audit record of consent, not a signature or a new source of authority. */
export const MeshyRunApproval = z
  .object({
    format: z.literal('tailfin-meshy-run-approval'),
    formatVersion: z.literal(1),
    runId: z.literal('a320neo-first-run'),
    specSha256: MeshySha256,
    maxCredits: MeshyCreditCeiling,
    recordedAt: Timestamp,
    authority: z.literal('explicit-user-confirmation'),
    evidence: z
      .object({
        taskId: z.uuid(),
        confirmationSha256: MeshySha256,
      })
      .strict(),
    scope: z.literal('four-t2-candidates-and-one-selected-4k-retexture'),
    fallbackApproved: z.literal(false),
    productionPublicationApproved: z.literal(false),
  })
  .strict();
export type MeshyRunApproval = z.infer<typeof MeshyRunApproval>;

export const MeshyTaskReceipt = z
  .object({
    operationId: MeshyOperationId,
    taskId: z.uuid(),
    status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']),
    consumedCredits: Credits.nullable(),
    observedAt: Timestamp,
  })
  .strict()
  .refine(
    (task) =>
      ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(task.status) || task.consumedCredits === null,
    'only terminal tasks have confirmed charges',
  );
export type MeshyTaskReceipt = z.infer<typeof MeshyTaskReceipt>;

export const MeshyRunState = z
  .object({
    format: z.literal('tailfin-meshy-run-state'),
    formatVersion: z.literal(1),
    approval: MeshyRunApproval,
    budget: MeshyBudget,
    requests: z
      .array(
        z
          .object({
            operationId: MeshyOperationId,
            requestSha256: MeshySha256,
          })
          .strict(),
      )
      .max(5),
    tasks: z.array(MeshyTaskReceipt).max(5),
    selection: z.object({ taskId: z.uuid(), evidenceSha256: MeshySha256 }).strict().nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    const reject = () => context.addIssue({ code: 'custom', message: 'inconsistent run record' });
    if (
      state.approval.maxCredits !== state.budget.maxCredits ||
      state.approval.specSha256 !== state.budget.specSha256
    )
      reject();
    if (
      new Set(state.requests.map((r) => r.operationId)).size !== state.requests.length ||
      state.requests.length !== state.budget.entries.length ||
      state.requests.some((r) => !state.budget.entries.some((e) => e.operationId === r.operationId))
    )
      reject();
    if (
      new Set(state.tasks.map((t) => t.taskId)).size !== state.tasks.length ||
      new Set(state.tasks.map((t) => t.operationId)).size !== state.tasks.length
    )
      reject();
    for (const entry of state.budget.entries) {
      const task = state.tasks.find((t) => t.operationId === entry.operationId);
      if (entry.chargedCredits !== (task?.consumedCredits ?? null)) reject();
    }
    if (state.tasks.some((t) => !state.requests.some((r) => r.operationId === t.operationId)))
      reject();
    if (
      state.selection &&
      !state.tasks.some(
        (t) =>
          t.taskId === state.selection?.taskId &&
          t.operationId !== 'retexture-selected' &&
          t.status === 'SUCCEEDED',
      )
    )
      reject();
    if (state.requests.some((r) => r.operationId === 'retexture-selected') && !state.selection)
      reject();
  });
export type MeshyRunState = z.infer<typeof MeshyRunState>;

export function createMeshyRun(approvalInput: unknown, spec: MeshyGenerationSpec): MeshyRunState {
  const approval = MeshyRunApproval.parse(approvalInput);
  if (approval.specSha256 !== meshySpecIdentity(spec))
    throw new Error('Approval does not match the specification.');
  return MeshyRunState.parse({
    format: 'tailfin-meshy-run-state',
    formatVersion: 1,
    approval,
    budget: createMeshyBudget(spec, approval.maxCredits),
    requests: [],
    tasks: [],
    selection: null,
  });
}

export function assertMeshyRunCap(state: MeshyRunState, maxCredits: number): void {
  if (MeshyCreditCeiling.parse(maxCredits) !== state.approval.maxCredits) {
    throw new Error('The command ceiling must match the immutable run approval.');
  }
}

export function reserveMeshyRunOperation(
  state: MeshyRunState,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  operationId: MeshyOperationId,
  requestSha256: string,
): MeshyRunState {
  assertMeshyRunCap(state, maxCredits);
  MeshySha256.parse(requestSha256);
  if (operationId === 'retexture-selected' && state.selection === null) {
    throw new Error('Retexturing requires a recorded human candidate selection.');
  }
  if (state.requests.some((r) => !state.tasks.some((t) => t.operationId === r.operationId))) {
    throw new Error('An uncertain submission must be reconciled before another reservation.');
  }
  return MeshyRunState.parse({
    ...state,
    budget: reserveMeshyOperation(state.budget, spec, operationId),
    requests: [...state.requests, { operationId, requestSha256 }],
  });
}

export function selectMeshyRunCandidate(
  state: MeshyRunState,
  taskId: string,
  evidenceSha256: string,
): MeshyRunState {
  if (
    state.selection !== null ||
    state.tasks.filter(
      (t) =>
        t.operationId !== 'retexture-selected' &&
        ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(t.status),
    ).length !== 4
  ) {
    throw new Error('Selection requires four terminal candidates and cannot be replaced.');
  }
  return MeshyRunState.parse({ ...state, selection: { taskId, evidenceSha256 } });
}

function assertTaskProgress(before: MeshyTaskReceipt, after: MeshyTaskReceipt): void {
  if (
    before.taskId !== after.taskId ||
    Date.parse(before.observedAt) > Date.parse(after.observedAt) ||
    (before.consumedCredits !== null && before.consumedCredits !== after.consumedCredits) ||
    (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(before.status) &&
      before.status !== after.status) ||
    (before.status === 'IN_PROGRESS' && after.status === 'PENDING')
  ) {
    throw new Error('Task observation regressed or changed identity.');
  }
}

export function observeMeshyRunTask(state: MeshyRunState, input: MeshyTaskReceipt): MeshyRunState {
  const task = MeshyTaskReceipt.parse(input);
  if (!state.requests.some((r) => r.operationId === task.operationId)) {
    throw new Error('Task has no durable reservation.');
  }
  const before = state.tasks.find((t) => t.operationId === task.operationId);
  if (before) assertTaskProgress(before, task);
  return MeshyRunState.parse({
    ...state,
    budget:
      task.consumedCredits === null
        ? state.budget
        : recordMeshyCharge(state.budget, task.operationId, task.consumedCredits),
    tasks: before
      ? state.tasks.map((t) => (t.operationId === task.operationId ? task : t))
      : [...state.tasks, task],
  });
}

/** Replayed on every open; historical approval, reservations and task identities cannot disappear. */
export function assertMeshyRunTransition(before: MeshyRunState, after: MeshyRunState): void {
  if (canonicalJson(before.approval) !== canonicalJson(after.approval))
    throw new Error('Approval changed.');
  if (
    before.selection !== null &&
    canonicalJson(before.selection) !== canonicalJson(after.selection)
  )
    throw new Error('Selection changed.');
  for (const request of before.requests) {
    if (!after.requests.some((r) => canonicalJson(r) === canonicalJson(request)))
      throw new Error('Reservation changed.');
  }
  for (const entry of before.budget.entries) {
    const next = after.budget.entries.find((e) => e.operationId === entry.operationId);
    if (
      next?.reservedCredits !== entry.reservedCredits ||
      (entry.chargedCredits !== null && entry.chargedCredits !== next.chargedCredits)
    ) {
      throw new Error('Budget history changed.');
    }
  }
  for (const task of before.tasks) {
    const next = after.tasks.find((t) => t.operationId === task.operationId);
    if (!next) throw new Error('Task history disappeared.');
    assertTaskProgress(task, next);
  }
}

export const MeshyArtifactDigest = z
  .object({
    sha256: MeshySha256,
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    mediaType: z.enum([
      'image/png',
      'image/jpeg',
      'application/json',
      'application/pdf',
      'text/html',
      'text/plain',
      'model/gltf-binary',
    ]),
  })
  .strict();

/** A sidecar, NOT an AircraftAssetLicenceEvidence extension or permission to publish. */
export const MeshyCandidateProvenance = z
  .object({
    format: z.literal('tailfin-meshy-candidate-provenance'),
    formatVersion: z.literal(1),
    state: z.literal('quarantine'),
    provider: z.literal('meshy'),
    approvalSha256: MeshySha256,
    spec: MeshyGenerationSpec,
    specSha256: MeshySha256,
    referenceImage: MeshyArtifactDigest.nullable(),
    referenceRightsEvidence: MeshyArtifactDigest.nullable(),
    termsSnapshot: MeshyArtifactDigest.nullable(),
    privatePlanEvidence: MeshyArtifactDigest.nullable(),
    task: MeshyTaskReceipt,
    inputTaskId: z.uuid().nullable(),
    generatedAt: Timestamp.nullable(),
    untouchedExport: MeshyArtifactDigest.nullable(),
    licenceReview: z.literal('pending'),
    technicalReview: z.literal('pending'),
    visualReview: z.literal('pending'),
    performanceReview: z.literal('pending'),
  })
  .strict()
  .superRefine((record, context) => {
    const reject = () =>
      context.addIssue({ code: 'custom', message: 'invalid candidate evidence' });
    if (record.specSha256 !== meshySpecIdentity(record.spec)) reject();
    if (
      record.task.operationId === 'retexture-selected'
        ? record.inputTaskId === null || record.inputTaskId === record.task.taskId
        : record.inputTaskId !== null
    )
      reject();
    if (
      record.referenceImage &&
      !['image/png', 'image/jpeg'].includes(record.referenceImage.mediaType)
    )
      reject();
    if (
      record.untouchedExport &&
      (record.untouchedExport.mediaType !== 'model/gltf-binary' ||
        record.task.status !== 'SUCCEEDED' ||
        record.generatedAt === null)
    )
      reject();
    // Neither credentials nor expiring signed URLs belong in a sidecar.
    if (/msy_[A-Za-z0-9_-]+|[?&](?:Expires|Signature|X-Amz-)/i.test(canonicalJson(record)))
      reject();
  });
export type MeshyCandidateProvenance = z.infer<typeof MeshyCandidateProvenance>;

export function meshyRunApprovalIdentity(approval: MeshyRunApproval): string {
  return sha256(canonicalJson(MeshyRunApproval.parse(approval)));
}
