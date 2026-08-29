import { join } from 'node:path';

import { canonicalJson, sha256 } from './canonical';
import { readMeshyArtifact, savedMeshyArchive, writeImmutableMeshyArtifact } from './meshy-archive';
import { auditMeshyGeometry } from './meshy-geometry';
import { type MeshyRunStore } from './meshy-store';

/** Read and recheck the actual bytes consumed by offline geometry tooling. */
export function readArchivedMeshyGeometry(
  store: MeshyRunStore,
  archiveRoot: string,
  operation: string,
) {
  const archive = savedMeshyArchive(archiveRoot, operation, store.read());
  if (!archive) throw new Error('An immutable successful export is required for geometry review.');
  const source = readMeshyArtifact(
    join(archiveRoot, `${archive.untouchedExport.sha256}.glb`),
    archive.untouchedExport.bytes,
  );
  // Recheck the bytes actually analysed, not just the earlier archive lookup.
  if (
    source.length !== archive.untouchedExport.bytes ||
    sha256(source) !== archive.untouchedExport.sha256
  )
    throw new Error('Geometry review source differs from the immutable export.');
  return { archive, source };
}

/** Offline report over one already archived task; never changes ledger or source. */
export function reportMeshyGeometry(store: MeshyRunStore, archiveRoot: string, operation: string) {
  const { archive, source } = readArchivedMeshyGeometry(store, archiveRoot, operation);
  const report = {
    ...auditMeshyGeometry(source),
    operationId: archive.task.operationId,
    taskId: archive.task.taskId,
    approvalSha256: archive.approvalSha256,
    specSha256: archive.specSha256,
  };
  const bytes = Buffer.from(canonicalJson(report));
  writeImmutableMeshyArtifact(join(archiveRoot, `${operation}-geometry-v1.json`), bytes);
  return { operationId: operation, reportSha256: sha256(bytes), report };
}
