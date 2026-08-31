import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { archiveMeshySemanticRepairPlan } from './meshy-semantic-repair-plan-archive';
import { assessMeshySemanticResidualReview } from './meshy-semantic-residual-review';

const directories: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const digest = (character: string) => character.repeat(64);

describe('semantic repair plan archive', () => {
  it('verifies the sealed review chain and writes one immutable repair plan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tailfin-repair-plan-'));
    directories.push(directory);
    const residual = {
      format: 'tailfin-meshy-semantic-residual-topology',
      formatVersion: 1,
      operationId: 'candidate-1',
      assessmentSha256: digest('a'),
      reviewSourceSha256: digest('b'),
      inventoryReportSha256: digest('c'),
      derivativeSha256: digest('d'),
      state: 'quarantine',
      residualTriangles: 2,
      residualPatches: [
        {
          patchId: 'residual_patch_001',
          componentId: 'review_component_002',
          triangles: 2,
          componentLocalTriangleRanges: [{ startInclusive: 3, endExclusive: 5 }],
        },
      ],
    };
    const residualBytes = Buffer.from(canonicalJson(residual));
    const residualSha256 = sha256(residualBytes);
    const review = {
      format: 'tailfin-meshy-semantic-residual-review',
      formatVersion: 1,
      operationId: 'candidate-1',
      residualReportSha256: residualSha256,
      reviewedAt: '2026-08-31T12:00:00.000Z',
      reviewedBy: 'Test reviewer',
      decisions: [
        {
          patchId: 'residual_patch_001',
          resolution: 'repair_into_new_derivative',
          rationale: 'This patch crosses a surface boundary and requires explicit remodeling.',
          evidenceViews: ['tail'],
        },
      ],
      notes: [],
    };
    const reviewBytes = Buffer.from(canonicalJson(review));
    const reviewSha256 = sha256(reviewBytes);
    const assessment = {
      ...assessMeshySemanticResidualReview(review, residual, residualSha256),
      residualReviewSourceSha256: reviewSha256,
    };
    const assessmentBytes = Buffer.from(canonicalJson(assessment));
    const assessmentSha256 = sha256(assessmentBytes);
    await Promise.all([
      writeFile(
        join(directory, `semantic-residual-topology-${residualSha256}.json`),
        residualBytes,
      ),
      writeFile(
        join(directory, `semantic-residual-review-source-${reviewSha256}.json`),
        reviewBytes,
      ),
      writeFile(
        join(directory, `semantic-residual-review-assessment-${assessmentSha256}.json`),
        assessmentBytes,
      ),
    ]);

    const archived = await archiveMeshySemanticRepairPlan(
      directory,
      'candidate-1',
      assessmentSha256,
    );

    expect(archived.plan).toMatchObject({
      sourceDerivativeSha256: digest('d'),
      repairDerivativeRequired: true,
      repairComplete: false,
    });
    expect(
      sha256(await readFile(join(directory, `semantic-repair-plan-${archived.planSha256}.json`))),
    ).toBe(archived.planSha256);
  });
});
