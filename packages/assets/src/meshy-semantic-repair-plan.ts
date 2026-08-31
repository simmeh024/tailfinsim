import { canonicalJson, sha256 } from './canonical';
import {
  assessMeshySemanticResidualReview,
  MeshySemanticResidualReportSchema,
  MeshySemanticResidualReview,
} from './meshy-semantic-residual-review';

/**
 * Convert sealed human patch decisions into an exact DCC handoff without changing geometry.
 * The plan remains quarantine evidence until a separately hashed derivative is submitted.
 */
export function createMeshySemanticRepairPlan(
  residualInput: unknown,
  reviewInput: unknown,
  residualReportSha256: string,
  residualReviewAssessmentSha256: string,
) {
  if (!/^[a-f0-9]{64}$/.test(residualReviewAssessmentSha256))
    throw new Error('Residual review assessment SHA-256 is invalid.');
  const residual = MeshySemanticResidualReportSchema.parse(residualInput);
  const review = MeshySemanticResidualReview.parse(reviewInput);
  const assessment = assessMeshySemanticResidualReview(review, residual, residualReportSha256);
  const decisions = new Map(review.decisions.map((decision) => [decision.patchId, decision]));
  const componentPlans = new Map<
    string,
    {
      componentId: string;
      residualTriangles: number;
      patches: {
        patchId: string;
        triangles: number;
        resolution: 'assign_existing_geometry' | 'discard_artifact' | 'repair_into_new_derivative';
        semanticTargetId?: string;
        componentLocalTriangleRanges: {
          startInclusive: number;
          endExclusive: number;
        }[];
      }[];
    }
  >();
  for (const patch of residual.residualPatches) {
    const decision = decisions.get(patch.patchId)!;
    let component = componentPlans.get(patch.componentId);
    if (!component) {
      component = { componentId: patch.componentId, residualTriangles: 0, patches: [] };
      componentPlans.set(patch.componentId, component);
    }
    component.residualTriangles += patch.triangles;
    component.patches.push({
      patchId: patch.patchId,
      triangles: patch.triangles,
      resolution: decision.resolution,
      ...(decision.semanticTargetId ? { semanticTargetId: decision.semanticTargetId } : {}),
      componentLocalTriangleRanges: patch.componentLocalTriangleRanges.map((range) => ({
        ...range,
      })),
    });
  }

  const plan = {
    format: 'tailfin-meshy-semantic-repair-plan' as const,
    formatVersion: 1 as const,
    algorithm: 'sealed-component-local-repair-plan-v1' as const,
    operationId: residual.operationId,
    sourceDerivativeSha256: residual.derivativeSha256,
    residualReportSha256,
    residualReviewAssessmentSha256,
    residualReviewSha256: assessment.reviewSha256,
    state: 'quarantine' as const,
    allPatchesReviewed: true as const,
    geometryModifiedByThisPlan: false as const,
    repairDerivativeRequired: true as const,
    sourceDerivativeMayBeOverwritten: false as const,
    requiredDerivativeIdentity: 'new-sha256-distinct-from-source' as const,
    patchCounts: assessment.patchCounts,
    triangleCounts: assessment.triangleCounts,
    componentPlans: [...componentPlans.values()].sort((a, b) =>
      a.componentId.localeCompare(b.componentId),
    ),
    acceptance: {
      exactComponentLocalCoverageRequired: true as const,
      assignedRangesMustKeepTargetBinding: true as const,
      discardedRangesMustBeAbsent: true as const,
      repairRangesMustBeReplacedOrRetopologized: true as const,
      topologyAndVisualReviewRequired: true as const,
    },
    constraints: [
      'Do not overwrite the corrected source derivative.',
      'Do not infer or widen component-local ranges beyond this sealed plan.',
      'Keep protected glazing, windows, lights and engine interiors outside paintable surfaces.',
      'A new derivative is not repair-complete until exact coverage, topology and visual gates pass.',
    ],
    runtimeAdmission: 'not-reviewed' as const,
    liveryReady: false as const,
    repairComplete: false as const,
    creditsSpentByThisCommand: 0 as const,
  };
  return { plan, planSha256: sha256(canonicalJson(plan)), assessment };
}
