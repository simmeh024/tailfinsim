import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { MESHY_SEMANTIC_TARGETS } from './meshy-semantic-inventory';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const PatchId = z.string().regex(/^residual_patch_\d{3,6}$/);
const SemanticTargetId = z.enum(MESHY_SEMANTIC_TARGETS.map(([id]) => id));
const CameraView = z.enum([
  'quarter',
  'left',
  'right',
  'top',
  'underside',
  'nose',
  'tail',
  'winglet_left',
  'winglet_right',
  'tail_close_up',
]);
const cameraOrder = new Map(CameraView.options.map((view, index) => [view, index]));

export const MeshySemanticResidualReview = z
  .object({
    format: z.literal('tailfin-meshy-semantic-residual-review'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    residualReportSha256: Digest,
    reviewedAt: z.iso.datetime({ offset: true }),
    reviewedBy: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/),
    decisions: z
      .array(
        z
          .object({
            patchId: PatchId,
            resolution: z.enum([
              'assign_existing_geometry',
              'discard_artifact',
              'repair_into_new_derivative',
            ]),
            semanticTargetId: SemanticTargetId.optional(),
            rationale: z.string().min(12).max(500),
            evidenceViews: z.array(CameraView).min(1).max(CameraView.options.length),
          })
          .strict()
          .refine(
            (decision) =>
              (decision.resolution === 'assign_existing_geometry') ===
              (decision.semanticTargetId !== undefined),
            { message: 'only existing-geometry assignments require one semantic target' },
          ),
      )
      .min(1)
      .max(100_000),
    notes: z.array(z.string().min(1).max(500)).max(64).default([]),
  })
  .strict();
export type MeshySemanticResidualReview = z.infer<typeof MeshySemanticResidualReview>;

export const MeshySemanticResidualReportSchema = z
  .object({
    format: z.literal('tailfin-meshy-semantic-residual-topology'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    assessmentSha256: Digest,
    reviewSourceSha256: Digest,
    inventoryReportSha256: Digest,
    derivativeSha256: Digest,
    state: z.literal('quarantine'),
    residualTriangles: z.number().int().positive(),
    residualPatches: z
      .array(
        z
          .object({
            patchId: PatchId,
            componentId: z.string().regex(/^review_component_\d{3}$/),
            triangles: z.number().int().positive(),
            componentLocalTriangleRanges: z
              .array(
                z
                  .object({
                    startInclusive: z.number().int().nonnegative(),
                    endExclusive: z.number().int().positive(),
                  })
                  .strict(),
              )
              .min(1)
              .max(4096),
          })
          .passthrough(),
      )
      .min(1)
      .max(100_000),
  })
  .passthrough();
export type MeshySemanticResidualReport = z.infer<typeof MeshySemanticResidualReportSchema>;

/** Validate a complete human decision for every sealed patch without changing geometry. */
export function assessMeshySemanticResidualReview(
  input: unknown,
  residualInput: unknown,
  residualReportSha256: string,
) {
  const parsed = MeshySemanticResidualReview.parse(input);
  const residual = MeshySemanticResidualReportSchema.parse(residualInput);
  const digest = Digest.parse(residualReportSha256);
  if (parsed.operationId !== residual.operationId || parsed.residualReportSha256 !== digest)
    throw new Error('Residual review identity does not match the sealed report.');

  const patches = new Map(residual.residualPatches.map((patch) => [patch.patchId, patch]));
  if (
    patches.size !== residual.residualPatches.length ||
    residual.residualTriangles !==
      residual.residualPatches.reduce((sum, patch) => sum + patch.triangles, 0) ||
    residual.residualPatches.some(
      (patch) =>
        patch.triangles !==
          patch.componentLocalTriangleRanges.reduce(
            (sum, range) => sum + range.endExclusive - range.startInclusive,
            0,
          ) ||
        patch.componentLocalTriangleRanges.some(
          (range, index, ranges) =>
            range.endExclusive <= range.startInclusive ||
            (index > 0 && range.startInclusive < ranges[index - 1]!.endExclusive),
        ),
    )
  )
    throw new Error('Sealed residual patch coverage is invalid.');
  const decisions = new Map<string, MeshySemanticResidualReview['decisions'][number]>();
  for (const decision of parsed.decisions) {
    if (!patches.has(decision.patchId))
      throw new Error('Residual review references an unknown patch.');
    if (decisions.has(decision.patchId))
      throw new Error('Residual review repeats a patch decision.');
    if (new Set(decision.evidenceViews).size !== decision.evidenceViews.length)
      throw new Error('Residual review repeats an evidence view.');
    decisions.set(decision.patchId, decision);
  }
  if (decisions.size !== patches.size)
    throw new Error('Residual review must decide every patch exactly once.');

  const normalized: MeshySemanticResidualReview = {
    ...parsed,
    decisions: residual.residualPatches.map((patch) => {
      const decision = decisions.get(patch.patchId)!;
      return {
        ...decision,
        evidenceViews: [...decision.evidenceViews].sort(
          (a, b) => cameraOrder.get(a)! - cameraOrder.get(b)!,
        ),
      };
    }),
  };
  const triangleCounts = {
    assign_existing_geometry: 0,
    discard_artifact: 0,
    repair_into_new_derivative: 0,
  };
  const patchCounts = { ...triangleCounts };
  for (const decision of normalized.decisions) {
    const patch = patches.get(decision.patchId)!;
    patchCounts[decision.resolution] += 1;
    triangleCounts[decision.resolution] += patch.triangles;
  }

  return {
    format: 'tailfin-meshy-semantic-residual-review-assessment' as const,
    formatVersion: 1 as const,
    algorithm: 'explicit-residual-patch-decisions-v1' as const,
    operationId: residual.operationId,
    residualReportSha256: digest,
    assessmentSha256: residual.assessmentSha256,
    baselineSemanticReviewSha256: residual.reviewSourceSha256,
    inventoryReportSha256: residual.inventoryReportSha256,
    derivativeSha256: residual.derivativeSha256,
    reviewedAt: normalized.reviewedAt,
    reviewedBy: normalized.reviewedBy,
    reviewSha256: sha256(canonicalJson(normalized)),
    state: 'quarantine' as const,
    allPatchesReviewed: true as const,
    repairComplete: false,
    patchCounts,
    triangleCounts,
    requiredActions: [
      ...(patchCounts.assign_existing_geometry
        ? ['Apply authored existing-geometry assignments through a new semantic review.']
        : []),
      ...(patchCounts.discard_artifact
        ? ['Apply authored exclusions through a new semantic review.']
        : []),
      ...(patchCounts.repair_into_new_derivative
        ? ['Author the selected patches only in a new hash-addressed quarantine derivative.']
        : []),
      'Run independent topology, visual, licensing and performance gates before admission.',
    ],
    runtimeAdmission: 'not-reviewed' as const,
    liveryReady: false,
    creditsSpentByThisCommand: 0 as const,
  };
}
