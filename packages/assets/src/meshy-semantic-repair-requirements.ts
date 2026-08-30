import { z } from 'zod';

import { MESHY_SEMANTIC_TARGETS } from './meshy-semantic-inventory';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const ComponentId = z.string().regex(/^review_component_\d{3}$/);
const SemanticTargetId = z.enum(MESHY_SEMANTIC_TARGETS.map(([id]) => id));

export const MeshySemanticReviewAssessmentInput = z
  .object({
    format: z.literal('tailfin-meshy-semantic-review-assessment'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    derivativeSha256: Digest,
    inventoryReportSha256: Digest,
    reviewSourceSha256: Digest,
    state: z.literal('quarantine'),
    semanticAssignmentsMade: z.boolean(),
    uncoveredByComponent: z
      .array(
        z
          .object({
            componentId: ComponentId,
            triangles: z.number().int().positive(),
          })
          .strict(),
      )
      .max(256),
    missingTargets: z.array(SemanticTargetId).max(MESHY_SEMANTIC_TARGETS.length),
    unreviewedTargets: z.array(SemanticTargetId).max(MESHY_SEMANTIC_TARGETS.length),
  })
  .passthrough();

const targetRequirements = {
  cockpit_glass: {
    allowedAuthoring: ['closed_opaque_geometry'],
    acceptance: 'Closed opaque protected glazing; no interior and no DoubleSide workaround.',
  },
  cabin_windows_left: {
    allowedAuthoring: ['dedicated_protected_geometry'],
    acceptance: 'Individual left-side cabin windows with a protected material binding.',
  },
  cabin_windows_right: {
    allowedAuthoring: ['dedicated_protected_geometry'],
    acceptance: 'Individual right-side cabin windows with a protected material binding.',
  },
  doors_left: {
    allowedAuthoring: ['dedicated_decal_geometry', 'canonical_mask'],
    acceptance: 'Left-side door outlines are decals or masks and never fuselage holes.',
  },
  doors_right: {
    allowedAuthoring: ['dedicated_decal_geometry', 'canonical_mask'],
    acceptance: 'Right-side door outlines are decals or masks and never fuselage holes.',
  },
  lights: {
    allowedAuthoring: ['dedicated_protected_geometry'],
    acceptance: 'Distinct protected light geometry with no paintable fallback.',
  },
} as const;

/** Produce bounded repair obligations without generating geometry or admitting the candidate. */
export function createMeshySemanticRepairRequirements(input: unknown, assessmentSha256: string) {
  const assessment = MeshySemanticReviewAssessmentInput.parse(input);
  const digest = Digest.parse(assessmentSha256);
  if (assessment.unreviewedTargets.length)
    throw new Error('Semantic repair requirements require every target to be reviewed.');

  return {
    format: 'tailfin-meshy-semantic-repair-requirements' as const,
    formatVersion: 1 as const,
    operationId: assessment.operationId,
    assessmentSha256: digest,
    derivativeSha256: assessment.derivativeSha256,
    inventoryReportSha256: assessment.inventoryReportSha256,
    reviewSourceSha256: assessment.reviewSourceSha256,
    state: 'quarantine' as const,
    sourceSemanticAssignmentsMade: assessment.semanticAssignmentsMade,
    repairAuthoringMayBegin: true as const,
    repairComplete: false,
    modeledTargetRequirements: assessment.missingTargets.map((targetId) => ({
      targetId,
      ...(targetRequirements[targetId as keyof typeof targetRequirements] ?? {
        allowedAuthoring: ['dedicated_semantic_geometry'] as const,
        acceptance: 'Dedicated geometry with the canonical semantic and material binding.',
      }),
    })),
    residualTriangleRequirements: assessment.uncoveredByComponent.map((component) => ({
      ...component,
      allowedResolutions: [
        'assign_component_local_ranges',
        'discard_component_local_ranges',
        'repair_into_new_derivative',
      ] as const,
      requiresExactComponentLocalCoverage: true as const,
    })),
    constraints: [
      'Preserve the untouched Meshy export and corrected derivative.',
      'Author repairs only in a new hash-addressed quarantine derivative.',
      'Do not infer a semantic from proximity, colour or component identity.',
      'Protect glazing, windows, lights and engine interiors from livery paint.',
      'Require independent topology, visual, licensing and performance approval before admission.',
    ],
    runtimeAdmission: 'not-reviewed' as const,
    liveryReady: false,
    creditsSpentByThisCommand: 0 as const,
  };
}
