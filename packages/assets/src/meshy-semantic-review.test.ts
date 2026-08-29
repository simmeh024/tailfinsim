import { describe, expect, it } from 'vitest';

import { sha256 } from './canonical';
import { correctA320neoProportions } from './meshy-correction';
import { prepareMeshyReview } from './meshy-review';
import {
  MESHY_SEMANTIC_TARGETS,
  inventoryMeshySemanticComponents,
} from './meshy-semantic-inventory';
import { assessMeshySemanticReview } from './meshy-semantic-review';
import { fixture, pack } from './meshy-test-fixture';

const axes = [
  [0, 0, -1],
  [0, 1, 0],
  [1, 0, 0],
] as const;

function inputs() {
  const source = pack(
    fixture(
      [
        [-0.486328125, -0.15234375, -0.5],
        [0.486328125, -0.15234375, -0.5],
        [-0.486328125, 0.1572265625, 0.5],
        [0.486328125, 0.1572265625, 0.5],
      ],
      [
        [0, 1, 2],
        [1, 3, 2],
      ],
    ),
  );
  const derivative = correctA320neoProportions(prepareMeshyReview(source).glb, axes).glb;
  const inventory = inventoryMeshySemanticComponents(derivative);
  const inventorySha = sha256('inventory');
  const findings = MESHY_SEMANTIC_TARGETS.map(([targetId, , , required]) => ({
    targetId,
    status: required ? ('missing_requires_modeling' as const) : ('not_applicable' as const),
    rationale: `Fixture does not contain reviewed ${targetId} geometry.`,
  }));
  const review = {
    format: 'tailfin-meshy-semantic-review',
    formatVersion: 1,
    operationId: 'candidate-1',
    derivativeSha256: inventory.derivativeSha256,
    inventoryReportSha256: inventorySha,
    reviewedAt: '2026-08-29T22:00:00.000+02:00',
    reviewedBy: 'local-operator',
    targetFindings: findings,
    dispositions: [],
    notes: [],
  };
  return { inventory, inventorySha, review };
}

describe('explicit semantic review contract', () => {
  it('reports incomplete human review without inventing geometry or readiness', () => {
    const { inventory, inventorySha, review } = inputs();
    const assessment = assessMeshySemanticReview(review, inventory, inventorySha);
    expect(
      assessMeshySemanticReview(
        { ...review, targetFindings: [...review.targetFindings].reverse() },
        inventory,
        inventorySha,
      ),
    ).toEqual(assessment);
    expect(assessment).toMatchObject({
      state: 'quarantine',
      semanticAssignmentsMade: false,
      readyForSemanticRepair: false,
      liveryReady: false,
      creditsSpentByThisCommand: 0,
    });
    expect(assessment.missingTargets).toContain('cockpit_glass');
    expect(assessment.uncoveredByComponent).toEqual([
      { componentId: 'review_component_001', triangles: 2 },
    ]);
  });

  it('accepts exact component-local coverage and rejects overlap or disagreement', () => {
    const { inventory, inventorySha, review } = inputs();
    const targetFindings = review.targetFindings.map((finding) =>
      finding.targetId === 'fuselage'
        ? { targetId: finding.targetId, status: 'present' as const }
        : finding,
    );
    const disposition = {
      targetId: 'fuselage',
      componentId: 'review_component_001',
      ranges: [{ startInclusive: 0, endExclusive: 2 }],
    };
    const assessed = assessMeshySemanticReview(
      { ...review, targetFindings, dispositions: [disposition] },
      inventory,
      inventorySha,
    );
    expect(assessed.dispositionTriangleCounts).toEqual({ fuselage: 2 });
    expect(assessed.uncoveredByComponent).toEqual([]);
    expect(() =>
      assessMeshySemanticReview(
        { ...review, targetFindings, dispositions: [disposition, disposition] },
        inventory,
        inventorySha,
      ),
    ).toThrow('more than once');
    expect(() =>
      assessMeshySemanticReview(
        { ...review, targetFindings, dispositions: [] },
        inventory,
        inventorySha,
      ),
    ).toThrow('must agree');
  });

  it('rejects stale identities, invalid ranges, duplicates and required not-applicable findings', () => {
    const { inventory, inventorySha, review } = inputs();
    expect(() =>
      assessMeshySemanticReview(
        { ...review, derivativeSha256: 'f'.repeat(64) },
        inventory,
        inventorySha,
      ),
    ).toThrow('identity');
    expect(
      assessMeshySemanticReview({ ...review, operationId: 'candidate-2' }, inventory, inventorySha)
        .reviewOperationId,
    ).toBe('candidate-2');
    expect(() =>
      assessMeshySemanticReview(
        {
          ...review,
          dispositions: [
            {
              targetId: 'discarded_artifact',
              componentId: 'review_component_001',
              ranges: [{ startInclusive: 0, endExclusive: 3 }],
            },
          ],
        },
        inventory,
        inventorySha,
      ),
    ).toThrow('exceeds');
    expect(() =>
      assessMeshySemanticReview(
        { ...review, targetFindings: review.targetFindings.map(() => review.targetFindings[0]) },
        inventory,
        inventorySha,
      ),
    ).toThrow('repeats');
    expect(() =>
      assessMeshySemanticReview(
        {
          ...review,
          targetFindings: review.targetFindings.map((finding) =>
            finding.targetId === 'fuselage'
              ? { ...finding, status: 'not_applicable' as const }
              : finding,
          ),
        },
        inventory,
        inventorySha,
      ),
    ).toThrow('required semantic target');
  });
});
