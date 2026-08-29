import { describe, expect, it } from 'vitest';

import { correctA320neoProportions } from './meshy-correction';
import { prepareMeshyReview } from './meshy-review';
import { inventoryMeshySemanticComponents } from './meshy-semantic-inventory';
import { fixture, pack } from './meshy-test-fixture';

const axes = [
  [0, 0, -1],
  [0, 1, 0],
  [1, 0, 0],
] as const;

function correctedFixture() {
  const source = pack(
    fixture(
      [
        [-0.486328125, -0.15234375, -0.5],
        [0.486328125, -0.15234375, -0.5],
        [-0.486328125, 0.1572265625, 0.5],
        [0.486328125, 0.1572265625, 0.5],
        [-0.1, -0.05, 0.15],
        [0.1, -0.05, 0.15],
        [0, 0.05, 0.25],
        [-0.1, -0.05, -0.25],
        [0.1, -0.05, -0.25],
        [0, 0.05, -0.15],
      ],
      [
        [0, 1, 2],
        [1, 3, 2],
        [4, 5, 6],
        [7, 8, 9],
      ],
    ),
  );
  return correctA320neoProportions(prepareMeshyReview(source).glb, axes).glb;
}

describe('quarantine semantic component inventory', () => {
  it('emits deterministic mirror evidence without making semantic assignments', () => {
    const glb = correctedFixture();
    const first = inventoryMeshySemanticComponents(glb);
    const second = inventoryMeshySemanticComponents(glb);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: 'quarantine',
      semanticAssignmentsMade: false,
      liveryReady: false,
      creditsSpentByThisCommand: 0,
    });
    expect(first.components).toHaveLength(3);
    expect(first.components[0]).toMatchObject({
      componentId: 'review_component_001',
      side: 'crosses_centre',
      requiresManualTriangleLevelReview: true,
      mirrorCandidates: [],
    });
    expect(first.components[1]!.mirrorCandidates[0]?.componentId).toBe('review_component_003');
    expect(first.components[2]!.mirrorCandidates[0]?.componentId).toBe('review_component_002');
    expect(first.requiredSemanticTargets.find((target) => target.id === 'cockpit_glass')).toEqual({
      id: 'cockpit_glass',
      role: 'protected',
      materialClass: 'cockpit_glass',
      required: true,
      reviewStatus: 'unreviewed',
    });
  });

  it('refuses uncorrected or indexed source geometry', () => {
    const indexed = pack(
      fixture(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        [[0, 1, 2]],
      ),
    );
    expect(() => inventoryMeshySemanticComponents(indexed)).toThrow(
      'corrected quarantine derivative',
    );
  });
});
