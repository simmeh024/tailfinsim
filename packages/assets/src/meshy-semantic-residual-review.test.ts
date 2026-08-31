import { describe, expect, it } from 'vitest';

import { assessMeshySemanticResidualReview } from './meshy-semantic-residual-review';

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
      triangles: 3,
      componentLocalTriangleRanges: [{ startInclusive: 0, endExclusive: 3 }],
    },
    {
      patchId: 'residual_patch_002',
      componentId: 'review_component_002',
      triangles: 2,
      componentLocalTriangleRanges: [{ startInclusive: 8, endExclusive: 10 }],
    },
  ],
};
const review = {
  format: 'tailfin-meshy-semantic-residual-review',
  formatVersion: 1,
  operationId: 'candidate-1',
  residualReportSha256: digest('e'),
  reviewedAt: '2026-08-31T02:00:00.000Z',
  reviewedBy: 'Test reviewer',
  decisions: [
    {
      patchId: 'residual_patch_002',
      resolution: 'repair_into_new_derivative',
      rationale: 'This patch crosses more than one authored semantic surface.',
      evidenceViews: ['tail', 'top'],
    },
    {
      patchId: 'residual_patch_001',
      resolution: 'assign_existing_geometry',
      semanticTargetId: 'fuselage',
      rationale: 'All reviewed faces form one continuous fuselage skin region.',
      evidenceViews: ['left', 'right'],
    },
  ],
};

describe('semantic residual patch review', () => {
  it('normalizes complete explicit decisions and counts patches and triangles', () => {
    expect(assessMeshySemanticResidualReview(review, residual, digest('e'))).toMatchObject({
      allPatchesReviewed: true,
      repairComplete: false,
      patchCounts: {
        assign_existing_geometry: 1,
        discard_artifact: 0,
        repair_into_new_derivative: 1,
      },
      triangleCounts: {
        assign_existing_geometry: 3,
        discard_artifact: 0,
        repair_into_new_derivative: 2,
      },
      state: 'quarantine',
      runtimeAdmission: 'not-reviewed',
      liveryReady: false,
      creditsSpentByThisCommand: 0,
    });
  });

  it('rejects incomplete, duplicate, stale and structurally inconsistent decisions', () => {
    expect(() =>
      assessMeshySemanticResidualReview(
        { ...review, decisions: review.decisions.slice(0, 1) },
        residual,
        digest('e'),
      ),
    ).toThrow('every patch exactly once');
    expect(() =>
      assessMeshySemanticResidualReview(
        { ...review, decisions: [review.decisions[0], review.decisions[0]] },
        residual,
        digest('e'),
      ),
    ).toThrow('repeats a patch');
    expect(() =>
      assessMeshySemanticResidualReview(
        { ...review, residualReportSha256: digest('f') },
        residual,
        digest('e'),
      ),
    ).toThrow('identity does not match');
    expect(() =>
      assessMeshySemanticResidualReview(
        {
          ...review,
          decisions: review.decisions.map((decision, index) =>
            index ? decision : { ...decision, semanticTargetId: 'fuselage' },
          ),
        },
        residual,
        digest('e'),
      ),
    ).toThrow();
    expect(() =>
      assessMeshySemanticResidualReview(review, { ...residual, residualTriangles: 6 }, digest('e')),
    ).toThrow('patch coverage is invalid');
  });
});
