import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { archiveMeshySemanticResidualReview } from './meshy-semantic-residual-review-archive';

const archiveResiduals = vi.hoisted(() => vi.fn());
vi.mock('./meshy-semantic-residuals-archive', () => ({
  archiveMeshySemanticResiduals: archiveResiduals,
}));

const temporaryDirectories: string[] = [];
afterEach(async () => {
  archiveResiduals.mockReset();
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const digest = (character: string) => character.repeat(64);
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

describe('semantic residual review archive', () => {
  it('regenerates the evidence chain and writes immutable source and assessment artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tailfin-residual-review-'));
    temporaryDirectories.push(directory);
    const residualBytes = Buffer.from(canonicalJson(residual));
    const residualSha256 = sha256(residualBytes);
    await writeFile(
      join(directory, `semantic-residual-topology-${residualSha256}.json`),
      residualBytes,
    );
    const review = {
      format: 'tailfin-meshy-semantic-residual-review',
      formatVersion: 1,
      operationId: 'candidate-1',
      residualReportSha256: residualSha256,
      reviewedAt: '2026-08-31T02:00:00.000Z',
      reviewedBy: 'Test reviewer',
      decisions: [
        {
          patchId: 'residual_patch_001',
          resolution: 'repair_into_new_derivative',
          rationale: 'The patch crosses multiple surfaces and requires explicit remodeling.',
          evidenceViews: ['tail', 'top'],
        },
      ],
      notes: [],
    };
    const reviewPath = join(directory, 'review.json');
    const reviewBytes = Buffer.from(canonicalJson(review));
    await writeFile(reviewPath, reviewBytes);
    archiveResiduals.mockResolvedValue({ reportSha256: residualSha256, report: residual });

    const archived = await archiveMeshySemanticResidualReview(
      directory,
      'candidate-1',
      residualSha256,
      reviewPath,
    );

    expect(archiveResiduals).toHaveBeenCalledWith(directory, 'candidate-1', digest('a'));
    expect(archived.assessment).toMatchObject({
      residualReportSha256: residualSha256,
      residualReviewSourceSha256: sha256(reviewBytes),
      allPatchesReviewed: true,
      repairComplete: false,
      creditsSpentByThisCommand: 0,
    });
    expect(
      await readFile(
        join(directory, `semantic-residual-review-source-${sha256(reviewBytes)}.json`),
      ),
    ).toEqual(reviewBytes);
    const assessmentBytes = await readFile(
      join(directory, `semantic-residual-review-assessment-${archived.assessmentFileSha256}.json`),
    );
    expect(sha256(assessmentBytes)).toBe(archived.assessmentFileSha256);
  });
});
