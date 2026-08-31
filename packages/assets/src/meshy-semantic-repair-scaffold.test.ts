import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { buildFlatMeshyParts } from './meshy-correction';
import { decodeMeshyGeometry } from './meshy-geometry';
import { MESHY_SEMANTIC_TARGETS } from './meshy-semantic-inventory';
import { createMeshySemanticRepairScaffold } from './meshy-semantic-repair-scaffold';

const digest = (character: string) => character.repeat(64);

function evidence() {
  const derivative = buildFlatMeshyParts([
    {
      id: 'review_component_001',
      positions: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [0, 1, 1],
      ],
    },
  ]);
  const review = {
    format: 'tailfin-meshy-semantic-review',
    formatVersion: 1,
    operationId: 'candidate-1',
    derivativeSha256: sha256(derivative),
    inventoryReportSha256: digest('a'),
    reviewedAt: '2026-08-31T00:00:00.000Z',
    reviewedBy: 'Test reviewer',
    targetFindings: MESHY_SEMANTIC_TARGETS.map(([targetId]) => ({
      targetId,
      status: 'present' as const,
    })),
    dispositions: [
      {
        targetId: 'fuselage',
        componentId: 'review_component_001',
        ranges: [{ startInclusive: 0, endExclusive: 1 }],
      },
    ],
    notes: [],
  };
  const plan = {
    format: 'tailfin-meshy-semantic-repair-plan',
    formatVersion: 1,
    operationId: 'candidate-1',
    sourceDerivativeSha256: sha256(derivative),
    residualReportSha256: digest('b'),
    residualReviewAssessmentSha256: digest('c'),
    residualReviewSha256: digest('d'),
    state: 'quarantine',
    componentPlans: [
      {
        componentId: 'review_component_001',
        patches: [
          {
            patchId: 'patch-001',
            triangles: 1,
            resolution: 'repair_into_new_derivative',
            componentLocalTriangleRanges: [{ startInclusive: 1, endExclusive: 2 }],
          },
        ],
      },
    ],
  };
  return { derivative, review, plan, planSha256: sha256(canonicalJson(plan)) };
}

describe('semantic repair scaffold', () => {
  it('preserves every face while separating reviewed semantics from unresolved repair geometry', () => {
    const input = evidence();
    const first = createMeshySemanticRepairScaffold(
      input.derivative,
      input.review,
      input.plan,
      input.planSha256,
    );
    const second = createMeshySemanticRepairScaffold(
      input.derivative,
      input.review,
      input.plan,
      input.planSha256,
    );
    const geometry = decodeMeshyGeometry(first.glb);

    expect(first).toEqual(second);
    expect(geometry.parts.map((part) => [part.name, part.triangleCount])).toEqual([
      ['fuselage', 1],
      ['repair__review_component_001', 1],
    ]);
    expect(first.report).toMatchObject({
      sourceTriangles: 2,
      scaffoldTriangles: 2,
      geometryModified: false,
      authoringComplete: false,
      repairComplete: false,
      liveryReady: false,
      repairNodes: [{ patchIds: ['patch-001'], triangles: 1 }],
    });
  });

  it('refuses a stale plan identity and incomplete triangle coverage', () => {
    const input = evidence();
    expect(() =>
      createMeshySemanticRepairScaffold(input.derivative, input.review, input.plan, digest('e')),
    ).toThrow('plan identity changed');
    const incomplete = { ...input.plan, componentPlans: [] };
    expect(() =>
      createMeshySemanticRepairScaffold(
        input.derivative,
        input.review,
        incomplete,
        sha256(canonicalJson(incomplete)),
      ),
    ).toThrow('does not cover every source triangle');
  });
});
