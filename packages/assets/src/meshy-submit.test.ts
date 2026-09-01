import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { MeshyGenerationSpec, meshyCreditExposure, meshySpecIdentity } from './meshy';
import { type MeshyAccountDeps } from './meshy-account';
import { meshyArchiveDirectory, syncMeshyCandidate } from './meshy-archive';
import {
  loadMeshyEvidenceJson,
  loadPreparedMeshyEvidence,
  meshArtifactPath,
  meshyEvidenceDirectory,
  prepareMeshyEvidence,
  MeshySubmissionProof,
} from './meshy-evidence';
import { sealMeshyCandidateProvenance } from './meshy-provenance';
import { MeshyRunApproval } from './meshy-run';
import { parseMeshyRunArguments } from './meshy-run-command';
import { MeshyRunStore } from './meshy-store';
import {
  meshRunDiagnostic,
  MeshySubmissionError,
  submitMeshyCandidate,
  submitMeshyRetexture,
} from './meshy-submit';

const spec = MeshyGenerationSpec.parse(
  JSON.parse(
    await readFile(
      new URL('../../../assets/aircraft/generation/a320neo-t2-v1.json', import.meta.url),
      'utf8',
    ),
  ),
);
const time = '2026-08-28T17:00:00.000Z';
const key = 'msy_SYNTHETIC_TEST_ONLY';
const taskId = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const review = {
  reviewedAt: time,
  referenceOrigin: 'original-ai-authored-for-this-task',
  authoringModelVersion: 'not-disclosed-by-tool',
  thirdPartyImageInputs: false,
  neutralUnbrandedGearUp: true,
  bothEnginesVisible: true,
  sensitiveContentIncluded: false,
  referenceUploadScope: 'approved-private-candidate-run',
  paidPlan: 'Pro',
  paidPeriodStart: '2026-08-28',
  paidPeriodEndExclusive: '2026-09-28',
  receiptVisuallyReviewed: true,
  accountEvidence: 'user-supplied-key-and-Pro-receipt',
  nonEnterpriseTrainingAllowanceReviewed: true,
  privateOutputsOnly: true,
  commercialAssetAdmission: 'pending',
  productionPublicationApproved: false,
};
let root: string;
let store: MeshyRunStore;
let database: string;
let evidence: string;
let archive: string;
let input: {
  format: string;
  formatVersion: number;
  review: typeof review;
  files: Record<string, string>;
};
let pricing: {
  format: string;
  formatVersion: number;
  source: string;
  reviewedAt: string;
  reviewedBy: string;
  untexturedCandidateCredits: number;
  selectedRetextureCredits: number;
  snapshot: { sha256: string; bytes: number; mediaType: string };
  snapshotFile: string;
};
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let deps: MeshyAccountDeps;
let reference: Buffer;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tailfin-meshy-submit-'));
  database = join(root, 'run.sqlite');
  store = new MeshyRunStore(database);
  evidence = meshyEvidenceDirectory(database);
  archive = meshyArchiveDirectory(database);
  reference = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const parent = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#aaaaaa' },
  })
    .png()
    .toBuffer();
  const files: Record<string, Buffer> = {
    referenceImage: reference,
    parentImage: parent,
    referencePrompt: Buffer.from('Neutral aircraft, both engines visible.'),
    parentPrompt: Buffer.from('Neutral first reference.'),
    privatePlanEvidence: Buffer.from('%PDF-1.7\nPRIVATE_BILLING_NEVER_UPLOAD'),
    termsSnapshot: Buffer.from('<html>Private terms snapshot</html>'),
    ownershipSnapshot: Buffer.from('<html>Ownership snapshot</html>'),
    consent: Buffer.from('{"approval":"SYNTHETIC forty-credit test consent"}'),
  };
  files.authoringRecord = Buffer.from(
    canonicalJson({
      format: 'tailfin-private-reference-review',
      formatVersion: 1,
      authoring: { thirdPartyImageInputs: false, modelVersion: null },
      versions: [
        {
          sha256: sha256(parent),
          promptSha256: sha256(files.parentPrompt!),
          inputImageSha256: null,
        },
        {
          sha256: sha256(reference),
          promptSha256: sha256(files.referencePrompt!),
          inputImageSha256: sha256(parent),
        },
      ],
    }),
  );
  input = {
    format: 'tailfin-meshy-evidence-import',
    formatVersion: 1,
    review: { ...review },
    files: {},
  };
  for (const [role, bytes] of Object.entries(files)) {
    const path = join(root, `${role}.fixture`);
    await writeFile(path, bytes);
    input.files[role] = path;
  }
  store.initialize(
    MeshyRunApproval.parse({
      format: 'tailfin-meshy-run-approval',
      formatVersion: 1,
      runId: 'a320neo-first-run',
      specSha256: meshySpecIdentity(spec),
      maxCredits: 40,
      recordedAt: time,
      authority: 'explicit-user-confirmation',
      evidence: { taskId: taskId(99), confirmationSha256: sha256(files.consent!) },
      scope: 'four-t2-candidates-and-one-selected-4k-retexture',
      fallbackApproved: false,
      productionPublicationApproved: false,
    }),
    spec,
  );
  const pricingBytes = Buffer.from(
    '<html>T2 untextured 5; retexture 4K PBR 10. Synthetic test snapshot.</html>',
  );
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
  fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((_url, init) =>
      Promise.resolve(
        json(
          init?.method === 'POST'
            ? { result: taskId(store.read().requests.length) }
            : { balance: 1135 },
        ),
      ),
    );
  deps = { fetch, now: () => new Date(time), pause: vi.fn(() => Promise.resolve()) };
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Only the fresh mkdtemp directory created by this test is removed.
  await rm(root, { recursive: true, force: true });
});
const prepare = () => prepareMeshyEvidence(evidence, input, store.read(), spec, new Date(time));
const submit = (operation = 'candidate-1', cap = 40, credential = key) =>
  submitMeshyCandidate(store, evidence, archive, spec, cap, operation, pricing, credential, deps);
