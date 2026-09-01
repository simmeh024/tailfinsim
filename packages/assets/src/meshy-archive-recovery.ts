import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { MeshyGenerationSpec, meshyCreditExposure } from './meshy';
import { readMeshyArtifact, savedMeshyArchive } from './meshy-archive';
import { MESHY_GLB_DOWNLOAD_LIMIT, assertMeshyGlbEnvelope } from './meshy-recovery';
import { meshyRunApprovalIdentity, type MeshyRunState } from './meshy-run';

import type { MeshyArchiveRecoveryApproval } from './meshy-archive-recovery-store';

/** The user-approved ceiling covers retained first-run exposure plus this recovery. */
export const MESHY_ARCHIVE_RECOVERY_TOTAL_CREDIT_LIMIT = 50;
export const MESHY_ARCHIVE_RETEXTURE_CREDITS = 10;

const ArchiveSource = z
  .object({
    bytes: z.instanceof(Buffer),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export interface ArchiveRetextureRequest {
  /** Private request body. It contains local source bytes as a data URI and must never be logged. */
  body: string;
  requestBodySha256: string;
  sourceSha256: string;
  sourceBytes: number;
  originalExposure: number;
  recoveryReservation: number;
  aggregateExposure: number;
  totalCreditCeiling: number;
}

export interface ArchiveRetextureSource {
  taskId: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * The recovery approval is scoped to one exact archived export and the original
 * ledger's retained exposure. Recheck it after every asynchronous preflight.
 */
export function assertArchiveRecoveryApprovalBinding(
  approval: MeshyArchiveRecoveryApproval,
  original: MeshyRunState,
  source: ArchiveRetextureSource,
): void {
  if (
    approval.originalRunApprovalSha256 !== meshyRunApprovalIdentity(original.approval) ||
    approval.originalRetainedExposure !== meshyCreditExposure(original.budget) ||
    approval.source.taskId !== source.taskId ||
    approval.source.exportSha256 !== source.sha256 ||
    approval.source.exportBytes !== source.bytes.length
  )
    throw new Error('Archive recovery approval no longer matches the immutable original run.');
}

/**
 * Reads only the selected candidate's content-addressed, immutable local GLB.
 * It never follows an expiring Meshy download URL or accepts an arbitrary path.
 */
export function loadArchiveRetextureSource(
  archiveRoot: string,
  original: MeshyRunState,
): ArchiveRetextureSource {
  if (!original.selection) throw new Error('Original run has no selected candidate.');
  const selected = original.tasks.find((task) => task.taskId === original.selection?.taskId);
  if (!selected || selected.operationId === 'retexture-selected' || selected.status !== 'SUCCEEDED')
    throw new Error('Original selected candidate is not a successful geometry task.');
  const archive = savedMeshyArchive(archiveRoot, selected.operationId, original);
  if (!archive) throw new Error('Original selected candidate has no immutable source archive.');
  const bytes = readMeshyArtifact(
    join(archiveRoot, `${archive.untouchedExport.sha256}.glb`),
    MESHY_GLB_DOWNLOAD_LIMIT,
  );
  if (
    bytes.length !== archive.untouchedExport.bytes ||
    sha256(bytes) !== archive.untouchedExport.sha256
  )
    throw new Error('Archived source digest changed.');
  assertMeshyGlbEnvelope(bytes);
  return { taskId: selected.taskId, bytes, sha256: archive.untouchedExport.sha256 };
}

/**
 * Makes the provider request from immutable local bytes, rather than an expired
 * provider task. This pure boundary has no credential, network, or persistence
 * side effect; a later durable recovery ledger must reserve before using `body`.
 */
export function createArchiveRetextureRequest(
  specInput: unknown,
  originalExposure: number,
  sourceInput: unknown,
  totalCreditCeiling: number,
): ArchiveRetextureRequest {
  const spec = MeshyGenerationSpec.parse(specInput);
  const source = ArchiveSource.parse(sourceInput);
  const total = z
    .number()
    .int()
    .min(MESHY_ARCHIVE_RETEXTURE_CREDITS)
    .max(MESHY_ARCHIVE_RECOVERY_TOTAL_CREDIT_LIMIT)
    .parse(totalCreditCeiling);
  const retained = z.number().int().nonnegative().max(total).parse(originalExposure);
  if (source.bytes.length === 0 || source.bytes.length > MESHY_GLB_DOWNLOAD_LIMIT)
    throw new Error('Archived source is outside the bounded GLB limit.');
  if (sha256(source.bytes) !== source.sha256) throw new Error('Archived source digest changed.');
  assertMeshyGlbEnvelope(source.bytes);
  const aggregateExposure = retained + MESHY_ARCHIVE_RETEXTURE_CREDITS;
  if (aggregateExposure > total) throw new Error('Aggregate Meshy test ceiling would be exceeded.');

  // Meshy-generated source is retained only as a neutral source PBR unwrap.
  // Canonical Tailfin livery UVs are generated separately downstream.
  const body = canonicalJson({
    ai_model: spec.retexture.ai_model,
    enable_original_uv: true,
    enable_pbr: true,
    model_url: `data:application/octet-stream;base64,${source.bytes.toString('base64')}`,
    target_formats: ['glb'],
    text_style_prompt: spec.retexture.text_style_prompt,
    texture_resolution: spec.retexture.texture_resolution,
  });
  return {
    body,
    requestBodySha256: sha256(body),
    sourceSha256: source.sha256,
    sourceBytes: source.bytes.length,
    originalExposure: retained,
    recoveryReservation: MESHY_ARCHIVE_RETEXTURE_CREDITS,
    aggregateExposure,
    totalCreditCeiling: total,
  };
}

/** Safe terminal representation: neither source bytes nor the data URI can escape. */
export function archiveRetextureDryRunReport(request: ArchiveRetextureRequest) {
  return {
    mode: 'offline-dry-run' as const,
    source: 'immutable-local-meshy-glb' as const,
    sourceSha256: request.sourceSha256,
    sourceBytes: request.sourceBytes,
    originalRetainedExposure: request.originalExposure,
    recoveryReservation: request.recoveryReservation,
    aggregateExposure: request.aggregateExposure,
    totalCreditCeiling: request.totalCreditCeiling,
    requestBodySha256: request.requestBodySha256,
    providerTaskReuse: false,
    spendAuthorizedByThisCommand: false,
  };
}
