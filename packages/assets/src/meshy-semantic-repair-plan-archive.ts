import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readBoundedMeshyInput } from './meshy-preflight';
import { createMeshySemanticRepairPlan } from './meshy-semantic-repair-plan';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Assessment = z
  .object({
    format: z.literal('tailfin-meshy-semantic-residual-review-assessment'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    residualReportSha256: Digest,
    residualReviewSourceSha256: Digest,
    state: z.literal('quarantine'),
    allPatchesReviewed: z.literal(true),
  })
  .passthrough();

/** Seal an exact authoring handoff from the immutable residual-review evidence chain. */
export async function archiveMeshySemanticRepairPlan(
  archiveRoot: string,
  operation: string,
  residualReviewAssessmentSha256: string,
) {
  const assessmentBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(
        archiveRoot,
        `semantic-residual-review-assessment-${residualReviewAssessmentSha256}.json`,
      ),
      1024 * 1024,
    ),
  );
  if (sha256(assessmentBytes) !== residualReviewAssessmentSha256)
    throw new Error('Semantic residual review assessment identity changed.');
  const assessmentInput = JSON.parse(assessmentBytes.toString('utf8')) as unknown;
  const assessment = Assessment.parse(assessmentInput);
  if (assessment.operationId !== operation)
    throw new Error('Semantic repair plan operation does not match the candidate.');

  const residualBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `semantic-residual-topology-${assessment.residualReportSha256}.json`),
      1024 * 1024,
    ),
  );
  if (sha256(residualBytes) !== assessment.residualReportSha256)
    throw new Error('Semantic residual report identity changed.');
  const reviewBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(
        archiveRoot,
        `semantic-residual-review-source-${assessment.residualReviewSourceSha256}.json`,
      ),
      1024 * 1024,
    ),
  );
  if (sha256(reviewBytes) !== assessment.residualReviewSourceSha256)
    throw new Error('Semantic residual review source identity changed.');

  const reviewInput = JSON.parse(reviewBytes.toString('utf8')) as unknown;
  const {
    plan,
    planSha256,
    assessment: regeneratedAssessment,
  } = createMeshySemanticRepairPlan(
    JSON.parse(residualBytes.toString('utf8')) as unknown,
    reviewInput,
    assessment.residualReportSha256,
    residualReviewAssessmentSha256,
  );
  if (
    canonicalJson({
      ...regeneratedAssessment,
      residualReviewSourceSha256: assessment.residualReviewSourceSha256,
    }) !== canonicalJson(assessmentInput)
  )
    throw new Error('Semantic residual review assessment evidence changed.');
  const planBytes = Buffer.from(canonicalJson(plan));
  if (planBytes.length > 1024 * 1024) throw new Error('Semantic repair plan exceeds its bound.');
  if (sha256(planBytes) !== planSha256) throw new Error('Semantic repair plan identity changed.');
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-repair-plan-${planSha256}.json`),
    planBytes,
  );
  return { operationId: operation, planSha256, plan };
}
