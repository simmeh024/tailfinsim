import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { meshyCredentialStatus, meshyCreditExposure } from './meshy';
import { checkMeshyAccount } from './meshy-account';
import {
  assertArchiveRecoveryApprovalBinding,
  createArchiveRetextureRequest,
  loadArchiveRetextureSource,
} from './meshy-archive-recovery';
import {
  assertMeshyPricingFresh,
  importMeshyPricingReview,
  storeMeshyEvidenceBytes,
} from './meshy-evidence';
import { assertMeshyRunCap, meshyRunApprovalIdentity } from './meshy-run';

import type { MeshyGenerationSpec } from './meshy';
import type { MeshyAccountDeps } from './meshy-account';
import type {
  MeshyArchiveRecoveryStore,
  MeshyArchiveRecoveryApproval,
} from './meshy-archive-recovery-store';
import type { MeshyRunStore } from './meshy-store';

export class MeshyArchiveRecoverySubmissionError extends Error {
  constructor(readonly code: 'preflight-refused' | 'submission-uncertain') {
    super(
      code === 'submission-uncertain'
        ? 'Archive recovery submission may have succeeded; reservation retained. Do not resubmit.'
        : 'Archive recovery preflight refused; no paid request was sent.',
    );
  }
}

export const MeshyArchiveRecoverySubmissionProof = z
  .object({
    format: z.literal('tailfin-meshy-archive-recovery-submission-proof'),
    formatVersion: z.literal(1),
    approvalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    originalRunApprovalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    source: z
      .object({
        taskId: z.uuid(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytes: z.number().int().positive(),
      })
      .strict(),
    requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/),
    pricingReviewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    accountReadinessSha256: z.string().regex(/^[a-f0-9]{64}$/),
    originalRetainedExposure: z.number().int().nonnegative(),
    recoveryReservation: z.literal(10),
    aggregateExposure: z.number().int().nonnegative(),
    totalCreditCeiling: z.literal(50),
    authorizedAt: z.iso.datetime(),
    productionPublicationApproved: z.literal(false),
  })
  .strict();

async function readArchiveRecoverySubmissionId(response: Response): Promise<string> {
  if (
    !response.ok ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    !response.body ||
    Number(response.headers.get('content-length')) > 4_096
  ) {
    await response.body?.cancel();
    throw new Error('Submission receipt refused.');
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid receipt bytes.');
      length += value.length;
      if (length > 4_096) throw new Error('Oversized submission receipt.');
      chunks.push(value);
    }
    return z
      .object({ result: z.uuid() })
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown).result;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function assertRecoveryReady(approval: MeshyArchiveRecoveryApproval): void {
  if (approval.recoveryReservation !== 10 || approval.totalCreditCeiling !== 50)
    throw new Error('Recovery approval has an invalid fixed budget.');
}

/**
 * The only archive-backed paid transport. It durably reserves ten credits before
 * its one POST. A failed/ambiguous POST never retries: the recovery ledger is the
 * authoritative reconciliation point.
 */
