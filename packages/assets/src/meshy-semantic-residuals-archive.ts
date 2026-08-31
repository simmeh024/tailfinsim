import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readBoundedMeshyBytes, readBoundedMeshyInput } from './meshy-preflight';
import { inventoryMeshySemanticComponents } from './meshy-semantic-inventory';
import { analyseMeshySemanticResiduals } from './meshy-semantic-residuals';
import { assessMeshySemanticReview, MeshySemanticReview } from './meshy-semantic-review';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Assessment = z
  .object({
    format: z.literal('tailfin-meshy-semantic-review-assessment'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    reviewSourceSha256: Digest,
    derivativeSha256: Digest,
    inventoryReportSha256: Digest,
    state: z.literal('quarantine'),
  })
  .passthrough();

/** Seal residual topology evidence through the complete immutable semantic review chain. */
export async function archiveMeshySemanticResiduals(
  archiveRoot: string,
  operation: string,
  assessmentSha256: string,
) {
  const assessmentBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `semantic-review-assessment-${assessmentSha256}.json`),
      1024 * 1024,
    ),
  );
  if (sha256(assessmentBytes) !== assessmentSha256)
    throw new Error('Semantic review assessment identity changed.');
  const assessment = Assessment.parse(JSON.parse(assessmentBytes.toString('utf8')) as unknown);
  if (assessment.operationId !== operation)
    throw new Error('Residual analysis operation does not match the candidate.');
  const inventoryBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `${operation}-semantic-inventory-v1.json`),
      1024 * 1024,
    ),
  );
  if (sha256(inventoryBytes) !== assessment.inventoryReportSha256)
    throw new Error('Semantic inventory identity changed.');
  const derivative = await readBoundedMeshyBytes(
    join(archiveRoot, `correction-${assessment.derivativeSha256}.glb`),
    64 * 1024 * 1024,
  );
  if (sha256(derivative) !== assessment.derivativeSha256)
    throw new Error('Correction derivative identity changed.');
  const inventory = inventoryMeshySemanticComponents(derivative);
  const storedInventory = JSON.parse(inventoryBytes.toString('utf8')) as Record<string, unknown>;
  if (
    canonicalJson(inventory.components) !== canonicalJson(storedInventory.components) ||
    canonicalJson(inventory.requiredSemanticTargets) !==
      canonicalJson(storedInventory.requiredSemanticTargets)
  )
    throw new Error('Semantic inventory evidence changed.');
  const reviewBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `semantic-review-source-${assessment.reviewSourceSha256}.json`),
      1024 * 1024,
    ),
  );
  if (sha256(reviewBytes) !== assessment.reviewSourceSha256)
    throw new Error('Semantic review source identity changed.');
  const review = MeshySemanticReview.parse(JSON.parse(reviewBytes.toString('utf8')) as unknown);
  const regeneratedAssessment = {
    ...assessMeshySemanticReview(review, inventory, assessment.inventoryReportSha256),
    operationId: operation,
    reviewSourceSha256: assessment.reviewSourceSha256,
  };
  if (canonicalJson(regeneratedAssessment) !== canonicalJson(assessment))
    throw new Error('Semantic review assessment evidence changed.');
  const analysis = analyseMeshySemanticResiduals(derivative, review);
  const report = {
    format: 'tailfin-meshy-semantic-residual-topology' as const,
    formatVersion: 1 as const,
    operationId: operation,
    assessmentSha256,
    reviewSourceSha256: assessment.reviewSourceSha256,
    inventoryReportSha256: assessment.inventoryReportSha256,
    derivativeSha256: assessment.derivativeSha256,
    state: 'quarantine' as const,
    runtimeAdmission: 'not-reviewed' as const,
    liveryReady: false,
    ...analysis,
    blockingReasons: [
      'Every residual patch requires explicit human classification before topology repair.',
      'This report does not modify geometry, assign semantics or admit an asset.',
    ],
    creditsSpentByThisCommand: 0,
  };
  const bytes = Buffer.from(canonicalJson(report));
  if (bytes.length > 1024 * 1024) throw new Error('Semantic residual report exceeds its bound.');
  const reportSha256 = sha256(bytes);
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-residual-topology-${reportSha256}.json`),
    bytes,
  );
  return { operationId: operation, reportSha256, report };
}
