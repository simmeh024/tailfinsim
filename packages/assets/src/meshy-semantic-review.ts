import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import {
  MESHY_SEMANTIC_TARGETS,
  type inventoryMeshySemanticComponents,
} from './meshy-semantic-inventory';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const ComponentId = z.string().regex(/^review_component_\d{3}$/);
const SemanticTargetId = z.enum(MESHY_SEMANTIC_TARGETS.map(([id]) => id));
const DispositionTargetId = z.union([SemanticTargetId, z.literal('discarded_artifact')]);
const TriangleRange = z
  .object({
    startInclusive: z.number().int().nonnegative(),
    endExclusive: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.endExclusive > range.startInclusive, {
    message: 'triangle range must be non-empty',
  });

export const MeshySemanticReview = z
  .object({
    format: z.literal('tailfin-meshy-semantic-review'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    derivativeSha256: Digest,
    inventoryReportSha256: Digest,
    reviewedAt: z.iso.datetime({ offset: true }),
    reviewedBy: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/),
    targetFindings: z
      .array(
        z
          .object({
            targetId: SemanticTargetId,
            status: z.enum([
              'unreviewed',
              'present',
              'missing_requires_modeling',
              'not_applicable',
            ]),
            rationale: z.string().min(12).max(500).optional(),
          })
          .strict(),
      )
      .length(MESHY_SEMANTIC_TARGETS.length),
    dispositions: z
      .array(
        z
          .object({
            targetId: DispositionTargetId,
            componentId: ComponentId,
            ranges: z.array(TriangleRange).min(1).max(4096),
          })
          .strict(),
      )
      .max(4096),
    notes: z.array(z.string().min(1).max(500)).max(64).default([]),
  })
  .strict();
export type MeshySemanticReview = z.infer<typeof MeshySemanticReview>;

type Inventory = ReturnType<typeof inventoryMeshySemanticComponents>;

/** Validate explicit human triangle dispositions; never infer a semantic from geometry. */
export function assessMeshySemanticReview(
  input: unknown,
  inventory: Inventory,
  inventoryReportSha256: string,
) {
  const parsed = MeshySemanticReview.parse(input);
  const targetOrder = new Map(MESHY_SEMANTIC_TARGETS.map(([id], index) => [id, index]));
  const review: MeshySemanticReview = {
    ...parsed,
    targetFindings: [...parsed.targetFindings].sort(
      (a, b) => targetOrder.get(a.targetId)! - targetOrder.get(b.targetId)!,
    ),
    dispositions: parsed.dispositions
      .map((disposition) => ({
        ...disposition,
        ranges: [...disposition.ranges].sort(
          (a, b) => a.startInclusive - b.startInclusive || a.endExclusive - b.endExclusive,
        ),
      }))
      .sort(
        (a, b) =>
          a.targetId.localeCompare(b.targetId) || a.componentId.localeCompare(b.componentId),
      ),
  };
  if (
    review.derivativeSha256 !== inventory.derivativeSha256 ||
    review.inventoryReportSha256 !== inventoryReportSha256
  ) {
    throw new Error('Semantic review identity does not match the immutable inventory.');
  }

  const targetMetadata = new Map(
    MESHY_SEMANTIC_TARGETS.map(([id, role, materialClass, required]) => [
      id,
      { role, materialClass, required },
    ]),
  );
  const findings = new Map<string, MeshySemanticReview['targetFindings'][number]>();
  for (const finding of review.targetFindings) {
    if (findings.has(finding.targetId))
      throw new Error('Semantic review repeats a required target finding.');
    const metadata = targetMetadata.get(finding.targetId)!;
    if (metadata.required && finding.status === 'not_applicable')
      throw new Error('A required semantic target cannot be not-applicable.');
    if (
      ['missing_requires_modeling', 'not_applicable'].includes(finding.status) !==
      (finding.rationale !== undefined)
    ) {
      throw new Error('Missing or not-applicable findings require one bounded rationale.');
    }
    findings.set(finding.targetId, finding);
  }
  if (findings.size !== MESHY_SEMANTIC_TARGETS.length)
    throw new Error('Semantic review must contain each target finding exactly once.');

  const components = new Map(
    inventory.components.map((component) => [component.componentId, component]),
  );
  const coverage = new Map(
    inventory.components.map((component) => [
      component.componentId,
      new Uint8Array(component.triangles),
    ]),
  );
  const dispositionCounts = new Map<string, number>();
  let discardedTriangles = 0;
  for (const disposition of review.dispositions) {
    const component = components.get(disposition.componentId);
    const assigned = coverage.get(disposition.componentId);
    if (!component || !assigned)
      throw new Error('Semantic review references an unknown component.');
    for (const range of disposition.ranges) {
      if (range.endExclusive > component.triangles)
        throw new Error('Semantic review triangle range exceeds its component.');
      for (let triangle = range.startInclusive; triangle < range.endExclusive; triangle += 1) {
        if (assigned[triangle])
          throw new Error('Semantic review assigns one triangle more than once.');
        assigned[triangle] = 1;
      }
      const count = range.endExclusive - range.startInclusive;
      dispositionCounts.set(
        disposition.targetId,
        (dispositionCounts.get(disposition.targetId) ?? 0) + count,
      );
      if (disposition.targetId === 'discarded_artifact') discardedTriangles += count;
    }
  }

  for (const [targetId, finding] of findings) {
    const count = dispositionCounts.get(targetId) ?? 0;
    if ((finding.status === 'present') !== count > 0)
      throw new Error('Present findings and triangle dispositions must agree.');
  }
  const uncoveredByComponent = [...coverage]
    .map(([componentId, assigned]) => ({
      componentId,
      triangles: assigned.reduce((count, value) => count + (value ? 0 : 1), 0),
    }))
    .filter((entry) => entry.triangles > 0);
  const missingTargets = [...findings.values()]
    .filter((finding) => finding.status === 'missing_requires_modeling')
    .map((finding) => finding.targetId);
  const unreviewedTargets = [...findings.values()]
    .filter((finding) => finding.status === 'unreviewed')
    .map((finding) => finding.targetId);
  const notApplicableTargets = [...findings.values()]
    .filter((finding) => finding.status === 'not_applicable')
    .map((finding) => finding.targetId);
  const readyForSemanticRepair =
    uncoveredByComponent.length === 0 &&
    missingTargets.length === 0 &&
    unreviewedTargets.length === 0;

  return {
    format: 'tailfin-meshy-semantic-review-assessment' as const,
    formatVersion: 1 as const,
    algorithm: 'explicit-component-local-triangle-dispositions-v1' as const,
    reviewSha256: sha256(canonicalJson(review)),
    reviewOperationId: review.operationId,
    reviewedAt: review.reviewedAt,
    reviewedBy: review.reviewedBy,
    derivativeSha256: inventory.derivativeSha256,
    inventoryReportSha256,
    state: 'quarantine' as const,
    semanticAssignmentsMade: review.dispositions.length > 0,
    readyForSemanticRepair,
    runtimeAdmission: 'not-reviewed' as const,
    liveryReady: false,
    dispositionTriangleCounts: Object.fromEntries(
      [...dispositionCounts].sort(([a], [b]) => a.localeCompare(b)),
    ),
    discardedTriangles,
    uncoveredByComponent,
    missingTargets,
    unreviewedTargets,
    notApplicableTargets,
    blockingReasons: [
      ...(uncoveredByComponent.length
        ? ['Every retained source triangle needs one disposition.']
        : []),
      ...(missingTargets.length
        ? ['Missing required geometry must be modeled before semantic repair.']
        : []),
      ...(unreviewedTargets.length
        ? ['Every semantic target requires explicit human review.']
        : []),
      'This assessment does not perform topology repair, generate geometry or admit an asset.',
    ],
    creditsSpentByThisCommand: 0,
  };
}
