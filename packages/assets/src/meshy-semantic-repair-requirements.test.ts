import { describe, expect, it } from 'vitest';

import { createMeshySemanticRepairRequirements } from './meshy-semantic-repair-requirements';

const digest = 'a'.repeat(64);
const assessment = {
  format: 'tailfin-meshy-semantic-review-assessment',
  formatVersion: 1,
  operationId: 'candidate-1',
  derivativeSha256: 'b'.repeat(64),
  inventoryReportSha256: 'c'.repeat(64),
  reviewSourceSha256: 'd'.repeat(64),
  state: 'quarantine',
  semanticAssignmentsMade: true,
  uncoveredByComponent: [{ componentId: 'review_component_002', triangles: 12 }],
  missingTargets: ['cockpit_glass', 'doors_left', 'lights'],
  unreviewedTargets: [],
};

describe('semantic repair requirements', () => {
  it('turns reviewed gaps into explicit quarantine-only authoring obligations', () => {
    const requirements = createMeshySemanticRepairRequirements(assessment, digest);
    expect(requirements).toMatchObject({
      assessmentSha256: digest,
      repairAuthoringMayBegin: true,
      repairComplete: false,
      runtimeAdmission: 'not-reviewed',
      liveryReady: false,
      creditsSpentByThisCommand: 0,
    });
    expect(requirements.modeledTargetRequirements).toEqual([
      expect.objectContaining({
        targetId: 'cockpit_glass',
        allowedAuthoring: ['closed_opaque_geometry'],
      }),
      expect.objectContaining({
        targetId: 'doors_left',
        allowedAuthoring: ['dedicated_decal_geometry', 'canonical_mask'],
      }),
      expect.objectContaining({
        targetId: 'lights',
        allowedAuthoring: ['dedicated_protected_geometry'],
      }),
    ]);
    expect(requirements.residualTriangleRequirements).toEqual([
      expect.objectContaining({
        componentId: 'review_component_002',
        triangles: 12,
        requiresExactComponentLocalCoverage: true,
      }),
    ]);
  });

  it('refuses stale digests and incomplete target review', () => {
    expect(() => createMeshySemanticRepairRequirements(assessment, 'not-a-digest')).toThrow();
    expect(() =>
      createMeshySemanticRepairRequirements(
        { ...assessment, unreviewedTargets: ['winglet_left'] },
        digest,
      ),
    ).toThrow('every target');
  });
});