const submitRetexture = (cap = 40, credential = key) =>
  submitMeshyRetexture(store, evidence, archive, spec, cap, pricing, credential, deps);
const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
const terminal = (index = 1, status: 'SUCCEEDED' | 'FAILED' | 'CANCELED' = 'FAILED', charge = 0) =>
  store.observe({
    operationId: `candidate-${index}` as 'candidate-1',
    taskId: taskId(index),
    status,
    consumedCredits: charge,
    observedAt: time,
  });

async function establishSelectedCandidate(): Promise<void> {
  await submit('candidate-1');
  terminal(1, 'SUCCEEDED', 5);
  const glb = Buffer.alloc(48, 0x20);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(48, 8);
  glb.writeUInt32LE(28, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  glb.write('{"asset":{"version":"2.0"}}', 20);
  const recoveryFetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      json({
        id: taskId(),
        type: 'image-to-3d',
        status: 'SUCCEEDED',
        consumed_credits: 5,
        created_at: Date.parse(time),
        finished_at: Date.parse(time),
        model_urls: { glb: 'https://assets.meshy.ai/model.glb' },
      }),
    )
    .mockResolvedValueOnce(
      new Response(new Uint8Array(glb), { headers: { 'content-type': 'model/gltf-binary' } }),
    );
  await syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', key, {
    ...deps,
    fetch: recoveryFetch,
  });
  for (let index = 2; index <= 4; index += 1) {
    await submit(`candidate-${index}`);
    terminal(index);
  }
  store.select(taskId(), 'f'.repeat(64));
}

