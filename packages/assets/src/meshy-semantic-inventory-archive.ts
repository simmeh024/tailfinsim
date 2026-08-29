import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readBoundedMeshyBytes, readBoundedMeshyInput } from './meshy-preflight';
import { inventoryMeshySemanticComponents } from './meshy-semantic-inventory';

const CorrectionReport = z
  .object({
    format: z.literal('tailfin-meshy-proportion-correction'),
    formatVersion: z.literal(1),
    derivativeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    targetDimensionsMet: z.literal(true),
    semanticPartsAssigned: z.literal(false),
    state: z.literal('quarantine'),
  })
  .passthrough();

/** Archives hash-bound component evidence, never a semantic assignment or admitted asset. */
export async function archiveMeshySemanticInventory(archiveRoot: string, operation: string) {
  const correctionPath = join(archiveRoot, `${operation}-correction-v1.json`);
  const correctionBytes = Buffer.from(await readBoundedMeshyInput(correctionPath, 1024 * 1024));
  const correction = CorrectionReport.parse(
    JSON.parse(correctionBytes.toString('utf8')) as unknown,
  );
  const derivativePath = join(archiveRoot, `correction-${correction.derivativeSha256}.glb`);
  const derivative = await readBoundedMeshyBytes(derivativePath, 64 * 1024 * 1024);
  if (sha256(derivative) !== correction.derivativeSha256)
    throw new Error('Correction derivative identity changed.');
  const report = {
    ...inventoryMeshySemanticComponents(derivative),
    operationId: operation,
    sourceSha256: correction.sourceSha256,
    correctionReportSha256: sha256(correctionBytes),
  };
  const bytes = Buffer.from(canonicalJson(report));
  if (bytes.length > 1024 * 1024) throw new Error('Semantic inventory exceeds its bound.');
  writeImmutableMeshyArtifact(join(archiveRoot, `${operation}-semantic-inventory-v1.json`), bytes);
  return { operationId: operation, reportSha256: sha256(bytes), report };
}
