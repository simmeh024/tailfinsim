import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { auditMeshyGeometry, decodeMeshyGeometry } from './meshy-geometry';
import { MESHY_SEMANTIC_TARGETS } from './meshy-semantic-inventory';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const SemanticTarget = z.enum(MESHY_SEMANTIC_TARGETS.map(([id]) => id));
const ScaffoldReport = z
  .object({
    format: z.literal('tailfin-meshy-semantic-repair-scaffold'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    sourceDerivativeSha256: Digest,
    scaffoldDerivativeSha256: Digest,
    repairNodes: z.array(
      z.object({ nodeId: z.string(), patchIds: z.array(z.string()).min(1) }).passthrough(),
    ),
    missingTargets: z.array(SemanticTarget),
    state: z.literal('quarantine'),
    authoringComplete: z.literal(false),
    repairComplete: z.literal(false),
  })
  .passthrough();

export const MeshySemanticRepairSubmission = z
  .object({
    format: z.literal('tailfin-meshy-semantic-repair-submission'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    scaffoldReportSha256: Digest,
    authoredDerivativeSha256: Digest,
    authoredAt: z.iso.datetime({ offset: true }),
    authoredBy: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/),
    dcc: z.object({ name: z.string().min(2).max(80), version: z.string().min(1).max(40) }).strict(),
    repairResolutions: z
      .array(
        z
          .object({
            sourceRepairNodeId: z.string().min(1).max(128),
            status: z.literal('replaced_or_retopologized'),
            rationale: z.string().min(12).max(500),
          })
          .strict(),
      )
      .max(64),
    targetEvidence: z
      .array(
        z
          .object({
            targetId: SemanticTarget,
            authoring: z.enum(['geometry', 'canonical_mask']),
            nodeName: z.string().min(1).max(128).optional(),
          })
          .strict(),
      )
      .max(MESHY_SEMANTIC_TARGETS.length),
    notes: z.array(z.string().min(1).max(500)).max(64).default([]),
  })
  .strict();

/** Validate a DCC export as new quarantine evidence; never declares technical or visual approval. */
export function assessMeshySemanticRepairSubmission(
  authoredDerivative: Uint8Array,
  scaffoldReportInput: unknown,
  scaffoldReportSha256: string,
  submissionInput: unknown,
) {
  const scaffold = ScaffoldReport.parse(scaffoldReportInput);
  if (sha256(Buffer.from(canonicalJson(scaffold))) !== Digest.parse(scaffoldReportSha256))
    throw new Error('Repair intake scaffold report identity changed.');
  const submission = MeshySemanticRepairSubmission.parse(submissionInput);
  const authoredDerivativeSha256 = sha256(authoredDerivative);
  if (
    submission.operationId !== scaffold.operationId ||
    submission.scaffoldReportSha256 !== scaffoldReportSha256 ||
    submission.authoredDerivativeSha256 !== authoredDerivativeSha256
  )
    throw new Error('Repair intake submission identity changed.');
  if (
    [scaffold.sourceDerivativeSha256, scaffold.scaffoldDerivativeSha256].includes(
      authoredDerivativeSha256,
    )
  )
    throw new Error('Repair intake requires a distinct authored derivative.');

  const geometry = decodeMeshyGeometry(authoredDerivative);
  const nodeNames = geometry.parts.map((part) => part.name);
  if (
    nodeNames.some((name) => !name || name.startsWith('repair__')) ||
    new Set(nodeNames).size !== nodeNames.length
  )
    throw new Error('Repair intake requires unique resolved semantic node names.');
  const targets = new Set<string>(MESHY_SEMANTIC_TARGETS.map(([id]) => id));
  if (nodeNames.some((name) => !targets.has(name!)))
    throw new Error('Repair intake contains an unknown semantic node.');

  const repairIds = scaffold.repairNodes.map((node) => node.nodeId);
  if (
    submission.repairResolutions.length !== repairIds.length ||
    new Set(submission.repairResolutions.map((entry) => entry.sourceRepairNodeId)).size !==
      repairIds.length ||
    repairIds.some(
      (id) => !submission.repairResolutions.some((entry) => entry.sourceRepairNodeId === id),
    )
  )
    throw new Error('Repair intake must resolve every scaffold repair node exactly once.');

  const evidence = new Map<string, (typeof submission.targetEvidence)[number]>();
  for (const entry of submission.targetEvidence) {
    if (evidence.has(entry.targetId))
      throw new Error('Repair intake repeats semantic target evidence.');
    if (
      entry.authoring === 'canonical_mask' &&
      !['doors_left', 'doors_right'].includes(entry.targetId)
    )
      throw new Error('Only door targets may use canonical-mask evidence.');
    if (
      (entry.authoring === 'geometry') !== (entry.nodeName !== undefined) ||
      (entry.nodeName && entry.nodeName !== entry.targetId)
    )
      throw new Error('Repair intake geometry evidence must bind its canonical node name.');
    evidence.set(entry.targetId, entry);
  }
  for (const [targetId, , , required] of MESHY_SEMANTIC_TARGETS) {
    if (!required) continue;
    const entry = evidence.get(targetId);
    if (!entry) throw new Error('Repair intake lacks required semantic target evidence.');
    if (entry.authoring === 'geometry' && !nodeNames.includes(targetId))
      throw new Error('Repair intake evidence names missing semantic geometry.');
    if (entry.authoring === 'canonical_mask' && nodeNames.includes(targetId))
      throw new Error('Repair intake target cannot be both geometry and mask-only.');
  }

  const audit = auditMeshyGeometry(authoredDerivative);
  const [span, , length] = audit.metrics.boundsSourceUnits.extent;
  const ground = audit.metrics.boundsSourceUnits.min[1]!;
  if (Math.abs(span! - 35.8) > 0.1 || Math.abs(length! - 37.57) > 0.1 || Math.abs(ground) > 0.02)
    throw new Error('Repair intake changed the canonical dimensions or ground reference.');
  return {
    format: 'tailfin-meshy-semantic-repair-intake-assessment' as const,
    formatVersion: 1 as const,
    operationId: scaffold.operationId,
    scaffoldReportSha256,
    authoredDerivativeSha256,
    authoredBy: submission.authoredBy,
    authoredAt: submission.authoredAt,
    dcc: submission.dcc,
    allRepairNodesResolved: true as const,
    allRequiredTargetsEvidenced: true as const,
    canonicalDimensionsRetained: true as const,
    geometryMetrics: audit.metrics,
    state: 'quarantine' as const,
    structuralIntakePassed: true as const,
    technicalReviewPassed: false as const,
    visualReviewPassed: false as const,
    licensingReviewPassed: false as const,
    repairComplete: false as const,
    runtimeAdmission: 'not-reviewed' as const,
    liveryReady: false as const,
    creditsSpentByThisCommand: 0 as const,
  };
}
