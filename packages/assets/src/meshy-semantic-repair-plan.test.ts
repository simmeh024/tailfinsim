import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { createMeshySemanticRepairPlan } from './meshy-semantic-repair-plan';

const digest = (character: string) => character.repeat(64);
const residual = {
  format: 'tailfin-meshy-semantic-residual-topology',
  formatVersion: 1,
  operationId: 'candidate-1',
  assessmentSha256: digest('a'),
  reviewSourceSha256: digest('b'),
  inventoryReportSha256: digest('c'),
  derivativeSha256: digest('d'),
  state: 'quarantine',
  residualTriangles: 5,
  residualPatches: [
    {
      patchId: 'residual_patch_001',
      componentId: 'review_component_002',
      triangles: 2,
      componentLocalTriangleRanges: [{ startInclusive: 3, endExclusive: 5 }],
    },
    {
      patchId: 'residual_patch_002',
      componentId: 'review_component_001',
      triangles: 1,
      componentLocalTriangleRanges: [{ startInclusive: 7, endExclusive: 8 }],
    },
    {
      patchId: 'residual_patch_003',
      componentId: 'review_component_002',
      triangles: 2,
      componentLocalTriangleRanges: [
        { startInclusive: 9, endExclusive: 10 },
        { startInclusive: 12, endExclusive: 13 },
      ],
    },
  ],
};

const review = {
  format: 'tailfin-meshy-semantic-residual-review',
  formatVersion: 1,
  operationId: 'candidate-1',
  residualReportSha256: sha256(canonicalJson(residual)),
  reviewedAt: '2026-08-31T12:00:00.000Z',
  reviewedBy: 'Test reviewer',
  decisions: [
    {
      patchId: 'residual_patch_003',
      resolution: 'repair_into_new_derivative',
      rationale: 'This patch crosses a surface boundary and requires explicit remodeling.',
      evidenceViews: ['quarter'],
    },
    {
      patchId: 'residual_patch_001',
      resolution: 'assign_existing_geometry',
      semanticTargetId: 'fuselage',
      rationale: 'This patch is fully contained within the existing fuselage surface.',
      evidenceViews: ['left'],
    },
    {
      patchId: 'residual_patch_002',
      resolution: 'discard_artifact',
      rationale: 'This isolated triangle is a verified disconnected modeling artifact.',
      evidenceViews: ['underside'],
    },
  ],
  notes: [],
};

describe('semantic repair plan', () => {
  it('produces a deterministic exact-range handoff without modifying geometry', () => {
    const residualSha256 = sha256(canonicalJson(residual));
    const result = createMeshySemanticRepairPlan(residual, review, residualSha256, digest('e'));

    expect(result.plan).toMatchObject({
      sourceDerivativeSha256: digest('d'),
      residualReportSha256: residualSha256,
      residualReviewAssessmentSha256: digest('e'),
      geometryModifiedByThisPlan: false,
      repairDerivativeRequired: true,
      repairComplete: false,
      patchCounts: {
        assign_existing_geometry: 1,
        discard_artifact: 1,
        repair_into_new_derivative: 1,
      },
      triangleCounts: {
        assign_existing_geometry: 2,
        discard_artifact: 1,
        repair_into_new_derivative: 2,
      },
    });
    expect(result.plan.componentPlans.map((component) => component.componentId)).toEqual([
      'review_component_001',
      'review_component_002',
    ]);
    expect(result.plan.componentPlans[1]!.patches[1]).toMatchObject({
      patchId: 'residual_patch_003',
      resolution: 'repair_into_new_derivative',
      componentLocalTriangleRanges: [
        { startInclusive: 9, endExclusive: 10 },
        { startInclusive: 12, endExclusive: 13 },
      ],
    });
    expect(result.planSha256).toBe(sha256(canonicalJson(result.plan)));
  });

  it('refuses incomplete human decisions before producing a plan', () => {
    expect(() =>
      createMeshySemanticRepairPlan(
        residual,
        { ...review, decisions: review.decisions.slice(0, 2) },
        sha256(canonicalJson(residual)),
        digest('e'),
      ),
    ).toThrow('Residual review must decide every patch exactly once.');
  });
});
