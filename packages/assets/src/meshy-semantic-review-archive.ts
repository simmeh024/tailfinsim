import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readBoundedMeshyBytes, readBoundedMeshyInput } from './meshy-preflight';
import { inventoryMeshySemanticComponents } from './meshy-semantic-inventory';
import { assessMeshySemanticReview } from './meshy-semantic-review';

const InventoryEvidence = z
  .object({
    format: z.literal('tailfin-meshy-semantic-inventory'),
    formatVersion: z.literal(1),
    derivativeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.literal('quarantine'),
    semanticAssignmentsMade: z.literal(false),
    components: z.array(z.unknown()).min(1).max(256),
    requiredSemanticTargets: z.array(z.unknown()).min(1).max(64),
  })
  .passthrough();

/** Archives an authored review and assessment without modifying its derivative or run ledger. */
export async function archiveMeshySemanticReview(
  archiveRoot: string,
  operation: string,
  reviewPath: string,
) {
  const inventoryPath = join(archiveRoot, `${operation}-semantic-inventory-v1.json`);
  const inventoryBytes = Buffer.from(await readBoundedMeshyInput(inventoryPath, 1024 * 1024));
  const inventoryEvidence = InventoryEvidence.parse(
    JSON.parse(inventoryBytes.toString('utf8')) as unknown,
  );
  const derivative = await readBoundedMeshyBytes(
    join(archiveRoot, `correction-${inventoryEvidence.derivativeSha256}.glb`),
    64 * 1024 * 1024,
  );
  if (sha256(derivative) !== inventoryEvidence.derivativeSha256)
    throw new Error('Correction derivative identity changed.');
  const regenerated = inventoryMeshySemanticComponents(derivative);
  if (
    canonicalJson(inventoryEvidence.components) !== canonicalJson(regenerated.components) ||
    canonicalJson(inventoryEvidence.requiredSemanticTargets) !==
      canonicalJson(regenerated.requiredSemanticTargets)
  ) {
    throw new Error('Semantic inventory evidence changed.');
  }
  const reviewSource = Buffer.from(await readBoundedMeshyInput(reviewPath, 1024 * 1024));
  const reviewSourceSha256 = sha256(reviewSource);
  const prepared = assessMeshySemanticReview(
    JSON.parse(reviewSource.toString('utf8')) as unknown,
    regenerated,
    sha256(inventoryBytes),
  );
  if (prepared.reviewOperationId !== operation)
    throw new Error('Semantic review operation does not match the requested candidate.');
  const assessment = {
    ...prepared,
    operationId: operation,
    reviewSourceSha256,
  };
  const assessmentBytes = Buffer.from(canonicalJson(assessment));
  if (assessmentBytes.length > 1024 * 1024)
    throw new Error('Semantic review assessment exceeds its bound.');
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-review-source-${reviewSourceSha256}.json`),
    reviewSource,
  );
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-review-assessment-${sha256(assessmentBytes)}.json`),
    assessmentBytes,
  );
  return {
    operationId: operation,
    assessmentSha256: sha256(assessmentBytes),
    assessment,
  };
}
