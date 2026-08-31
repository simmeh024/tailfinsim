import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readBoundedMeshyBytes, readBoundedMeshyInput } from './meshy-preflight';
import { assessMeshySemanticRepairSubmission } from './meshy-semantic-repair-intake';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Scaffold = z
  .object({
    operationId: z.string().regex(/^candidate-[1-4]$/),
    scaffoldDerivativeSha256: Digest,
  })
  .passthrough();

/** Preserve an untouched authored export and submission before any independent approval. */
export async function archiveMeshySemanticRepairSubmission(
  archiveRoot: string,
  operation: string,
  scaffoldReportSha256: string,
  derivativeFile: string,
  submissionFile: string,
) {
  const reportBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `semantic-repair-scaffold-report-${scaffoldReportSha256}.json`),
      1024 * 1024,
    ),
  );
  if (sha256(reportBytes) !== scaffoldReportSha256)
    throw new Error('Semantic repair scaffold report identity changed.');
  const reportInput = JSON.parse(reportBytes.toString('utf8')) as unknown;
  const scaffold = Scaffold.parse(reportInput);
  if (scaffold.operationId !== operation)
    throw new Error('Semantic repair submission operation does not match the candidate.');
  const scaffoldBytes = await readBoundedMeshyBytes(
    join(archiveRoot, `semantic-repair-scaffold-${scaffold.scaffoldDerivativeSha256}.glb`),
    64 * 1024 * 1024,
  );
  if (sha256(scaffoldBytes) !== scaffold.scaffoldDerivativeSha256)
    throw new Error('Semantic repair scaffold derivative identity changed.');
  const derivative = await readBoundedMeshyBytes(derivativeFile, 64 * 1024 * 1024);
  const submissionBytes = Buffer.from(await readBoundedMeshyInput(submissionFile, 1024 * 1024));
  const submissionSourceSha256 = sha256(submissionBytes);
  const assessment = {
    ...assessMeshySemanticRepairSubmission(
      derivative,
      reportInput,
      scaffoldReportSha256,
      JSON.parse(submissionBytes.toString('utf8')) as unknown,
    ),
    submissionSourceSha256,
  };
  const assessmentBytes = Buffer.from(canonicalJson(assessment));
  const assessmentSha256 = sha256(assessmentBytes);
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-repair-authored-${assessment.authoredDerivativeSha256}.glb`),
    Buffer.from(derivative),
  );
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-repair-submission-source-${submissionSourceSha256}.json`),
    submissionBytes,
  );
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-repair-intake-assessment-${assessmentSha256}.json`),
    assessmentBytes,
  );
  return { operationId: operation, assessmentSha256, assessment };
}
