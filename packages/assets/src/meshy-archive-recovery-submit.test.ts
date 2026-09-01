import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256 } from './canonical';
import { MeshyGenerationSpec, meshyCreditExposure, meshySpecIdentity } from './meshy';
import { meshyArchiveDirectory, writeImmutableMeshyArtifact } from './meshy-archive';
import {
  MeshyArchiveRecoveryApproval,
  MeshyArchiveRecoveryStore,
} from './meshy-archive-recovery-store';
import { submitArchiveMeshyRetexture } from './meshy-archive-recovery-submit';
import { meshyEvidenceDirectory } from './meshy-evidence';
import { meshyRunApprovalIdentity } from './meshy-run';
import { MeshyRunStore } from './meshy-store';

const time = '2026-09-01T18:40:00.000Z';
const credential = 'msy_SYNTHETIC_TEST_ONLY';
const taskId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
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

let root: string;
let original: MeshyRunStore;
let recovery: MeshyArchiveRecoveryStore;
let archiveRoot: string;
let evidenceRoot: string;
let pricing: Record<string, unknown>;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tailfin-meshy-archive-submit-'));
  const database = join(root, 'run.sqlite');
  original = new MeshyRunStore(database);
  archiveRoot = meshyArchiveDirectory(database);
  evidenceRoot = meshyEvidenceDirectory(database);
  original.initialize(
    {
      format: 'tailfin-meshy-run-approval',
      formatVersion: 1,
      runId: 'a320neo-first-run',
      specSha256: meshySpecIdentity(spec),
      maxCredits: 40,
      recordedAt: time,
      authority: 'explicit-user-confirmation',
      evidence: { taskId: taskId(99), confirmationSha256: 'a'.repeat(64) },
      scope: 'four-t2-candidates-and-one-selected-4k-retexture',
      fallbackApproved: false,
      productionPublicationApproved: false,
    },
    spec,
  );
  for (let index = 1; index <= 4; index += 1) {
    const operationId = `candidate-${index}` as 'candidate-1';
    original.reserveCandidate(spec, 40, operationId, String(index).repeat(64));
    original.observe({
      operationId,
      taskId: taskId(index),
      status: index === 1 ? 'SUCCEEDED' : 'FAILED',
      consumedCredits: index === 1 ? 5 : 0,
      observedAt: time,
    });
  }
  original.select(taskId(1), 'f'.repeat(64));
  original.reserve(spec, 40, 'retexture-selected', 'b'.repeat(64));
  const source = glb();
  const sourceSha256 = sha256(source);
  writeImmutableMeshyArtifact(join(archiveRoot, `${sourceSha256}.glb`), source);
  const state = original.read();
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
        untouchedExport: {
          sha256: sourceSha256,
          bytes: source.length,
          mediaType: 'model/gltf-binary',
        },
        evidenceComplete: false,
        runtimeAdmission: 'not-reviewed',
      }),
    ),
  );
  recovery = new MeshyArchiveRecoveryStore(join(root, 'recovery.sqlite'));
  recovery.initialize(
    MeshyArchiveRecoveryApproval.parse({
      format: 'tailfin-meshy-archive-recovery-approval',
      formatVersion: 1,
      runId: 'a320neo-archive-retexture-recovery-v1',
      authority: 'explicit-user-confirmation',
      recordedAt: time,
      confirmationSha256: 'c'.repeat(64),
      originalRunApprovalSha256: meshyRunApprovalIdentity(state.approval),
      originalRetainedExposure: meshyCreditExposure(state.budget),
      totalCreditCeiling: 50,
      recoveryReservation: 10,
      source: { taskId: taskId(1), exportSha256: sourceSha256, exportBytes: source.length },
      scope: 'one-archive-backed-4k-pbr-retexture-only',
      productionPublicationApproved: false,
    }),
  );
  const pricingBytes = Buffer.from('<html>4K PBR retexture costs 10 credits.</html>');
  const snapshotFile = join(root, 'pricing.html');
  await writeFile(snapshotFile, pricingBytes);
  pricing = {
    format: 'tailfin-meshy-pricing-review',
    formatVersion: 1,
    source: 'https://docs.meshy.ai/en/api/pricing',
    reviewedAt: time,
    reviewedBy: 'local-operator',
    untexturedCandidateCredits: 5,
    selectedRetextureCredits: 10,
    snapshot: { sha256: sha256(pricingBytes), bytes: pricingBytes.length, mediaType: 'text/html' },
    snapshotFile,
  };
  fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
    if (init?.method === 'POST') {
      expect(recovery.read().reservation).not.toBeNull();
      return Promise.resolve(
        new Response(JSON.stringify({ result: taskId(10) }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ balance: 1135 }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const submit = () =>
  submitArchiveMeshyRetexture(
    original,
    recovery,
    evidenceRoot,
    archiveRoot,
    spec,
    pricing,
    credential,
    {
      fetch,
      now: () => new Date(time),
      pause: () => Promise.resolve(),
    },
  );
const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('archive-backed Meshy retexture submission', () => {
  it('reserves before its exact one POST and records only redacted output', async () => {
    await expect(submit()).resolves.toMatchObject({
      taskId: taskId(10),
      reservedCredits: 10,
      productionPublicationApproved: false,
    });
    expect(posts()).toHaveLength(1);
    const post = posts()[0]![1]!;
    expect(post).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(post.body as string)).toMatchObject({
      enable_original_uv: true,
      enable_pbr: true,
      texture_resolution: '4k',
    });
    expect(recovery.read()).toMatchObject({
      reservation: { reservedCredits: 10 },
      task: { taskId: taskId(10), status: 'PENDING' },
    });
  });

  it('retains an ambiguous reservation and refuses a second paid attempt', async () => {
    fetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ balance: 1135 }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    fetch.mockImplementationOnce(() => Promise.reject(new Error('network uncertain')));
    await expect(submit()).rejects.toMatchObject({
      code: 'submission-uncertain',
    });
    expect(posts()).toHaveLength(1);
    const callsBeforeRetry = fetch.mock.calls.length;
    await expect(submit()).rejects.toMatchObject({
      code: 'preflight-refused',
    });
    expect(fetch.mock.calls).toHaveLength(callsBeforeRetry);
  });

  it('refuses insufficient balance before reservation or POST', async () => {
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ balance: 49 }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(submit()).rejects.toMatchObject({
      code: 'preflight-refused',
    });
    expect(recovery.read().reservation).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('refuses a source binding mismatch before provider access', async () => {
    const state = recovery.read();
    const replacement = new MeshyArchiveRecoveryStore(join(root, 'mismatch.sqlite'));
    replacement.initialize({
      ...state.approval,
      source: { ...state.approval.source, exportSha256: 'd'.repeat(64) },
    });
    await expect(
      submitArchiveMeshyRetexture(
        original,
        replacement,
        evidenceRoot,
        archiveRoot,
        spec,
        pricing,
        credential,
        { fetch, now: () => new Date(time), pause: () => Promise.resolve() },
      ),
    ).rejects.toMatchObject({ code: 'preflight-refused' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
