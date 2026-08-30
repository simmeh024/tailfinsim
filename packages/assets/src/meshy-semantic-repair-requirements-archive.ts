import { join } from 'node:path';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readBoundedMeshyInput } from './meshy-preflight';
import { createMeshySemanticRepairRequirements } from './meshy-semantic-repair-requirements';

/** Seal deterministic repair obligations derived from one immutable semantic assessment. */
export async function archiveMeshySemanticRepairRequirements(
  archiveRoot: string,
  operation: string,
  assessmentSha256: string,
) {
  const assessmentPath = join(archiveRoot, `semantic-review-assessment-${assessmentSha256}.json`);
  const assessmentBytes = Buffer.from(await readBoundedMeshyInput(assessmentPath, 1024 * 1024));
  if (sha256(assessmentBytes) !== assessmentSha256)
    throw new Error('Semantic review assessment identity changed.');
  const requirements = createMeshySemanticRepairRequirements(
    JSON.parse(assessmentBytes.toString('utf8')) as unknown,
    assessmentSha256,
  );
  if (requirements.operationId !== operation)
    throw new Error('Semantic repair requirements operation does not match the candidate.');
  const bytes = Buffer.from(canonicalJson(requirements));
  if (bytes.length > 256 * 1024)
    throw new Error('Semantic repair requirements exceed their bound.');
  const requirementsSha256 = sha256(bytes);
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-repair-requirements-${requirementsSha256}.json`),
    bytes,
  );
  return { operationId: operation, requirementsSha256, requirements };
}
