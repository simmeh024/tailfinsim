import { join } from 'node:path';

import { validateBytes, version } from 'gltf-validator';
import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { correctA320neoProportions } from './meshy-correction';
import { readArchivedMeshyGeometry } from './meshy-geometry-report';
import { readBoundedMeshyBytes, readBoundedMeshyInput } from './meshy-preflight';
import { type MeshyRunStore } from './meshy-store';

const Point = z.tuple([z.number(), z.number(), z.number()]);
const FrameReport = z
  .object({
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    prerequisiteDerivativeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceToCanonicalAxisMatrix: z.tuple([Point, Point, Point]),
    eligibleForCanonicalTransform: z.literal(false),
    state: z.literal('quarantine'),
  })
  .passthrough();

/** Immutable, zero-credit correction derivative; never admits or overwrites the candidate. */
export async function archiveMeshyCorrection(
  store: MeshyRunStore,
  archiveRoot: string,
  operation: string,
) {
  const { archive, source } = readArchivedMeshyGeometry(store, archiveRoot, operation);
  const framePath = join(archiveRoot, `${operation}-frame-v1.json`);
  const frameBytes = Buffer.from(await readBoundedMeshyInput(framePath, 8 * 1024 * 1024));
  const frame = FrameReport.parse(JSON.parse(frameBytes.toString('utf8')) as unknown);
  if (frame.sourceSha256 !== sha256(source)) throw new Error('Frame source identity changed.');
  const reviewPath = join(archiveRoot, `review-${frame.prerequisiteDerivativeSha256}.glb`);
  const review = await readBoundedMeshyBytes(reviewPath, 64 * 1024 * 1024);
  if (sha256(review) !== frame.prerequisiteDerivativeSha256)
    throw new Error('Review derivative identity changed.');
  const { glb, report: prepared } = correctA320neoProportions(
    review,
    frame.sourceToCanonicalAxisMatrix,
  );
  const conformance = await validateBytes(glb, {
    writeTimestamp: false,
    maxIssues: 32,
    externalResourceFunction: () => Promise.reject(new Error('External resources forbidden.')),
  });
  if (
    conformance.issues.numErrors ||
    conformance.issues.numWarnings ||
    conformance.issues.truncated
  )
    throw new Error('Correction derivative failed glTF conformance.');
  const report = {
    ...prepared,
    operationId: operation,
    taskId: archive.task.taskId,
    sourceSha256: sha256(source),
    frameReportSha256: sha256(frameBytes),
    approvalSha256: archive.approvalSha256,
    specSha256: archive.specSha256,
    gltfConformance: { validatorVersion: version(), errors: 0, warnings: 0 },
    creditsSpentByThisCommand: 0,
  };
  const bytes = Buffer.from(canonicalJson(report));
  if (bytes.length > 1024 * 1024) throw new Error('Correction evidence exceeds its bound.');
  writeImmutableMeshyArtifact(join(archiveRoot, `correction-${sha256(glb)}.glb`), glb);
  writeImmutableMeshyArtifact(join(archiveRoot, `${operation}-correction-v1.json`), bytes);
  return { operationId: operation, reportSha256: sha256(bytes), report };
}
