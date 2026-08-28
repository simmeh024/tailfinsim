import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { meshyCredentialStatus, meshySpecIdentity, type MeshyGenerationSpec } from './meshy';
import { checkMeshyAccount, type MeshyAccountDeps } from './meshy-account';
import { savedMeshyArchive } from './meshy-archive';
import {
  MeshyCandidateOperation,
  MeshySubmissionProof,
  assertMeshyPricingFresh,
  importMeshyPricingReview,
  loadMeshyEvidenceJson,
  loadMeshyPricingReview,
  loadPreparedMeshyEvidence,
  storeMeshyEvidenceBytes,
} from './meshy-evidence';
import { assertMeshyRunCap, meshyRunApprovalIdentity, type MeshyRunState } from './meshy-run';
import { assertMeshyCandidateSequence, type MeshyRunStore } from './meshy-store';

export class MeshySubmissionError extends Error {
  constructor(readonly code: 'preflight-refused' | 'submission-uncertain') {
    super(
      code === 'submission-uncertain'
        ? 'Submission may have succeeded; reservation retained. Do not resubmit; reconcile with Meshy.'
        : 'Meshy submission preflight refused; no paid request was sent.',
    );
  }
}

/** Closed diagnostics only; an ambiguous paid outcome must never be labelled unsubmitted. */
export function meshRunDiagnostic(
  error: unknown,
  reason:
    | 'invalid-input-or-run-state'
    | 'unavailable'
    | 'authentication-refused'
    | 'http-refused'
    | 'invalid-response',
): string {
  return error instanceof MeshySubmissionError
    ? error.message
    : `Meshy run command refused (${reason}); inspect retained run status before any submission.`;
}

async function readSubmissionId(response: Response): Promise<string> {
  if (
    !response.ok ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    !response.body ||
    Number(response.headers.get('content-length')) > 4096
  ) {
    await response.body?.cancel();
    throw new Error('Submission receipt refused.');
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid byte stream.');
      count += value.length;
      if (count > 4096) throw new Error('Oversized receipt.');
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

function assertPriorEvidence(
  state: MeshyRunState,
  evidenceRoot: string,
  archiveRoot: string,
  preparedSha256: string,
  requestBodySha256: string,
): void {
  for (const request of state.requests) {
    const proof = MeshySubmissionProof.parse(
      loadMeshyEvidenceJson(evidenceRoot, request.requestSha256),
    );
    loadMeshyPricingReview(evidenceRoot, proof.pricingReviewSha256);
    loadMeshyEvidenceJson(evidenceRoot, proof.accountReadinessSha256);
    if (
      proof.operationId !== request.operationId ||
      proof.preparedSha256 !== preparedSha256 ||
      proof.requestBodySha256 !== requestBodySha256 ||
      proof.approvalSha256 !== meshyRunApprovalIdentity(state.approval) ||
      proof.specSha256 !== state.approval.specSha256
    )
      throw new Error('Prior candidate evidence differs.');
    if (
      state.tasks.find((task) => task.operationId === request.operationId)?.status ===
        'SUCCEEDED' &&
      !savedMeshyArchive(archiveRoot, request.operationId, state)
    )
      throw new Error('Archive prior success before spending again.');
  }
}

/** The sole paid transport: fixed T2 body, one POST, only AFTER durable reservation COMMIT. */
export async function submitMeshyCandidate(
  store: MeshyRunStore,
  evidenceRoot: string,
  archiveRoot: string,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  operationInput: string,
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
  let operationId: z.infer<typeof MeshyCandidateOperation>;
  try {
    operationId = MeshyCandidateOperation.parse(operationInput);
    const state = store.read();
    assertMeshyRunCap(state, maxCredits);
    assertMeshyCandidateSequence(state, operationId);
    if (meshyCredentialStatus(credential) !== 'present') throw new Error('Credential required.');
    const evidence = await loadPreparedMeshyEvidence(evidenceRoot, state, spec, deps.now());
    // Never serialize receipt/rights/terms files into this body. Only the neutral PNG is uploaded.
    body = canonicalJson({
      ...spec.generation,
      image_url: `data:image/png;base64,${evidence.referenceImage.toString('base64')}`,
    });
    const requestBodySha256 = sha256(body);
    assertPriorEvidence(
      state,
      evidenceRoot,
      archiveRoot,
      evidence.preparedSha256,
      requestBodySha256,
    );
    const pricing = importMeshyPricingReview(evidenceRoot, pricingInput, deps.now());
    const account = await checkMeshyAccount(state, spec, maxCredits, credential, deps);
    if (!account.coversApprovedCeiling) throw new Error('Insufficient balance.');
    assertMeshyPricingFresh(pricing.review, deps.now());
    // Recheck local evidence after the asynchronous account request, before committing authority.
    const current = store.read();
    assertMeshyCandidateSequence(current, operationId);
    const verified = await loadPreparedMeshyEvidence(evidenceRoot, current, spec, deps.now());
    if (verified.preparedSha256 !== evidence.preparedSha256) throw new Error('Evidence changed.');
    assertPriorEvidence(
      current,
      evidenceRoot,
      archiveRoot,
      evidence.preparedSha256,
      requestBodySha256,
    );
    const proof = MeshySubmissionProof.parse({
      format: 'tailfin-meshy-submission-proof',
      formatVersion: 1,
      operationId,
      approvalSha256: meshyRunApprovalIdentity(current.approval),
      specSha256: meshySpecIdentity(spec),
      preparedSha256: evidence.preparedSha256,
      requestBodySha256,
      pricingReviewSha256: pricing.pricingReviewSha256,
      authorizedAt: deps.now().toISOString(),
      accountReadinessSha256: storeMeshyEvidenceBytes(
        evidenceRoot,
        Buffer.from(canonicalJson(account)),
      ),
    });
    proofSha256 = storeMeshyEvidenceBytes(evidenceRoot, Buffer.from(canonicalJson(proof)));
    assertMeshyPricingFresh(pricing.review, deps.now());
    store.reserveCandidate(spec, maxCredits, operationId, proofSha256);
  } catch {
    throw new MeshySubmissionError('preflight-refused');
  }

  try {
    // No retries, even for 429/5xx or a failed response body. Unknown outcome retains five credits.
    const response = await deps.fetch('https://api.meshy.ai/openapi/v1/image-to-3d', {
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
    const taskId = await readSubmissionId(response);
    store.observe({
      operationId,
      taskId,
      status: 'PENDING',
      consumedCredits: null,
      observedAt: deps.now().toISOString(),
    });
    return {
      operationId,
      taskId,
      status: 'PENDING',
      reservedCredits: 5,
      proofSha256,
      productionPublicationApproved: false,
    };
  } catch {
    // This also covers a crash-equivalent failure while saving the returned task ID.
    throw new MeshySubmissionError('submission-uncertain');
  }
}
