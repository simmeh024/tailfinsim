import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { assessA320neoCanonicalFrame, MeshyAxisReview } from './meshy-frame';
import { readArchivedMeshyGeometry } from './meshy-geometry-report';
import { readBoundedMeshyInput } from './meshy-preflight';
import { type MeshyRunStore } from './meshy-store';

const PriorReview = z
  .object({
    sourceSha256: z.string(),
    derivativeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.literal('quarantine'),
  })
  .passthrough();

/** Offline assessment only; seals no transformed GLB and mutates no run authority. */
export async function archiveMeshyFrameAssessment(
  store: MeshyRunStore,
  archiveRoot: string,
  operation: string,
  axisReviewPath: string,
) {
  const { source } = readArchivedMeshyGeometry(store, archiveRoot, operation);
  const axisReview = MeshyAxisReview.parse(
    JSON.parse(await readBoundedMeshyInput(axisReviewPath, 16_384)) as unknown,
  );
  if (axisReview.operationId !== operation || axisReview.sourceSha256 !== sha256(source))
    throw new Error('Axis review does not identify the archived candidate.');
  const prior = PriorReview.parse(
    JSON.parse(
      await readBoundedMeshyInput(
        join(archiveRoot, `${operation}-review-v1.json`),
        8 * 1024 * 1024,
      ),
    ) as unknown,
  );
  if (prior.sourceSha256 !== sha256(source)) throw new Error('Review source identity changed.');
  const derivative = await readFile(join(archiveRoot, `review-${prior.derivativeSha256}.glb`));
  if (sha256(derivative) !== prior.derivativeSha256)
    throw new Error('Review derivative identity changed.');

  const report = {
    ...assessA320neoCanonicalFrame(source, axisReview),
    sourceSha256: sha256(source),
    prerequisiteReviewSha256: sha256(
      await readFile(join(archiveRoot, `${operation}-review-v1.json`)),
    ),
    prerequisiteDerivativeSha256: prior.derivativeSha256,
    axisReviewFile: basename(axisReviewPath),
    creditsSpentByThisCommand: 0,
  };
  const bytes = Buffer.from(canonicalJson(report));
  writeImmutableMeshyArtifact(join(archiveRoot, `${operation}-frame-v1.json`), bytes);
  return { operationId: operation, reportSha256: sha256(bytes), report };
}
