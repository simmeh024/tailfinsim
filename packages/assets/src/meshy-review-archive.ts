import { join } from 'node:path';

import { validateBytes, version } from 'gltf-validator';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readArchivedMeshyGeometry } from './meshy-geometry-report';
import { prepareMeshyReview } from './meshy-review';
import { type MeshyRunStore } from './meshy-store';

/** Offline derived evidence; no credit, selection, registry or admission mutation. */
export async function archiveMeshyReview(
  store: MeshyRunStore,
  archiveRoot: string,
  operation: string,
) {
  const { archive, source } = readArchivedMeshyGeometry(store, archiveRoot, operation);
  const { glb, report: prepared } = prepareMeshyReview(source);
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
    throw new Error('Review derivative failed glTF conformance; no review artifacts sealed.');
  const report = {
    ...prepared,
    operationId: archive.task.operationId,
    taskId: archive.task.taskId,
    approvalSha256: archive.approvalSha256,
    specSha256: archive.specSha256,
    gltfConformance: { validatorVersion: version(), errors: 0, warnings: 0 },
    // Conformance is the only admission-independent check completed here.
    pendingChecks: prepared.pendingChecks.filter((check) => check !== 'official-gltf-conformance'),
  };
  const bytes = Buffer.from(canonicalJson(report));
  if (bytes.length > 8 * 1024 * 1024)
    throw new Error('Review evidence exceeds its bounded profile.');
  // Completion marker last. Interrupted runs can resume; no existing artifact is overwritten.
  writeImmutableMeshyArtifact(join(archiveRoot, `review-${sha256(glb)}.glb`), glb);
  writeImmutableMeshyArtifact(join(archiveRoot, `${operation}-review-v1.json`), bytes);
  return { operationId: operation, reportSha256: sha256(bytes), report };
}
