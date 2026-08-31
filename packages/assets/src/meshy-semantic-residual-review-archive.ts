import { join } from 'node:path';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readBoundedMeshyInput } from './meshy-preflight';
import { assessMeshySemanticResidualReview } from './meshy-semantic-residual-review';
import { archiveMeshySemanticResiduals } from './meshy-semantic-residuals-archive';

/** Seal complete authored residual-patch decisions through the immutable evidence chain. */
export async function archiveMeshySemanticResidualReview(
  archiveRoot: string,
  operation: string,
  residualReportSha256: string,
  reviewPath: string,
) {
  const residualBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `semantic-residual-topology-${residualReportSha256}.json`),
      1024 * 1024,
    ),
  );
  if (sha256(residualBytes) !== residualReportSha256)
    throw new Error('Semantic residual report identity changed.');
  const residual = JSON.parse(residualBytes.toString('utf8')) as Record<string, unknown>;
  if (residual.operationId !== operation || typeof residual.assessmentSha256 !== 'string')
    throw new Error('Residual review operation does not match the candidate.');
  const regenerated = await archiveMeshySemanticResiduals(
    archiveRoot,
    operation,
    residual.assessmentSha256,
  );
  if (regenerated.reportSha256 !== residualReportSha256)
    throw new Error('Semantic residual evidence changed.');

  const reviewSource = Buffer.from(await readBoundedMeshyInput(reviewPath, 1024 * 1024));
  const reviewSourceSha256 = sha256(reviewSource);
  const prepared = assessMeshySemanticResidualReview(
    JSON.parse(reviewSource.toString('utf8')) as unknown,
    regenerated.report,
    residualReportSha256,
  );
  const assessment = { ...prepared, residualReviewSourceSha256: reviewSourceSha256 };
  const assessmentBytes = Buffer.from(canonicalJson(assessment));
  if (assessmentBytes.length > 1024 * 1024)
    throw new Error('Semantic residual review assessment exceeds its bound.');
  const assessmentFileSha256 = sha256(assessmentBytes);
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-residual-review-source-${reviewSourceSha256}.json`),
    reviewSource,
  );
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-residual-review-assessment-${assessmentFileSha256}.json`),
    assessmentBytes,
  );
  return { operationId: operation, assessmentFileSha256, assessment };
}
