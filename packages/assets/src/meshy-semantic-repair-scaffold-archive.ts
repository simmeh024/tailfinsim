import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { writeImmutableMeshyArtifact } from './meshy-archive';
import { readBoundedMeshyBytes, readBoundedMeshyInput } from './meshy-preflight';
import {
  createMeshySemanticRepairScaffold,
  MeshySemanticRepairPlan,
} from './meshy-semantic-repair-scaffold';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Residual = z
  .object({
    operationId: z.string().regex(/^candidate-[1-4]$/),
    derivativeSha256: Digest,
    reviewSourceSha256: Digest,
  })
  .passthrough();

/** Seal a DCC-ready, geometry-preserving scaffold from the complete reviewed evidence chain. */
export async function archiveMeshySemanticRepairScaffold(
  archiveRoot: string,
  operation: string,
  repairPlanSha256: string,
) {
  const planBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `semantic-repair-plan-${repairPlanSha256}.json`),
      1024 * 1024,
    ),
  );
  if (sha256(planBytes) !== repairPlanSha256)
    throw new Error('Semantic repair plan identity changed.');
  const plan = MeshySemanticRepairPlan.parse(JSON.parse(planBytes.toString('utf8')) as unknown);
  if (plan.operationId !== operation)
    throw new Error('Repair scaffold operation does not match the candidate.');
  const residualBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `semantic-residual-topology-${plan.residualReportSha256}.json`),
      1024 * 1024,
    ),
  );
  if (sha256(residualBytes) !== plan.residualReportSha256)
    throw new Error('Semantic residual report identity changed.');
  const residual = Residual.parse(JSON.parse(residualBytes.toString('utf8')) as unknown);
  if (
    residual.operationId !== operation ||
    residual.derivativeSha256 !== plan.sourceDerivativeSha256
  )
    throw new Error('Repair scaffold residual evidence changed.');
  const reviewBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `semantic-review-source-${residual.reviewSourceSha256}.json`),
      1024 * 1024,
    ),
  );
  if (sha256(reviewBytes) !== residual.reviewSourceSha256)
    throw new Error('Semantic review source identity changed.');
  const derivative = await readBoundedMeshyBytes(
    join(archiveRoot, `correction-${plan.sourceDerivativeSha256}.glb`),
    64 * 1024 * 1024,
  );
  const { glb, report, reportSha256 } = createMeshySemanticRepairScaffold(
    derivative,
    JSON.parse(reviewBytes.toString('utf8')) as unknown,
    plan,
    repairPlanSha256,
  );
  const reportBytes = Buffer.from(canonicalJson(report));
  if (sha256(reportBytes) !== reportSha256)
    throw new Error('Semantic repair scaffold identity changed.');
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-repair-scaffold-${report.scaffoldDerivativeSha256}.glb`),
    glb,
  );
  writeImmutableMeshyArtifact(
    join(archiveRoot, `semantic-repair-scaffold-report-${reportSha256}.json`),
    reportBytes,
  );
  return { operationId: operation, reportSha256, report };
}
