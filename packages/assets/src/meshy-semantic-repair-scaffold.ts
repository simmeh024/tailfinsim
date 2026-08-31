import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { buildFlatMeshyParts } from './meshy-correction';
import { decodeMeshyGeometry } from './meshy-geometry';
import { MESHY_SEMANTIC_TARGETS } from './meshy-semantic-inventory';
import { MeshySemanticReview } from './meshy-semantic-review';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Range = z
  .object({
    startInclusive: z.number().int().nonnegative(),
    endExclusive: z.number().int().positive(),
  })
  .strict();
const Patch = z
  .object({
    patchId: z.string().min(1).max(128),
    triangles: z.number().int().positive(),
    resolution: z.enum([
      'assign_existing_geometry',
      'discard_artifact',
      'repair_into_new_derivative',
    ]),
    semanticTargetId: z.string().optional(),
    componentLocalTriangleRanges: z.array(Range).min(1),
  })
  .strict();
export const MeshySemanticRepairPlan = z
  .object({
    format: z.literal('tailfin-meshy-semantic-repair-plan'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    sourceDerivativeSha256: Digest,
    residualReportSha256: Digest,
    residualReviewAssessmentSha256: Digest,
    residualReviewSha256: Digest,
    state: z.literal('quarantine'),
    componentPlans: z.array(
      z.object({ componentId: z.string(), patches: z.array(Patch) }).passthrough(),
    ),
  })
  .passthrough();

type Point = readonly [number, number, number];

/**
 * Repackages reviewed source faces into semantic and unresolved-repair nodes for DCC work.
 * No vertices are moved and no missing geometry is invented.
 */
export function createMeshySemanticRepairScaffold(
  derivativeBytes: Uint8Array,
  reviewInput: unknown,
  planInput: unknown,
  planSha256: string,
) {
  const review = MeshySemanticReview.parse(reviewInput);
  const plan = MeshySemanticRepairPlan.parse(planInput);
  if (
    sha256(derivativeBytes) !== plan.sourceDerivativeSha256 ||
    review.derivativeSha256 !== plan.sourceDerivativeSha256
  )
    throw new Error('Repair scaffold source derivative identity changed.');
  if (sha256(Buffer.from(canonicalJson(plan))) !== Digest.parse(planSha256))
    throw new Error('Repair scaffold plan identity changed.');
  if (review.operationId !== plan.operationId)
    throw new Error('Repair scaffold operation identity changed.');

  const geometry = decodeMeshyGeometry(derivativeBytes);
  const parts = new Map(geometry.parts.map((part) => [part.name, part]));
  const allocations = new Map<string, (string | undefined)[]>();
  for (const part of geometry.parts)
    allocations.set(
      part.name!,
      Array.from<string | undefined>({ length: part.triangleCount }).fill(undefined),
    );
  const allocate = (
    componentId: string,
    ranges: { startInclusive: number; endExclusive: number }[],
    bucket: string,
  ) => {
    const slots = allocations.get(componentId);
    if (!slots) throw new Error('Repair scaffold references an unknown source component.');
    for (const range of ranges) {
      if (range.endExclusive > slots.length || range.endExclusive <= range.startInclusive)
        throw new Error('Repair scaffold range is outside its source component.');
      for (let triangle = range.startInclusive; triangle < range.endExclusive; triangle++) {
        if (slots[triangle] !== undefined)
          throw new Error('Repair scaffold source coverage overlaps.');
        slots[triangle] = bucket;
      }
    }
  };

  for (const disposition of review.dispositions)
    allocate(disposition.componentId, disposition.ranges, disposition.targetId);
  const repairNodes: {
    nodeId: string;
    sourceComponentId: string;
    patchIds: string[];
    triangles: number;
  }[] = [];
  for (const component of plan.componentPlans) {
    const repair = {
      nodeId: `repair__${component.componentId}`,
      sourceComponentId: component.componentId,
      patchIds: [] as string[],
      triangles: 0,
    };
    for (const patch of component.patches) {
      const bucket =
        patch.resolution === 'assign_existing_geometry'
          ? patch.semanticTargetId
          : patch.resolution === 'discard_artifact'
            ? 'discarded_artifact'
            : repair.nodeId;
      if (!bucket) throw new Error('Assigned repair patch lacks a semantic target.');
      allocate(component.componentId, patch.componentLocalTriangleRanges, bucket);
      if (patch.resolution === 'repair_into_new_derivative') {
        repair.patchIds.push(patch.patchId);
        repair.triangles += patch.triangles;
      }
    }
    if (repair.patchIds.length) repairNodes.push(repair);
  }
  for (const slots of allocations.values())
    if (slots.some((slot) => slot === undefined))
      throw new Error('Repair scaffold does not cover every source triangle.');

  const buckets = new Map<string, Point[]>();
  for (const [componentId, slots] of allocations) {
    const part = parts.get(componentId)!;
    slots.forEach((bucket, localTriangle) => {
      if (bucket === 'discarded_artifact') return;
      const positions = buckets.get(bucket!) ?? [];
      const globalTriangle = part.triangleStart + localTriangle;
      for (const vertex of geometry.triangles[globalTriangle]!)
        positions.push(geometry.positions[vertex]!);
      buckets.set(bucket!, positions);
    });
  }
  const semanticOrder = new Map<string, number>(
    MESHY_SEMANTIC_TARGETS.map(([id], index) => [id, index]),
  );
  const outputParts = [...buckets]
    .sort(
      ([a], [b]) =>
        (semanticOrder.get(a) ?? 10_000) - (semanticOrder.get(b) ?? 10_000) || a.localeCompare(b),
    )
    .map(([id, positions]) => ({ id, positions }));
  const glb = buildFlatMeshyParts(outputParts, 'Tailfin semantic repair scaffold v1');
  const semanticTriangles = Object.fromEntries(
    outputParts
      .filter((part) => semanticOrder.has(part.id))
      .map((part) => [part.id, part.positions.length / 3]),
  );
  const report = {
    format: 'tailfin-meshy-semantic-repair-scaffold' as const,
    formatVersion: 1 as const,
    operationId: plan.operationId,
    repairPlanSha256: planSha256,
    sourceDerivativeSha256: plan.sourceDerivativeSha256,
    scaffoldDerivativeSha256: sha256(glb),
    state: 'quarantine' as const,
    geometryModified: false,
    sourceTriangles: geometry.triangles.length,
    scaffoldTriangles: outputParts.reduce((sum, part) => sum + part.positions.length / 3, 0),
    semanticTriangles,
    repairNodes,
    missingTargets: review.targetFindings
      .filter((finding) => finding.status === 'missing_requires_modeling')
      .map((finding) => finding.targetId),
    authoringComplete: false,
    repairComplete: false,
    runtimeAdmission: 'not-reviewed' as const,
    liveryReady: false,
    creditsSpentByThisCommand: 0 as const,
  };
  return { glb, report, reportSha256: sha256(canonicalJson(report)) };
}
