import { mkdtemp, readFile, readdir, rm, writeFile, link, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { MeshyGenerationSpec, meshySpecIdentity } from './meshy';
import { meshyArchiveDirectory, syncMeshyCandidate } from './meshy-archive';
import {
  MESHY_GLB_DOWNLOAD_LIMIT,
  assertMeshyGlbEnvelope,
  downloadMeshyGlb,
  fetchMeshyRetextureTask,
  recoverMeshyCandidate,
  reconcileUncertainMeshyRetexture,
  type MeshyRecoveryDeps,
} from './meshy-recovery';
import { MeshyRunApproval, type MeshyTaskReceipt } from './meshy-run';
import { parseMeshyRunArguments } from './meshy-run-command';
import { MeshyRunStore } from './meshy-store';

const spec = MeshyGenerationSpec.parse(
  JSON.parse(
    await readFile(
      new URL('../../../assets/aircraft/generation/a320neo-t2-v1.json', import.meta.url),
      'utf8',
    ),
  ),
);
const time = '2026-08-28T17:00:00.000Z';
const taskId = '00000000-0000-4000-8000-000000000001';
const retextureTaskId = '00000000-0000-4000-8000-000000000099';
const credential = 'msy_testNotARealCredential';
const signedUrl = `https://assets.meshy.ai/tasks/${taskId}/output/model.glb?Expires=123&Signature=private`;
const approval = MeshyRunApproval.parse({
  format: 'tailfin-meshy-run-approval',
  formatVersion: 1,
  runId: 'a320neo-first-run',
  specSha256: meshySpecIdentity(spec),
  maxCredits: 40,
  recordedAt: time,
  authority: 'explicit-user-confirmation',
  evidence: { taskId, confirmationSha256: 'a'.repeat(64) },
  scope: 'four-t2-candidates-and-one-selected-4k-retexture',
  fallbackApproved: false,
  productionPublicationApproved: false,
});
const initial: MeshyTaskReceipt = {
  operationId: 'candidate-1',
  taskId,
  status: 'PENDING',
  consumedCredits: null,
  observedAt: time,
};

// Container fixture intentionally does NOT claim mesh quality/conformance admission.
const glb = Buffer.alloc(48, 0x20);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(28, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
glb.write('{"asset":{"version":"2.0"}}', 20);
const providerTask = (overrides: Record<string, unknown> = {}) => ({
  id: taskId,
  type: 'image-to-3d',
  status: 'SUCCEEDED',
  consumed_credits: 5,
  created_at: Date.parse(time),
  finished_at: Date.parse(time) + 1_000,
  expires_at: Date.parse(time) + 3 * 86_400_000,
  model_urls: { glb: signedUrl },
  task_error: { message: `${credential} provider message must not escape` },
  ...overrides,
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const binary = (bytes = glb) =>
  new Response(new Uint8Array(bytes), { headers: { 'content-type': 'model/gltf-binary' } });

let root: string;
let database: string;
let archive: string;
let store: MeshyRunStore;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let deps: MeshyRecoveryDeps;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tailfin-meshy-recovery-'));
  database = join(root, 'run.sqlite');
  archive = meshyArchiveDirectory(database);
  store = new MeshyRunStore(database);
  store.initialize(approval, spec);
  store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
  store.observe(initial);
  fetch = vi.fn<typeof globalThis.fetch>();
  deps = { fetch, pause: vi.fn(() => Promise.resolve()), now: () => new Date(time) };
});
afterEach(async () => {
  // The sole recursive target is this test's fresh mkdtemp directory.
  await rm(root, { recursive: true, force: true });
});

describe('bounded known-candidate recovery (no paid transport)', () => {
  it('GETs only the recorded UUID, strips provider messages and persists the terminal charge', async () => {
    fetch.mockResolvedValueOnce(json(providerTask()));
    const result = await recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps);
    expect(result.receipt.status).toBe('SUCCEEDED');
    expect(store.read().budget.entries[0]?.chargedCredits).toBe(5);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `https://api.meshy.ai/openapi/v1/image-to-3d/${taskId}`,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
      }),
    );
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(canonicalJson(store.read())).not.toContain(credential);
    expect(canonicalJson(store.read())).not.toContain('Signature');
    expect(result).not.toHaveProperty('task_error');
  });

  it.each(['candidate-2', 'retexture-selected', '../candidate-1', taskId])(
    'does not adopt an arbitrary operation/task: %s',
    async (operation) => {
      await expect(
        recoverMeshyCandidate(store, spec, 40, operation, credential, deps),
      ).rejects.toThrow('unknown-candidate');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('refuses an unreceipted reservation without looking up or adopting provider tasks', async () => {
    store.reserve(spec, 40, 'candidate-2', 'c'.repeat(64));
    await expect(
      recoverMeshyCandidate(store, spec, 40, 'candidate-2', credential, deps),
    ).rejects.toThrow('unknown-candidate');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the exact cap, spec and credential before provider access', async () => {
    for (const [cap, key, input] of [
      [30, credential, spec],
      [40, '', spec],
      [40, credential, { ...spec, id: 'changed' }],
    ] as const) {
      await expect(
        recoverMeshyCandidate(store, input as MeshyGenerationSpec, cap, 'candidate-1', key, deps),
      ).rejects.toThrow('not-authorized');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 302])('does not retry an HTTP %i refusal', async (status) => {
    fetch.mockResolvedValueOnce(new Response(credential, { status }));
    await expect(
      recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('http-refused');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.read().tasks).toEqual([initial]);
  });

  it('bounds transient retries and never exposes underlying transport errors', async () => {
    fetch.mockRejectedValue(new Error(`${signedUrl} ${credential}`));
    await expect(
      recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('Meshy recovery unavailable; no generation submitted.');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(deps.pause).toHaveBeenNthCalledWith(1, 250);
    expect(deps.pause).toHaveBeenNthCalledWith(2, 500);
  });

  it('recovers from rate limits and server failures with at most three GETs', async () => {
    fetch
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(json(providerTask()));
    await recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { id: '00000000-0000-4000-8000-000000000002' },
    { type: 'retexture' },
    { status: 'UNKNOWN' },
    { consumed_credits: -1 },
    { created_at: 9e15 },
  ])('rejects malformed/foreign task responses without changing history: %j', async (change) => {
    fetch.mockResolvedValueOnce(json(providerTask(change)));
    await expect(
      recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('invalid-response');
    expect(store.read().tasks).toEqual([initial]);
  });

  it('bounds decoded JSON even with a dishonest compressed content length', async () => {
    fetch.mockResolvedValueOnce(
      new Response(' '.repeat(65_537), {
        headers: { 'content-type': 'application/json', 'content-length': '1' },
      }),
    );
    await expect(
      recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('invalid-response');
    expect(store.read().tasks).toEqual([initial]);
  });

  it('does not append duplicate polling snapshots, including racing timestamp observations', async () => {
    fetch.mockImplementation(() => Promise.resolve(json(providerTask())));
    await recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps);
    const before = await readFile(database);
    deps.now = () => new Date(Date.parse(time) + 20_000);
    for (let index = 0; index < 260; index += 1)
      await recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps);
    store.observeProgress({ ...store.read().tasks[0]!, observedAt: deps.now().toISOString() });
    expect(await readFile(database)).toEqual(before);
  }, 15_000);

  it('records overcharges and blocks new reservations, without suppressing read-only recovery', async () => {
    fetch.mockResolvedValueOnce(json(providerTask({ consumed_credits: 6 })));
    await recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps);
    expect(store.read().budget.entries[0]?.chargedCredits).toBe(6);
    expect(() => store.reserve(spec, 40, 'candidate-2', 'c'.repeat(64))).toThrow();
    fetch.mockResolvedValueOnce(json(providerTask({ consumed_credits: 6 })));
    await recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps);
  });

  it('reports mid-flight charges without pretending they are terminal confirmations', async () => {
    fetch.mockResolvedValueOnce(json(providerTask({ status: 'IN_PROGRESS', consumed_credits: 6 })));
    const result = await recoverMeshyCandidate(store, spec, 40, 'candidate-1', credential, deps);
    expect(result.observedCredits).toBe(6);
    expect(store.read().tasks[0]?.consumedCredits).toBeNull();
  });
});