describe('verified private input bundle', () => {
  it('preserves original image and full authoring chain, is immutable and returns no billing contents', async () => {
    const prepared = await prepare();
    expect(await prepare()).toEqual(prepared);
    const loaded = await loadPreparedMeshyEvidence(evidence, store.read(), spec, new Date(time));
    expect(loaded.referenceImage).toEqual(reference);
    expect(loaded.prepared.review.commercialAssetAdmission).toBe('pending');
    expect(canonicalJson(loaded)).not.toContain('PRIVATE_BILLING');
    input.review.reviewedAt = '2026-08-28T16:59:59.000Z';
    await expect(prepare()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['consent', 'referencePrompt', 'parentPrompt', 'authoringRecord'])(
    'rejects wrong linked %s bytes before publication',
    async (role) => {
      await writeFile(input.files[role]!, '{}');
      await expect(prepare()).rejects.toThrow();
      await expect(readFile(join(evidence, 'prepared.json'))).rejects.toThrow();
    },
  );
  it.each([
    { thirdPartyImageInputs: true },
    { bothEnginesVisible: false },
    { privateOutputsOnly: false },
    { nonEnterpriseTrainingAllowanceReviewed: false },
    { receiptVisuallyReviewed: false },
    { productionPublicationApproved: true },
    { paidPeriodStart: '2026-08-29' },
    { paidPeriodEndExclusive: '2026-08-28' },
    { reviewedAt: '2026-08-28T17:00:01.000Z' },
  ])('fails closed on missing authority %j', async (change) => {
    await expect(
      prepareMeshyEvidence(
        evidence,
        { ...input, review: { ...review, ...change } },
        store.read(),
        spec,
        new Date(time),
      ),
    ).rejects.toThrow();
  });
  it('requires every role and refuses extra unreviewed roles', async () => {
    const missing = { ...input.files };
    delete missing.privatePlanEvidence;
    for (const files of [missing, { ...input.files, other: 'unreviewed' }]) {
      await expect(
        prepareMeshyEvidence(evidence, { ...input, files }, store.read(), spec, new Date(time)),
      ).rejects.toThrow();
    }
  });
  it.each(['truncated', 'wrong-type', 'animation', 'over-dimensions'])(
    'rejects PNG %s',
    async (kind) => {
      let bytes: Buffer = Buffer.from('not a PNG');
      if (kind === 'truncated') bytes = reference.subarray(0, 20);
      if (kind === 'animation') {
        const chunk = Buffer.alloc(20);
        chunk.writeUInt32BE(8);
        chunk.write('acTL', 4);
        bytes = Buffer.concat([reference.subarray(0, 33), chunk, reference.subarray(33)]);
      }
      if (kind === 'over-dimensions')
        bytes = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#fff' } })
          .png()
          .toBuffer();
      await writeFile(input.files.referenceImage!, bytes);
      await expect(prepare()).rejects.toThrow();
    },
  );
  it('refuses forged PDF evidence and credential-shaped prompt evidence', async () => {
    await writeFile(input.files.privatePlanEvidence!, '<html>not a receipt</html>');
    await expect(prepare()).rejects.toThrow();
    await writeFile(input.files.privatePlanEvidence!, '%PDF-1.7');
    await writeFile(input.files.referencePrompt!, key);
    await expect(prepare()).rejects.toThrow('Credential-shaped');
  });
  it('rechecks all bytes including the private receipt immediately before submission', async () => {
    await prepare();
    const loaded = await loadPreparedMeshyEvidence(evidence, store.read(), spec, new Date(time));
    await writeFile(
      meshArtifactPath(evidence, loaded.prepared.artifacts.privatePlanEvidence.sha256),
      '%PDF-changed',
    );
    await expect(submit()).rejects.toThrow('preflight');
    expect(fetch).not.toHaveBeenCalled();
    expect(store.read().requests).toEqual([]);
  });
});

describe('one-shot paid boundary with a real durable ledger and fake provider', () => {
  it('commits before POST, sends only pinned settings and the PNG, then persists the UUID', async () => {
    await prepare();
    fetch.mockImplementation(async (url, init) => {
      await Promise.resolve();
      if (init?.method === 'GET') return Promise.resolve(json({ balance: 1135 }));
      expect(url).toBe('https://api.meshy.ai/openapi/v1/image-to-3d');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const reopened = new MeshyRunStore(database).read();
      expect(meshyCreditExposure(reopened.budget)).toBe(5);
      expect(reopened.tasks).toEqual([]);
      const proof = MeshySubmissionProof.parse(
        loadMeshyEvidenceJson(evidence, reopened.requests[0]!.requestSha256),
      );
      if (typeof init?.body !== 'string') throw new Error('Expected JSON body.');
      expect(proof.requestBodySha256).toBe(sha256(init.body));
      expect(JSON.parse(init.body)).toEqual({
        ...spec.generation,
        image_url: `data:image/png;base64,${reference.toString('base64')}`,
      });
      return json({ result: taskId() });
    });
    const result = await submit();
    expect(result.taskId).toBe(taskId());
    expect(store.read().tasks[0]?.status).toBe('PENDING');
    const files = await readdir(evidence);
    for (const file of files)
      expect((await readFile(join(evidence, file))).toString()).not.toContain(key);
    expect(canonicalJson(result)).not.toContain('PRIVATE_BILLING');
    expect(posts()).toHaveLength(1);
  });
  it.each(['candidate-2', 'candidate-5', 'retexture-selected', '../candidate-1'])(
    'refuses unauthorized operation %s without API access',
    async (operation) => {
      await prepare();
      await expect(submit(operation)).rejects.toThrow('preflight');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('requires the exact approved cap, key shape and prepared evidence', async () => {
    await expect(submit()).rejects.toThrow('preflight');
    await prepare();
    await expect(submit('candidate-1', 39)).rejects.toThrow('preflight');
    await expect(submit('candidate-1', 40, '')).rejects.toThrow('preflight');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['stale', 'future', 'price-drift', 'snapshot-drift', 'wrong-source'])(
    'refuses %s pricing before account access',
    async (kind) => {
      await prepare();
      if (kind === 'stale') pricing.reviewedAt = '2026-08-28T15:59:59.000Z';
      if (kind === 'future') pricing.reviewedAt = '2026-08-28T17:00:01.000Z';
      if (kind === 'price-drift') pricing.untexturedCandidateCredits = 6;
      if (kind === 'snapshot-drift') pricing.snapshot.sha256 = 'a'.repeat(64);
      if (kind === 'wrong-source') pricing.source = 'https://untrusted.test/pricing';
      await expect(submit()).rejects.toThrow('preflight');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('refuses an insufficient balance without making a reservation', async () => {
    await prepare();
    fetch.mockResolvedValue(json({ balance: 39 }));
    await expect(submit()).rejects.toThrow('preflight');
    expect(posts()).toHaveLength(0);
    expect(store.read().requests).toEqual([]);
  });
  it('rechecks pricing and evidence after account access', async () => {
    await prepare();
    fetch.mockImplementation(() => {
      deps.now = () => new Date('2026-08-28T18:00:01.000Z');
      return Promise.resolve(json({ balance: 1135 }));
    });
    await expect(submit()).rejects.toThrow('preflight');
    expect(posts()).toHaveLength(0);
    expect(store.read().requests).toEqual([]);
  });
  it.each([
    '429',
    '500',
    'network',
    'malformed-json',
    'invalid-id',
    'oversized',
    'wrong-mime',
    'broken-stream',
    'persistence',
  ])('retains ambiguous %s outcome and NEVER retries POST', async (kind) => {
    await prepare();
    fetch.mockImplementation((_url, init) => {
      if (init?.method === 'GET') return Promise.resolve(json({ balance: 1135 }));
      if (kind === 'network') return Promise.reject(new Error(`${key} private provider error`));
      if (kind === 'persistence') {
        vi.spyOn(store, 'observe').mockImplementation(() => {
          throw new Error(key);
        });
        return Promise.resolve(json({ result: taskId() }));
      }
      if (kind === 'broken-stream')
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error(key));
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      if (kind === '429' || kind === '500')
        return Promise.resolve(new Response(key, { status: Number(kind) }));
      if (kind === 'wrong-mime') return Promise.resolve(new Response('{}'));
      if (kind === 'invalid-id') return Promise.resolve(json({ result: key }));
      return Promise.resolve(
        new Response(kind === 'oversized' ? ' '.repeat(4097) : key, {
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    await expect(submit()).rejects.toThrow('Submission may have succeeded');
    expect(posts()).toHaveLength(1);
    expect(meshyCreditExposure(new MeshyRunStore(database).read().budget)).toBe(5);
    expect(store.read().tasks).toEqual([]);
    await expect(submit()).rejects.toThrow('preflight');
    await expect(submit('candidate-2')).rejects.toThrow('preflight');
    expect(posts()).toHaveLength(1);
  });
  it('allows only one POST when two asynchronous submissions race', async () => {
    await prepare();
    const results = await Promise.allSettled([submit(), submit()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    expect(store.read().requests).toHaveLength(1);
  });
  it('waits for terminal charge reconciliation and archived successes', async () => {
    await prepare();
    await submit();
    await expect(submit('candidate-2')).rejects.toThrow('preflight');
    store.observe({
      operationId: 'candidate-1',
      taskId: taskId(),
      status: 'SUCCEEDED',
      consumedCredits: null,
      observedAt: time,
    });
    await expect(submit('candidate-2')).rejects.toThrow('preflight');
    terminal(1, 'SUCCEEDED', 5);
    await expect(submit('candidate-2')).rejects.toThrow('preflight');
    expect(posts()).toHaveLength(1);
    const glb = Buffer.alloc(48, 0x20);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(48, 8);
    glb.writeUInt32LE(28, 12);
    glb.writeUInt32LE(0x4e4f534a, 16);
    glb.write('{"asset":{"version":"2.0"}}', 20);
    const recoveryFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          id: taskId(),
          type: 'image-to-3d',
          status: 'SUCCEEDED',
          consumed_credits: 5,
          created_at: Date.parse(time),
          finished_at: Date.parse(time),
          model_urls: { glb: 'https://assets.meshy.ai/model.glb' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(glb), { headers: { 'content-type': 'model/gltf-binary' } }),
      );
    await syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', key, {
      ...deps,
      fetch: recoveryFetch,
    });
    const sealed = await sealMeshyCandidateProvenance(
      store,
      evidence,
      archive,
      spec,
      40,
      'candidate-1',
      new Date('2026-10-01T00:00:00.000Z'),
    );
    expect(sealed.state).toBe('quarantine');
    expect(
      await sealMeshyCandidateProvenance(
        store,
        evidence,
        archive,
        spec,
        40,
        'candidate-1',
        new Date('2026-10-02T00:00:00.000Z'),
      ),
    ).toEqual(sealed);
    const manifest = JSON.parse(
      await readFile(join(archive, 'candidate-1-provenance.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      spec,
      licenceReview: 'pending',
      technicalReview: 'pending',
      visualReview: 'pending',
      performanceReview: 'pending',
    });
    expect(canonicalJson(manifest)).not.toContain('PRIVATE_BILLING');
    expect(canonicalJson(manifest)).not.toContain(key);
    expect((await submit('candidate-2')).taskId).toBe(taskId(2));
  });
  it('never frees failed reservations or permits a fifth/selected-texturing call', async () => {
    await prepare();
    for (let index = 1; index <= 4; index += 1) {
      await submit(`candidate-${index}`);
      terminal(index);
    }
    expect(posts()).toHaveLength(4);
    expect(meshyCreditExposure(store.read().budget)).toBe(20);
    await expect(submit('candidate-5')).rejects.toThrow();
    await expect(submit('retexture-selected')).rejects.toThrow();
    await expect(prepare()).rejects.toThrow();
    expect(posts()).toHaveLength(4);
  });
  it('halts on an unexpected provider charge', async () => {
    await prepare();
    await submit();
    terminal(1, 'FAILED', 6);
    await expect(submit('candidate-2')).rejects.toThrow('preflight');
    expect(posts()).toHaveLength(1);
    expect(meshyCreditExposure(store.read().budget)).toBe(6);
  });
  it('reserves ten credits and posts the selected task only to the retexture endpoint', async () => {
    await prepare();
    await establishSelectedCandidate();
    fetch.mockImplementation((url, init) => {
      if (init?.method === 'GET') return Promise.resolve(json({ balance: 1135 }));
      expect(url).toBe('https://api.meshy.ai/openapi/v1/retexture');
      expect(new MeshyRunStore(database).read().budget.entries.at(-1)).toMatchObject({
        operationId: 'retexture-selected',
        reservedCredits: 10,
      });
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request body.');
      expect(JSON.parse(init.body)).toEqual({
        input_task_id: taskId(),
        ...spec.retexture,
        target_formats: ['glb'],
      });
      return Promise.resolve(json({ result: taskId(10) }));
    });
    const result = await submitRetexture();
    expect(result).toMatchObject({
      operationId: 'retexture-selected',
      taskId: taskId(10),
      reservedCredits: 10,
    });
    expect(meshyCreditExposure(store.read().budget)).toBe(30);
  });
  it('retains the ten-credit reservation when the selected retexture response is ambiguous', async () => {
    await prepare();
    await establishSelectedCandidate();
    fetch.mockImplementation((_url, init) => {
      if (init?.method === 'GET') return Promise.resolve(json({ balance: 1135 }));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    const before = posts().length;
    await expect(submitRetexture()).rejects.toThrow('Submission may have succeeded');
    expect(posts()).toHaveLength(before + 1);
    expect(meshyCreditExposure(store.read().budget)).toBe(30);
    await expect(submitRetexture()).rejects.toThrow('preflight');
    expect(posts()).toHaveLength(before + 1);
  });
  it('rejects changed prior proof bytes and cannot change the reference bundle', async () => {
    await prepare();
    await submit();
    terminal();
    await writeFile(meshArtifactPath(evidence, store.read().requests[0]!.requestSha256), '{}');
    await expect(submit('candidate-2')).rejects.toThrow('preflight');
    expect(posts()).toHaveLength(1);
  });
  it('does not seal provenance for unarchived candidates', async () => {
    await prepare();
    await submit();
    terminal(1, 'SUCCEEDED', 5);
    await expect(
      sealMeshyCandidateProvenance(
        store,
        evidence,
        archive,
        spec,
        40,
        'candidate-1',
        new Date(time),
      ),
    ).rejects.toThrow();
    await expect(readFile(join(archive, 'candidate-1-provenance.json'))).rejects.toThrow();
  });
  it('refuses prior pricing evidence corruption before spending again', async () => {
    await prepare();
    await submit();
    terminal();
    await writeFile(meshArtifactPath(evidence, pricing.snapshot.sha256), '<html>changed</html>');
    await expect(submit('candidate-2')).rejects.toThrow('preflight');
    expect(posts()).toHaveLength(1);
  });
  it('prints only closed diagnostics, never falsely claims an uncertain request was not sent', () => {
    expect(
      meshRunDiagnostic(
        new MeshySubmissionError('submission-uncertain'),
        'invalid-input-or-run-state',
      ),
    ).toContain('may have succeeded');
    expect(meshRunDiagnostic(new Error(key), 'invalid-input-or-run-state')).not.toContain(key);
  });
  it('requires explicit prepare/submit selectors and rejects paid retries or root overrides', () => {
    expect(
      parseMeshyRunArguments(['prepare', '--evidence-file', 'private.json', '--max-credits', '40'])
        .command,
    ).toBe('prepare');
    expect(
      parseMeshyRunArguments([
        'submit',
        '--operation',
        'candidate-1',
        '--pricing-file',
        'private.json',
        '--max-credits',
        '40',
      ]).command,
    ).toBe('submit');
    for (const args of [
      ['prepare'],
      ['submit', '--operation', 'candidate-1', '--max-credits', '40'],
      [
        'submit',
        '--operation',
        'retexture-selected',
        '--pricing-file',
        'private.json',
        '--max-credits',
        '40',
      ],
      [
        'submit',
        '--operation',
        'candidate-1',
        '--pricing-file',
        'private.json',
        '--max-credits',
        '40',
        '--root',
        'elsewhere',
      ],
    ])
      expect(() => parseMeshyRunArguments(args)).toThrow();
  });
});
