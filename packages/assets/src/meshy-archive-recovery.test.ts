import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256 } from './canonical';
import { MeshyGenerationSpec, meshySpecIdentity } from './meshy';
import { meshyArchiveDirectory, writeImmutableMeshyArtifact } from './meshy-archive';
import {
  archiveRetextureDryRunReport,
  createArchiveRetextureRequest,
  loadArchiveRetextureSource,
  MESHY_ARCHIVE_RETEXTURE_CREDITS,
} from './meshy-archive-recovery';
import { meshyRunApprovalIdentity } from './meshy-run';
import { MeshyRunStore } from './meshy-store';

const spec = MeshyGenerationSpec.parse({
  format: 'tailfin-meshy-generation-spec',
  formatVersion: 1,
  id: 'a320neo-t2-v1',
  aircraftAssetId: 'a320neo',
  referencePrompt: 'neutral aircraft',
  generation: {
    model_type: 'smart-topology',
    ai_model: 'meshy-t2',
    target_polycount: 15000,
    should_texture: false,
    target_formats: ['glb'],
  },
  candidateCount: 4,
  retexture: {
    ai_model: 'meshy-7',
    enable_pbr: true,
    enable_original_uv: false,
    texture_resolution: '4k',
    text_style_prompt: 'neutral source PBR',
  },
  pricing: {
    snapshotId: 'meshy-api-2026-08-28',
    observedAt: '2026-08-28',
    source: 'https://docs.meshy.ai/en/api/pricing',
    untexturedCandidateCredits: 5,
    selectedRetextureCredits: 10,
  },
});

function glb(): Buffer {
  const bytes = Buffer.alloc(48, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(28, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.write('{"asset":{"version":"2.0"}}', 20);
  return bytes;
}

const time = '2026-09-01T18:40:00.000Z';
const runApproval = {
  format: 'tailfin-meshy-run-approval',
  formatVersion: 1,
  runId: 'a320neo-first-run',
  specSha256: meshySpecIdentity(spec),
  maxCredits: 40,
  recordedAt: time,
  authority: 'explicit-user-confirmation',
  evidence: { taskId: '00000000-0000-4000-8000-000000000001', confirmationSha256: 'a'.repeat(64) },
  scope: 'four-t2-candidates-and-one-selected-4k-retexture',
  fallbackApproved: false,
  productionPublicationApproved: false,
};
let temporaryRoot: string | undefined;
afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe('archive-backed Meshy retexture preflight', () => {
  it('uses immutable local GLB bytes and enforces the aggregate 50-credit ceiling', () => {
    const bytes = glb();
    const request = createArchiveRetextureRequest(spec, 30, { bytes, sha256: sha256(bytes) }, 50);

    expect(request).toMatchObject({
      originalExposure: 30,
      recoveryReservation: MESHY_ARCHIVE_RETEXTURE_CREDITS,
      aggregateExposure: 40,
      totalCreditCeiling: 50,
    });
    expect(request.body).toMatch(/"enable_original_uv": true/);
    expect(request.body).toMatch(/"enable_pbr": true/);
    expect(request.body).toContain('"target_formats"');
    expect(request.body).toContain('"glb"');
    expect(request.body).toContain('data:application/octet-stream;base64,');
    expect(archiveRetextureDryRunReport(request)).not.toHaveProperty('body');
  });

  it('rejects tampered source bytes and aggregate budget overruns', () => {
    const bytes = glb();
    expect(() =>
      createArchiveRetextureRequest(spec, 30, { bytes, sha256: 'a'.repeat(64) }, 50),
    ).toThrow('digest');
    expect(() =>
      createArchiveRetextureRequest(spec, 41, { bytes, sha256: sha256(bytes) }, 50),
    ).toThrow('Aggregate');
  });

  it('loads only the selected candidate archive, not a provider URL or arbitrary path', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'tailfin-archive-source-'));
    const database = join(temporaryRoot, 'run.sqlite');
    const store = new MeshyRunStore(database);
    const approval = { ...runApproval, specSha256: meshySpecIdentity(spec) };
    store.initialize(approval, spec);
    for (let index = 1; index <= 4; index += 1) {
      const operationId = `candidate-${index}` as 'candidate-1';
      const taskId = `00000000-0000-4000-8000-00000000000${index}`;
      store.reserveCandidate(spec, 40, operationId, String(index).repeat(64));
      store.observe({
        operationId,
        taskId,
        status: index === 1 ? 'SUCCEEDED' : 'FAILED',
        consumedCredits: index === 1 ? 5 : 0,
        observedAt: time,
      });
    }
    const selectedTaskId = '00000000-0000-4000-8000-000000000001';
    store.select(selectedTaskId, 'f'.repeat(64));
    const state = store.read();
    const bytes = glb();
    const digest = sha256(bytes);
    const archiveRoot = meshyArchiveDirectory(database);
    writeImmutableMeshyArtifact(join(archiveRoot, `${digest}.glb`), bytes);
    writeImmutableMeshyArtifact(
      join(archiveRoot, 'candidate-1.json'),
      Buffer.from(
        JSON.stringify({
          format: 'tailfin-meshy-candidate-export',
          formatVersion: 1,
          state: 'quarantine',
          approvalSha256: meshyRunApprovalIdentity(state.approval),
          specSha256: state.approval.specSha256,
          requestSha256: '1'.repeat(64),
          task: state.tasks[0],
          createdAt: time,
          finishedAt: time,
          expiresAt: '2026-09-04T18:40:00.000Z',
          untouchedExport: { sha256: digest, bytes: bytes.length, mediaType: 'model/gltf-binary' },
          evidenceComplete: false,
          runtimeAdmission: 'not-reviewed',
        }),
      ),
    );

    expect(loadArchiveRetextureSource(archiveRoot, state)).toMatchObject({
      taskId: selectedTaskId,
      sha256: digest,
      bytes,
    });
  });
});