describe('operator retexture reconciliation (no paid transport)', () => {
  const submittedAt = '2026-08-28T17:01:00.000Z';
  const retextureTask = (overrides: Record<string, unknown> = {}) => ({
    id: retextureTaskId,
    type: 'retexture',
    status: 'PENDING',
    created_at: Date.parse(submittedAt) + 1_000,
    ...overrides,
  });

  function reserveUncertainRetexture() {
    store.observe({ ...initial, status: 'SUCCEEDED', consumedCredits: 5 });
    for (const operationId of ['candidate-2', 'candidate-3', 'candidate-4'] as const) {
      const index = Number(operationId.slice(-1));
      store.reserve(spec, 40, operationId, String(index).repeat(64));
      store.observe({
        operationId,
        taskId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        status: 'SUCCEEDED',
        consumedCredits: 5,
        observedAt: time,
      });
    }
    store.select(taskId, 'f'.repeat(64));
    store.reserve(spec, 40, 'retexture-selected', 'e'.repeat(64));
  }

  it('adopts only the named, post-submission provider task with a read-only GET', async () => {
    reserveUncertainRetexture();
    fetch.mockResolvedValueOnce(json(retextureTask()));
    const result = await reconcileUncertainMeshyRetexture(
      store,
      spec,
      40,
      retextureTaskId,
      submittedAt,
      credential,
      deps,
    );
    expect(result.receipt).toMatchObject({
      operationId: 'retexture-selected',
      taskId: retextureTaskId,
      status: 'PENDING',
      consumedCredits: null,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `https://api.meshy.ai/openapi/v1/retexture/${retextureTaskId}`,
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it.each([
    ['00000000-0000-4000-8000-000000000098', {}],
    [retextureTaskId, { created_at: Date.parse(submittedAt) - 1 }],
  ])('refuses a mismatched operator task without mutating the reservation', async (id, change) => {
    reserveUncertainRetexture();
    fetch.mockResolvedValueOnce(json(retextureTask(change)));
    await expect(
      reconcileUncertainMeshyRetexture(store, spec, 40, id, submittedAt, credential, deps),
    ).rejects.toThrow('invalid-response');
    expect(store.read().tasks).toHaveLength(4);
    expect(store.read().requests).toHaveLength(5);
  });
});

describe('bound archive-recovery retexture polling', () => {
  it('reads one exact provider task without adopting or persisting transient URLs', async () => {
    fetch.mockResolvedValueOnce(
      json({
        id: retextureTaskId,
        type: 'retexture',
        status: 'PENDING',
        name: 'provider-only metadata is discarded',
        created_at: Date.parse(time),
        finished_at: null,
        expires_at: null,
        texture_urls: [
          {
            base_color: 'https://assets.meshy.ai/base-color.png',
            normal: 'https://assets.meshy.ai/normal.png',
            metallic: 'https://assets.meshy.ai/metallic.png',
            roughness: 'https://assets.meshy.ai/roughness.png',
          },
        ],
      }),
    );
    const result = await fetchMeshyRetextureTask(retextureTaskId, credential, deps);
    expect(result).toMatchObject({ id: retextureTaskId, status: 'PENDING' });
    expect(result).not.toHaveProperty('name');
    expect(result.texture_urls?.base_color).toEqual(expect.any(String));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `https://api.meshy.ai/openapi/v1/retexture/${retextureTaskId}`,
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });
});

describe('credential-free immutable export quarantine', () => {
  it('downloads unchanged bytes, commits a sanitized manifest last, and resumes offline', async () => {
    fetch.mockResolvedValueOnce(json(providerTask())).mockResolvedValueOnce(binary());
    const result = await syncMeshyCandidate(
      store,
      archive,
      spec,
      40,
      'candidate-1',
      credential,
      deps,
    );
    expect(result.archived).toBe(true);
    expect(await readFile(join(archive, `${sha256(glb)}.glb`))).toEqual(glb);
    const manifest = await readFile(join(archive, 'candidate-1.json'), 'utf8');
    expect(manifest).toContain('quarantine');
    expect(manifest).not.toMatch(/msy_|Signature|Expires|https:/);
    const download = fetch.mock.calls[1]!;
    expect(download[0]).toBe(signedUrl);
    expect(download[1]?.method).toBe('GET');
    expect(download[1]?.redirect).toBe('error');
    expect(download[1]?.headers).not.toHaveProperty('Authorization');
    fetch.mockClear();
    expect(await syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', '', deps)).toEqual(
      result,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(archive)).toHaveLength(2);
  });

  it('retains the charge if an output URL expires, and retries retrieval rather than generation', async () => {
    fetch
      .mockResolvedValueOnce(json(providerTask()))
      .mockResolvedValueOnce(new Response(credential, { status: 403 }));
    await expect(
      syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('archive refused');
    expect(store.read().budget.entries[0]?.chargedCredits).toBe(5);
    await expect(readdir(archive)).rejects.toMatchObject({ code: 'ENOENT' });
    fetch.mockResolvedValueOnce(json(providerTask())).mockResolvedValueOnce(binary());
    await syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps);
    expect(fetch.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
    expect(store.read().requests).toHaveLength(1);
  });

  it('does not download a nonterminal or uncharged successful task', async () => {
    for (const [status, credits] of [
      ['PENDING', 5],
      ['IN_PROGRESS', 5],
      ['SUCCEEDED', undefined],
    ]) {
      fetch.mockResolvedValueOnce(json(providerTask({ status, consumed_credits: credits })));
      if (status === 'SUCCEEDED')
        await expect(
          syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
        ).rejects.toThrow('archive refused');
      else
        expect(
          (await syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps))
            .archived,
        ).toBe(false);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('records a failed task refund without releasing its reserved budget or fetching outputs', async () => {
    fetch.mockResolvedValueOnce(json(providerTask({ status: 'FAILED', consumed_credits: 0 })));
    const result = await syncMeshyCandidate(
      store,
      archive,
      spec,
      40,
      'candidate-1',
      credential,
      deps,
    );
    expect(result).toMatchObject({ status: 'FAILED', archived: false, observedCredits: 0 });
    expect(store.read().budget.entries[0]).toMatchObject({ reservedCredits: 5, chargedCredits: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds decoded download bytes independently of the advertised content length', async () => {
    let count = 0;
    fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            count += 1;
            controller.enqueue(new Uint8Array(8 * 1024 * 1024));
          },
        }),
        { headers: { 'content-type': 'model/gltf-binary', 'content-length': '1' } },
      ),
    );
    await expect(downloadMeshyGlb(signedUrl, deps)).rejects.toThrow('download-refused');
    expect(count).toBeLessThanOrEqual(10);
  });

  it('refuses a redirected archive directory without writing to its target', async () => {
    const target = join(root, 'redirect-target');
    await mkdir(target);
    await symlink(target, archive, process.platform === 'win32' ? 'junction' : 'dir');
    fetch.mockResolvedValueOnce(json(providerTask())).mockResolvedValueOnce(binary());
    await expect(
      syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('archive refused');
    expect(await readdir(target)).toEqual([]);
  });

  it.each([
    'http://assets.meshy.ai/model.glb',
    'https://assets.meshy.ai.evil.test/model.glb',
    'https://localhost/model.glb',
    'https://127.0.0.1/model.glb',
    'file:///model.glb',
    'https://user:password@assets.meshy.ai/model.glb',
    'https://assets.meshy.ai:444/model.glb',
    'https://assets.meshy.ai/model.glb#fragment',
  ])('refuses arbitrary asset destinations before fetching: %s', async (url) => {
    await expect(downloadMeshyGlb(url, deps)).rejects.toThrow('download-refused');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized declared downloads and interrupted streams without publishing a manifest', async () => {
    fetch.mockResolvedValueOnce(
      new Response('x', {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(MESHY_GLB_DOWNLOAD_LIMIT + 1),
        },
      }),
    );
    await expect(downloadMeshyGlb(signedUrl, deps)).rejects.toThrow('download-refused');
    fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`${credential} ${signedUrl}`));
          },
        }),
        { headers: { 'content-type': 'model/gltf-binary' } },
      ),
    );
    await expect(downloadMeshyGlb(signedUrl, deps)).rejects.toThrow(
      'Meshy recovery download-refused; no generation submitted.',
    );
  });

  it('rejects HTML, wrong magic/version, truncation, and invalid chunk lengths', async () => {
    for (const [offset, value] of [
      [0, 0],
      [4, 1],
      [8, 20],
      [12, 29],
      [16, 0],
    ]) {
      const bytes = Buffer.from(glb);
      bytes.writeUInt32LE(value!, offset);
      expect(() => assertMeshyGlbEnvelope(bytes)).toThrow('download-refused');
    }
    expect(() => assertMeshyGlbEnvelope(glb.subarray(0, 10))).toThrow();
    fetch.mockResolvedValueOnce(
      new Response('<html>not glb</html>', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(downloadMeshyGlb(signedUrl, deps)).rejects.toThrow('download-refused');
  });

  it('does not overwrite or redownload corrupt/missing archived bytes', async () => {
    fetch.mockResolvedValueOnce(json(providerTask())).mockResolvedValueOnce(binary());
    await syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps);
    const objectPath = join(archive, `${sha256(glb)}.glb`);
    await writeFile(objectPath, Buffer.alloc(glb.length));
    fetch.mockClear();
    await expect(
      syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('archive refused');
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(objectPath)).toEqual(Buffer.alloc(glb.length));
    await rm(objectPath);
    await expect(
      syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('archive refused');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses archive hard links and tampered request bindings', async () => {
    fetch.mockResolvedValueOnce(json(providerTask())).mockResolvedValueOnce(binary());
    await syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps);
    const objectPath = join(archive, `${sha256(glb)}.glb`);
    await link(objectPath, join(root, 'untrusted-link'));
    fetch.mockClear();
    await expect(
      syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('archive refused');
    await rm(join(root, 'untrusted-link'));
    const path = join(archive, 'candidate-1.json');
    await writeFile(path, (await readFile(path, 'utf8')).replace('b'.repeat(64), 'c'.repeat(64)));
    await expect(
      syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
    ).rejects.toThrow('archive refused');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a final-component POSIX symlink before reading an export',
    async () => {
      fetch.mockResolvedValueOnce(json(providerTask())).mockResolvedValueOnce(binary());
      await syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps);
      const objectPath = join(archive, `${sha256(glb)}.glb`);
      const target = join(root, 'other-export.glb');
      await writeFile(target, glb);
      await rm(objectPath);
      await symlink(target, objectPath);
      fetch.mockClear();
      await expect(
        syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
      ).rejects.toThrow('archive refused');
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(target)).toEqual(glb);
    },
  );

  it('concurrent polls retain one receipt and one immutable export', async () => {
    fetch.mockImplementation((url) =>
      Promise.resolve(
        typeof url === 'string' && url.startsWith('https://api.meshy.ai/')
          ? json(providerTask())
          : binary(),
      ),
    );
    const results = await Promise.all([
      syncMeshyCandidate(store, archive, spec, 40, 'candidate-1', credential, deps),
      syncMeshyCandidate(
        new MeshyRunStore(database),
        archive,
        spec,
        40,
        'candidate-1',
        credential,
        {
          ...deps,
          now: () => new Date(Date.parse(time) + 1_000),
        },
      ),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await readdir(archive)).toHaveLength(2);
    expect(store.read().tasks).toHaveLength(1);
  });

  it('exposes only a bounded candidate sync CLI, no URL/root/paid/adoption override', () => {
    expect(
      parseMeshyRunArguments(['sync', '--operation', 'candidate-1', '--max-credits', '40']).command,
    ).toBe('sync');
    for (const args of [
      ['sync'],
      ['sync', '--operation', 'retexture-selected', '--max-credits', '40'],
      ['sync', '--operation', 'candidate-1', '--max-credits', '41'],
      ['sync', '--operation', 'candidate-1', '--max-credits', '40', '--root', '/tmp'],
      ['sync', '--task-id', taskId, '--max-credits', '40'],
      ['submit', '--max-credits', '40'],
    ])
      expect(() => parseMeshyRunArguments(args)).toThrow();
  });
});
