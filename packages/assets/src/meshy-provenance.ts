import { join } from 'node:path';

import { canonicalJson, sha256 } from './canonical';
import { meshySpecIdentity, type MeshyGenerationSpec } from './meshy';
import { savedMeshyArchive, writeImmutableMeshyArtifact } from './meshy-archive';
import {
  MeshyCandidateOperation,
  MeshySubmissionProof,
  assertMeshyPricingFresh,
  loadMeshyEvidenceBytes,
  loadMeshyEvidenceJson,
  loadMeshyPricingReview,
  loadPreparedMeshyEvidence,
} from './meshy-evidence';
import { MeshyCandidateProvenance, assertMeshyRunCap, meshyRunApprovalIdentity } from './meshy-run';
import { type MeshyRunStore } from './meshy-store';

/** Offline, private provenance assembly. Still NOT licence/geometry/visual admission. */
export async function sealMeshyCandidateProvenance(
  store: MeshyRunStore,
  evidenceRoot: string,
  archiveRoot: string,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  operation: string,
  now = new Date(),
) {
  const state = store.read();
  assertMeshyRunCap(state, maxCredits);
  const operationId = MeshyCandidateOperation.parse(operation);
  const archive = savedMeshyArchive(archiveRoot, operationId, state);
  if (!archive) throw new Error('An immutable successful export is required.');
  // Admission may happen after a paid period expires. Verify authority at submission time,
  // while refusing any future-dated receipt; never renew spending authority here.
  const submitted = state.tasks.find((task) => task.operationId === operationId)!;
  if (Date.parse(submitted.observedAt) > now.getTime()) throw new Error('Future task receipt.');
  const proof = MeshySubmissionProof.parse(
    loadMeshyEvidenceJson(evidenceRoot, archive.requestSha256),
  );
  if (Date.parse(proof.authorizedAt) > Date.parse(submitted.observedAt))
    throw new Error('Submission time differs.');
  const price = loadMeshyPricingReview(evidenceRoot, proof.pricingReviewSha256);
  assertMeshyPricingFresh(price, new Date(proof.authorizedAt));
  loadMeshyEvidenceJson(evidenceRoot, proof.accountReadinessSha256);
  const evidence = await loadPreparedMeshyEvidence(
    evidenceRoot,
    state,
    spec,
    new Date(proof.authorizedAt),
  );
  const body = canonicalJson({
    ...spec.generation,
    image_url: `data:image/png;base64,${evidence.referenceImage.toString('base64')}`,
  });
  if (
    proof.operationId !== operationId ||
    proof.preparedSha256 !== evidence.preparedSha256 ||
    proof.approvalSha256 !== meshyRunApprovalIdentity(state.approval) ||
    proof.specSha256 !== meshySpecIdentity(spec) ||
    proof.requestBodySha256 !== sha256(body)
  )
    throw new Error('Submission provenance differs.');
  const rights = loadMeshyEvidenceBytes(evidenceRoot, evidence.preparedSha256, 32_768);
  const provenance = MeshyCandidateProvenance.parse({
    format: 'tailfin-meshy-candidate-provenance',
    formatVersion: 1,
    state: 'quarantine',
    provider: 'meshy',
    approvalSha256: proof.approvalSha256,
    spec,
    specSha256: proof.specSha256,
    referenceImage: evidence.prepared.artifacts.referenceImage,
    referenceRightsEvidence: {
      sha256: evidence.preparedSha256,
      bytes: rights.length,
      mediaType: 'application/json',
    },
    termsSnapshot: evidence.prepared.artifacts.termsSnapshot,
    privatePlanEvidence: evidence.prepared.artifacts.privatePlanEvidence,
    task: archive.task,
    inputTaskId: null,
    generatedAt: archive.createdAt,
    untouchedExport: archive.untouchedExport,
    licenceReview: 'pending',
    technicalReview: 'pending',
    visualReview: 'pending',
    performanceReview: 'pending',
  });
  const bytes = Buffer.from(canonicalJson(provenance));
  writeImmutableMeshyArtifact(join(archiveRoot, `${operationId}-provenance.json`), bytes);
  return {
    operationId,
    provenanceSha256: sha256(bytes),
    state: 'quarantine',
    runtimeAdmission: 'not-reviewed',
    creditsSpentByThisCommand: 0,
  };
}