export async function submitArchiveMeshyRetexture(
  originalStore: MeshyRunStore,
  recoveryStore: MeshyArchiveRecoveryStore,
  evidenceRoot: string,
  archiveRoot: string,
  spec: MeshyGenerationSpec,
  pricingInput: unknown,
  credential: string,
  deps: MeshyAccountDeps = {
    fetch: globalThis.fetch,
    pause: (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms)),
    now: () => new Date(),
  },
) {
  let body: string;
  let proofSha256: string;
  let approval: MeshyArchiveRecoveryApproval;
  try {
    const recovery = recoveryStore.read();
    if (recovery.reservation || recovery.task)
      throw new Error('Recovery operation already reserved; reconcile it instead.');
    approval = recovery.approval;
    assertRecoveryReady(approval);
    const original = originalStore.read();
    assertMeshyRunCap(original, original.approval.maxCredits);
    if (meshyCredentialStatus(credential) !== 'present') throw new Error('Credential required.');
    const source = loadArchiveRetextureSource(archiveRoot, original);
    assertArchiveRecoveryApprovalBinding(approval, original, source);
    const request = createArchiveRetextureRequest(
      spec,
      meshyCreditExposure(original.budget),
      { bytes: source.bytes, sha256: source.sha256 },
      approval.totalCreditCeiling,
    );
    body = request.body;
    const pricing = importMeshyPricingReview(evidenceRoot, pricingInput, deps.now());
    if (pricing.review.selectedRetextureCredits !== approval.recoveryReservation)
      throw new Error('Recovery price differs from the approved reservation.');
    const account = await checkMeshyAccount(
      original,
      spec,
      original.approval.maxCredits,
      credential,
      deps,
    );
    if (account.balance < approval.totalCreditCeiling) throw new Error('Insufficient balance.');
    assertMeshyPricingFresh(pricing.review, deps.now());

    // Account checking is asynchronous. Re-read both ledgers immediately before
    // committing the write-ahead reservation, so neither approval nor source can drift.
    const currentRecovery = recoveryStore.read();
    if (currentRecovery.reservation || currentRecovery.task)
      throw new Error('Recovery operation already reserved; reconcile it instead.');
    if (canonicalJson(currentRecovery.approval) !== canonicalJson(approval))
      throw new Error('Recovery approval changed.');
    const currentOriginal = originalStore.read();
    const currentSource = loadArchiveRetextureSource(archiveRoot, currentOriginal);
    assertArchiveRecoveryApprovalBinding(approval, currentOriginal, currentSource);
    if (
      meshyCreditExposure(currentOriginal.budget) !== request.originalExposure ||
      currentSource.sha256 !== request.sourceSha256 ||
      currentSource.bytes.length !== request.sourceBytes
    )
      throw new Error('Original archive source changed.');
    assertMeshyPricingFresh(pricing.review, deps.now());
    const proof = MeshyArchiveRecoverySubmissionProof.parse({
      format: 'tailfin-meshy-archive-recovery-submission-proof',
      formatVersion: 1,
      approvalSha256: sha256(canonicalJson(approval)),
      originalRunApprovalSha256: meshyRunApprovalIdentity(currentOriginal.approval),
      source: {
        taskId: currentSource.taskId,
        sha256: currentSource.sha256,
        bytes: currentSource.bytes.length,
      },
      requestBodySha256: request.requestBodySha256,
      pricingReviewSha256: pricing.pricingReviewSha256,
      accountReadinessSha256: storeMeshyEvidenceBytes(
        evidenceRoot,
        Buffer.from(canonicalJson(account)),
      ),
      originalRetainedExposure: request.originalExposure,
      recoveryReservation: approval.recoveryReservation,
      aggregateExposure: request.aggregateExposure,
      totalCreditCeiling: approval.totalCreditCeiling,
      authorizedAt: deps.now().toISOString(),
      productionPublicationApproved: false,
    });
    proofSha256 = storeMeshyEvidenceBytes(evidenceRoot, Buffer.from(canonicalJson(proof)));
    recoveryStore.reserve(
      request.requestBodySha256,
      currentSource.sha256,
      proofSha256,
      deps.now().toISOString(),
    );
  } catch {
    throw new MeshyArchiveRecoverySubmissionError('preflight-refused');
  }

  try {
    const response = await deps.fetch('https://api.meshy.ai/openapi/v1/retexture', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${credential.trim()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body,
    });
    const taskId = await readArchiveRecoverySubmissionId(response);
    recoveryStore.observe({
      taskId,
      status: 'PENDING',
      consumedCredits: null,
      observedAt: deps.now().toISOString(),
    });
    return {
      taskId,
      status: 'PENDING' as const,
      reservedCredits: approval.recoveryReservation,
      proofSha256,
      productionPublicationApproved: false,
    };
  } catch {
    throw new MeshyArchiveRecoverySubmissionError('submission-uncertain');
  }
}
