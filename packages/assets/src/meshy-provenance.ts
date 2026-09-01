import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { meshySpecIdentity, type MeshyGenerationSpec } from './meshy';
import {
  readMeshyArtifact,
  savedMeshyArchive,
  savedMeshyRetextureArchive,
  writeImmutableMeshyArtifact,
} from './meshy-archive';
import {
  MeshyCandidateOperation,
  MeshySubmissionProof,
  assertMeshyPricingFresh,
  loadMeshyEvidenceBytes,
  loadMeshyEvidenceJson,
  loadMeshyPricingReview,
  loadPreparedMeshyEvidence,
} from './meshy-evidence';
import { createMeshyRetextureRequest } from './meshy-retexture';
import { MeshyCandidateProvenance, assertMeshyRunCap, meshyRunApprovalIdentity } from './meshy-run';
import { type MeshyRunStore } from './meshy-store';

const RetextureProvenance = z
  .object({
    format: z.literal('tailfin-meshy-retexture-provenance'),
    formatVersion: z.literal(1),
    state: z.literal('quarantine'),
    provider: z.literal('meshy'),
    approvalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    specSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputCandidateProvenance: z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().positive().max(32_768),
      mediaType: z.literal('application/json'),
    }),
    inputTaskId: z.uuid(),
    task: z.object({
      operationId: z.literal('retexture-selected'),
      taskId: z.uuid(),
      status: z.literal('SUCCEEDED'),
      consumedCredits: z.number().int().nonnegative(),
      observedAt: z.iso.datetime(),
    }),
    generatedAt: z.iso.datetime(),
    retexturedGlb: z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().positive(),
      mediaType: z.literal('model/gltf-binary'),
    }),
    pbrTextures: z
      .object({
        baseColor: z.object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().positive(),
          mediaType: z.enum(['image/png', 'image/jpeg']),
        }),
        normal: z.object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().positive(),
          mediaType: z.enum(['image/png', 'image/jpeg']),
        }),
        metallic: z.object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().positive(),
          mediaType: z.enum(['image/png', 'image/jpeg']),
        }),
        roughness: z.object({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().positive(),
          mediaType: z.enum(['image/png', 'image/jpeg']),
        }),
      })
      .strict(),
    licenceReview: z.literal('pending'),
    technicalReview: z.literal('pending'),
    visualReview: z.literal('pending'),
    performanceReview: z.literal('pending'),
  })
  .strict();

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

/**
 * Offline provenance for the PBR derivative. This records a verifiable chain
 * from the selected candidate provenance to the immutable retexture archive; it
 * does not admit either artifact to the runtime or fleet registry.
 */
export async function sealMeshyRetextureProvenance(
  store: MeshyRunStore,
  evidenceRoot: string,
  archiveRoot: string,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  now = new Date(),
) {
  const state = store.read();
  assertMeshyRunCap(state, maxCredits);
  if (!state.selection) throw new Error('A selected candidate is required.');
  const selected = state.tasks.find((task) => task.taskId === state.selection?.taskId);
  if (!selected || selected.operationId === 'retexture-selected')
    throw new Error('Selected candidate record is invalid.');
  const candidate = savedMeshyArchive(archiveRoot, selected.operationId, state);
  const archive = savedMeshyRetextureArchive(archiveRoot, state);
  if (!candidate || !archive) throw new Error('Immutable source archives are required.');
  const candidatePath = join(archiveRoot, `${selected.operationId}-provenance.json`);
  const candidateBytes = readMeshyArtifact(candidatePath, 32_768);
  const candidateProvenance = MeshyCandidateProvenance.parse(
    JSON.parse(candidateBytes.toString('utf8')) as unknown,
  );
  if (
    candidateProvenance.task.taskId !== selected.taskId ||
    candidateProvenance.task.operationId !== selected.operationId ||
    candidateProvenance.untouchedExport?.sha256 !== candidate.untouchedExport.sha256
  )
    throw new Error('Selected candidate provenance differs.');
  const proof = MeshySubmissionProof.parse(
    loadMeshyEvidenceJson(evidenceRoot, archive.requestSha256),
  );
  if (Date.parse(proof.authorizedAt) > Date.parse(archive.task.observedAt))
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
  const request = createMeshyRetextureRequest(spec, selected.taskId);
  if (
    proof.operationId !== 'retexture-selected' ||
    proof.preparedSha256 !== evidence.preparedSha256 ||
    proof.approvalSha256 !== meshyRunApprovalIdentity(state.approval) ||
    proof.specSha256 !== meshySpecIdentity(spec) ||
    proof.requestBodySha256 !== request.requestBodySha256 ||
    archive.inputTaskId !== selected.taskId ||
    Date.parse(archive.finishedAt) > now.getTime()
  )
    throw new Error('Retexture provenance differs.');
  const provenance = RetextureProvenance.parse({
    format: 'tailfin-meshy-retexture-provenance',
    formatVersion: 1,
    state: 'quarantine',
    provider: 'meshy',
    approvalSha256: archive.approvalSha256,
    specSha256: archive.specSha256,
    inputCandidateProvenance: {
      sha256: sha256(candidateBytes),
      bytes: candidateBytes.length,
      mediaType: 'application/json',
    },
    inputTaskId: selected.taskId,
    task: archive.task,
    generatedAt: archive.createdAt,
    retexturedGlb: archive.retexturedGlb,
    pbrTextures: archive.pbrTextures,
    licenceReview: 'pending',
    technicalReview: 'pending',
    visualReview: 'pending',
    performanceReview: 'pending',
  });
  const bytes = Buffer.from(canonicalJson(provenance));
  writeImmutableMeshyArtifact(join(archiveRoot, 'retexture-selected-provenance.json'), bytes);
  return {
    operationId: 'retexture-selected' as const,
    provenanceSha256: sha256(bytes),
    state: 'quarantine' as const,
    runtimeAdmission: 'not-reviewed' as const,
    creditsSpentByThisCommand: 0,
  };
}
