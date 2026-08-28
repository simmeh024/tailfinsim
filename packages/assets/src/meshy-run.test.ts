import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import {
  MeshyGenerationSpec,
  MeshyOperationId,
  meshyCreditExposure,
  meshySpecIdentity,
} from './meshy';
import { checkMeshyAccount, type MeshyAccountDeps } from './meshy-account';
import { meshyArchiveDirectory, syncMeshyCandidate } from './meshy-archive';
import {
  MeshyCandidateProvenance,
  MeshyRunApproval,
  MeshyRunState,
  assertMeshyRunTransition,
  createMeshyRun,
  meshyRunApprovalIdentity,
  type MeshyTaskReceipt,
} from './meshy-run';
import { parseMeshyRunArguments } from './meshy-run-command';
import { MeshyRunStore, meshyRunDatabasePath } from './meshy-store';
import { fixture, pack } from './meshy-test-fixture';

const spec = MeshyGenerationSpec.parse(
  JSON.parse(
    await readFile(
      new URL('../../../assets/aircraft/generation/a320neo-t2-v1.json', import.meta.url),
      'utf8',
    ),
  ),
);
const now = '2026-08-28T13:00:00.000Z';
const approval = MeshyRunApproval.parse({
  format: 'tailfin-meshy-run-approval',
  formatVersion: 1,
  runId: 'a320neo-first-run',
  specSha256: meshySpecIdentity(spec),
  maxCredits: 40,
  recordedAt: now,
  authority: 'explicit-user-confirmation',
  evidence: { taskId: '00000000-0000-4000-8000-000000000099', confirmationSha256: 'a'.repeat(64) },
  scope: 'four-t2-candidates-and-one-selected-4k-retexture',
  fallbackApproved: false,
  productionPublicationApproved: false,
});
const task = (
  index = 1,
  status: MeshyTaskReceipt['status'] = 'PENDING',
  consumedCredits: number | null = null,
): MeshyTaskReceipt => ({
  operationId: MeshyOperationId.options[index - 1]!,
  taskId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  status,
  consumedCredits,
  observedAt: now,
});

let directory: string;
let database: string;
let store: MeshyRunStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tailfin-meshy-run-test-'));
  database = join(directory, 'run.sqlite');
  store = new MeshyRunStore(database);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  // The sole recursive target was created by this test's mkdtemp, never a repository.
  await rm(directory, { recursive: true, force: true });
});

describe('immutable first-run authority and durable reservations', () => {
  it('persists approval once and refuses a reset or changed cap', () => {
    expect(() => store.read()).toThrow('store refused');
    expect(store.initialize(approval, spec).approval.maxCredits).toBe(40);
    expect(new MeshyRunStore(database).read().approval).toEqual(approval);
    expect(() => store.initialize(approval, spec)).toThrow('store refused');
    expect(() => store.reserve(spec, 30, 'candidate-1', 'b'.repeat(64))).toThrow('store refused');
    expect(store.read().budget.entries).toEqual([]);
  });

  it('binds the approval to the spec and cannot approve fallbacks, publishing or extra runs', () => {
    expect(() => store.initialize({ ...approval, specSha256: 'c'.repeat(64) }, spec)).toThrow();
    for (const change of [
      { maxCredits: 41 },
      { runId: 'another-run' },
      { fallbackApproved: true },
      { productionPublicationApproved: true },
      { authority: 'account-balance' },
    ]) {
      expect(MeshyRunApproval.safeParse({ ...approval, ...change }).success).toBe(false);
    }
  });

  it('retains an uncertain submission across reopen and blocks every new reservation', () => {
    store.initialize(approval, spec);
    const reserved = store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
    expect(meshyCreditExposure(reserved.budget)).toBe(5);
    const reopened = new MeshyRunStore(database);
    expect(reopened.read()).toEqual(reserved);
    expect(() => reopened.reserve(spec, 40, 'candidate-1', 'b'.repeat(64))).toThrow();
    expect(() => reopened.reserve(spec, 40, 'candidate-2', 'c'.repeat(64))).toThrow();
    reopened.observe(task());
    expect(reopened.reserve(spec, 40, 'candidate-2', 'c'.repeat(64)).requests).toHaveLength(2);
  });

  it('persists the complete 30-credit plan and never frees a failed/zero-charge reservation', () => {
    store.initialize({ ...approval, maxCredits: 30 }, spec);
    for (const [index, operation] of MeshyOperationId.options.entries()) {
      if (operation === 'retexture-selected') store.select(task().taskId, 'f'.repeat(64));
      store.reserve(spec, 30, operation, sha256(operation));
      store.observe(task(index + 1, index === 0 ? 'SUCCEEDED' : 'FAILED', index === 0 ? 5 : 0));
    }
    expect(meshyCreditExposure(store.read().budget)).toBe(30);
    expect(() => store.reserve(spec, 30, 'candidate-1', sha256('retry'))).toThrow();
  });

  it('refuses the final operation under a 29-credit cap without mutating history', () => {
    store.initialize({ ...approval, maxCredits: 29 }, spec);
    for (let index = 0; index < 4; index += 1) {
      store.reserve(spec, 29, MeshyOperationId.options[index]!, sha256(String(index)));
      store.observe(task(index + 1, 'SUCCEEDED', 5));
    }
    store.select(task().taskId, 'f'.repeat(64));
    const before = store.read();
    expect(() => store.reserve(spec, 29, 'retexture-selected', 'b'.repeat(64))).toThrow();
    expect(store.read()).toEqual(before);
  });

  it('records overcharges, halts price drift and rejects conflicting final task observations', () => {
    store.initialize(approval, spec);
    store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
    store.observe(task(1, 'IN_PROGRESS'));
    expect(() => store.observe(task(1, 'PENDING'))).toThrow();
    store.observe(task(1, 'SUCCEEDED', 6));
    expect(meshyCreditExposure(store.read().budget)).toBe(6);
    expect(() => store.reserve(spec, 40, 'candidate-2', 'c'.repeat(64))).toThrow();
    expect(() => store.observe(task(1, 'SUCCEEDED', 5))).toThrow();
    expect(() => store.observe(task(1, 'FAILED', 6))).toThrow();
    expect(() => store.observe({ ...task(1, 'SUCCEEDED', 6), taskId: task(2).taskId })).toThrow();
    expect(() => store.observe(task(2, 'SUCCEEDED', 5))).toThrow();
  });

  it('refuses one provider task reused for two operations', () => {
    store.initialize(approval, spec);
    store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
    store.observe(task());
    store.reserve(spec, 40, 'candidate-2', 'c'.repeat(64));
    expect(() => store.observe({ ...task(2), taskId: task().taskId })).toThrow();
    expect(store.read().tasks).toHaveLength(1);
  });

  it('does not append history when identical receipts arrive in round-robin order', async () => {
    store.initialize(approval, spec);
    store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
    store.observe(task());
    store.reserve(spec, 40, 'candidate-2', 'c'.repeat(64));
    store.observe(task(2));
    const before = await readFile(database);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      store.observe(task());
      store.observe(task(2));
    }
    expect(sha256(await readFile(database))).toBe(sha256(before));
  });

  it('accepts chronological timestamps with different fractional precision', () => {
    store.initialize(approval, spec);
    store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
    store.observe({ ...task(), observedAt: '2026-08-28T13:00:00Z' });
    store.observe({ ...task(1, 'IN_PROGRESS'), observedAt: '2026-08-28T13:00:00.1Z' });
    expect(() => store.observe({ ...task(), observedAt: '2026-08-28T12:59:59Z' })).toThrow();
  });

  it('requires one immutable human selection after the candidate sweep before retexturing', () => {
    store.initialize(approval, spec);
    expect(() => store.reserve(spec, 40, 'retexture-selected', 'a'.repeat(64))).toThrow();
    expect(() => store.select(task().taskId, 'f'.repeat(64))).toThrow();
    for (let index = 0; index < 4; index += 1) {
      store.reserve(spec, 40, MeshyOperationId.options[index]!, sha256(String(index)));
      store.observe(task(index + 1, index === 1 ? 'FAILED' : 'SUCCEEDED', 5));
    }
    expect(() => store.select(task(2).taskId, 'f'.repeat(64))).toThrow();
    store.select(task().taskId, 'f'.repeat(64));
    expect(() => store.select(task(3).taskId, 'f'.repeat(64))).toThrow();
    expect(store.reserve(spec, 40, 'retexture-selected', 'a'.repeat(64)).selection?.taskId).toBe(
      task().taskId,
    );
  });

  it('uses SQLite write exclusion across processes and recovers when the writer exits', async () => {
    store.initialize(approval, spec);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked'); setInterval(()=>{},1000);",
        database,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      expect(() => store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64))).toThrow('store refused');
      expect(store.read().requests).toEqual([]);
    } finally {
      child.kill();
      await exited;
    }
    expect(store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64)).requests).toHaveLength(1);
  });

  it('retains the committed reservation after a submitting process crashes', () => {
    store.initialize(approval, spec);
    const module = join(directory, 'store.mjs');
    buildSync({
      entryPoints: [fileURLToPath(new URL('./meshy-store.ts', import.meta.url))],
      outfile: module,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const {MeshyRunStore}=await import(process.argv[1]); new MeshyRunStore(process.argv[2]).reserve(JSON.parse(process.argv[3]),40,'candidate-1','b'.repeat(64)); process.exit(23);",
        pathToFileURL(module).href,
        database,
        JSON.stringify(spec),
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(child.stderr).toBe('');
    expect(child.status).toBe(23);
    expect(meshyCreditExposure(store.read().budget)).toBe(5);
    expect(store.read().tasks).toEqual([]);
    expect(() => store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64))).toThrow();
  });

  it('makes ordinary SQL edits/deletes fail and detects tampering after triggers are bypassed', () => {
    store.initialize(approval, spec);
    const db = new DatabaseSync(database);
    try {
      expect(() => db.exec('DELETE FROM snapshots')).toThrow('immutable');
      expect(() => db.exec("UPDATE snapshots SET digest='bad'")).toThrow('immutable');
      db.exec('DROP TRIGGER snapshots_no_update');
      db.prepare('UPDATE snapshots SET payload=?').run('{}');
    } finally {
      db.close();
    }
    expect(() => store.read()).toThrow('store refused');
  });

  it('rejects rewritten cap/reservation/task history even when a payload is well-formed', () => {
    const initial = store.initialize(approval, spec);
    const reserved = store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
    expect(() => assertMeshyRunTransition(reserved, initial)).toThrow();
    const charged = store.observe(task(1, 'SUCCEEDED', 5));
    expect(() => assertMeshyRunTransition(charged, reserved)).toThrow();
    expect(() =>
      assertMeshyRunTransition(initial, createMeshyRun({ ...approval, maxCredits: 30 }, spec)),
    ).toThrow();
    expect(
      MeshyRunState.safeParse({ ...initial, budget: { ...initial.budget, maxCredits: 30 } })
        .success,
    ).toBe(false);
  });

  it('refuses a corrupted database without exposing its bytes', async () => {
    await writeFile(database, 'msy_SYNTHETIC_CORRUPT_FILE_ONLY');
    expect(() => store.read()).toThrow('Meshy run store refused');
  });

  it('resolves different worktrees to the same first-run database', () => {
    const runGit = (cwd: string, args: string[]) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
      expect(result.status).toBe(0);
    };
    runGit(directory, ['init', '-q']);
    runGit(directory, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ]);
    const worktree = join(directory, 'worktree');
    runGit(directory, ['worktree', 'add', '--detach', worktree, 'HEAD']);
    expect(meshyRunDatabasePath(worktree)).toBe(meshyRunDatabasePath(directory));
  });
});

describe('quarantine provenance descriptors', () => {
  const candidate = {
    format: 'tailfin-meshy-candidate-provenance',
    formatVersion: 1,
    state: 'quarantine',
    provider: 'meshy',
    approvalSha256: meshyRunApprovalIdentity(approval),
    spec,
    specSha256: meshySpecIdentity(spec),
    referenceImage: null,
    referenceRightsEvidence: null,
    termsSnapshot: null,
    privatePlanEvidence: null,
    task: task(),
    inputTaskId: null,
    generatedAt: null,
    untouchedExport: null,
    licenceReview: 'pending',
    technicalReview: 'pending',
    visualReview: 'pending',
    performanceReview: 'pending',
  };
  it('permits incomplete candidates only in quarantine, never accepted assets', () => {
    expect(MeshyCandidateProvenance.parse(candidate).state).toBe('quarantine');
    for (const change of [
      { state: 'published' },
      { licenceReview: 'passed' },
      { licence: 'in_house' },
      { specSha256: 'f'.repeat(64) },
      { sourceUrl: 'https://assets.meshy.ai/file?Signature=secret' },
    ]) {
      expect(MeshyCandidateProvenance.safeParse({ ...candidate, ...change }).success).toBe(false);
    }
  });
  it('requires a succeeded task and generation date for an untouched GLB export', () => {
    const untouchedExport = { sha256: 'd'.repeat(64), bytes: 100, mediaType: 'model/gltf-binary' };
    expect(MeshyCandidateProvenance.safeParse({ ...candidate, untouchedExport }).success).toBe(
      false,
    );
    expect(
      MeshyCandidateProvenance.safeParse({
        ...candidate,
        untouchedExport,
        task: task(1, 'SUCCEEDED', 5),
        generatedAt: now,
      }).success,
    ).toBe(true);
  });
  it('can reference a private PDF plan receipt without treating it as publication approval', () => {
    const record = MeshyCandidateProvenance.parse({
      ...candidate,
      privatePlanEvidence: { sha256: 'a'.repeat(64), bytes: 100, mediaType: 'application/pdf' },
    });
    expect(record.privatePlanEvidence?.mediaType).toBe('application/pdf');
    expect(record.state).toBe('quarantine');
    expect(record.licenceReview).toBe('pending');
  });
  it('rejects embedded credentials, signed URLs and mismatched artifact kinds', () => {
    const changed = { ...spec, referencePrompt: 'msy_SYNTHETIC_TEST_ONLY' };
    expect(
      MeshyCandidateProvenance.safeParse({
        ...candidate,
        spec: changed,
        specSha256: meshySpecIdentity(changed),
      }).success,
    ).toBe(false);
    expect(
      MeshyCandidateProvenance.safeParse({
        ...candidate,
        referenceImage: { sha256: 'a'.repeat(64), bytes: 20, mediaType: 'text/plain' },
      }).success,
    ).toBe(false);
  });
});

describe('read-only Meshy account readiness', () => {
  const credential = 'msy_SYNTHETIC_TEST_ONLY';
  const state = createMeshyRun(approval, spec);
  const dependencies = (fetch: typeof globalThis.fetch): MeshyAccountDeps => ({
    fetch,
    pause: vi.fn(() => Promise.resolve()),
    now: () => new Date(now),
  });
  it('makes only a fixed-host GET and returns only the bounded balance projection', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ balance: 1135, ignored: credential })),
    );
    const result = await checkMeshyAccount(state, spec, 40, credential, dependencies(fetch));
    expect(result).toMatchObject({
      authenticated: true,
      balance: 1135,
      coversApprovedCeiling: true,
      generationAvailable: false,
      creditsSpentByThisCommand: 0,
      planAndPrivateLicenceVerified: false,
    });
    expect(canonicalJson(result)).not.toContain(credential);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.meshy.ai/openapi/v1/balance',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('makes no request without matching consent/spec/cap and a plausible local key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const cap of [0, 30, 41, 1135]) {
      await expect(
        checkMeshyAccount(state, spec, cap, credential, dependencies(fetch)),
      ).rejects.toThrow();
    }
    await expect(checkMeshyAccount(state, spec, 40, '', dependencies(fetch))).rejects.toThrow();
    await expect(
      checkMeshyAccount(
        state,
        { ...spec, referencePrompt: 'changed' },
        40,
        credential,
        dependencies(fetch),
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports insufficient balance without mistaking it for generation authorization', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ balance: 12 })),
    );
    expect(await checkMeshyAccount(state, spec, 40, credential, dependencies(fetch))).toMatchObject(
      {
        balance: 12,
        coversApprovedCeiling: false,
        generationAvailable: false,
      },
    );
  });
  it.each([401, 403])(
    'does not retry authentication refusal %s or print the response',
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response(credential, { status })),
      );
      await expect(
        checkMeshyAccount(state, spec, 40, credential, dependencies(fetch)),
      ).rejects.toThrow('authentication-refused');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([429, 500, 503])('bounds transient HTTP %s retries to three GETs', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(credential, { status })),
    );
    const deps = dependencies(fetch);
    await expect(checkMeshyAccount(state, spec, 40, credential, deps)).rejects.toThrow(
      'http-refused',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(deps.pause).toHaveBeenCalledTimes(2);
  });
  it('bounds transport failures and redacts network exception messages', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error(credential)));
    await expect(
      checkMeshyAccount(state, spec, 40, credential, dependencies(fetch)),
    ).rejects.toThrow('unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('recovers from one transient error without retrying a success', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(Response.json({ balance: 40 }));
    expect(
      (await checkMeshyAccount(state, spec, 40, credential, dependencies(fetch))).balance,
    ).toBe(40);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([-1, '1135', null, Number.MAX_VALUE])('refuses invalid balance %j', async (balance) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json({ balance })));
    await expect(
      checkMeshyAccount(state, spec, 40, credential, dependencies(fetch)),
    ).rejects.toThrow('invalid-response');
  });
  it('rejects oversized, malformed and non-JSON responses without leaking content', async () => {
    for (const response of [
      new Response(credential),
      new Response(credential, { headers: { 'content-type': 'application/json' } }),
      new Response(' '.repeat(4097), { headers: { 'content-type': 'application/json' } }),
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '4097' },
      }),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response));
      await expect(
        checkMeshyAccount(state, spec, 40, credential, dependencies(fetch)),
      ).rejects.toThrow('invalid-response');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});

describe('operator command authority boundary', () => {
  // This integration test bundles code and starts several bounded Node processes;
  // coverage on Windows exceeds the default five-second unit-test allowance.
  it(
    'runs the compiled CLI against an isolated repository without network or credential output',
    { timeout: 30_000 },
    async () => {
      expect(spawnSync('git', ['init', '-q'], { cwd: directory }).status).toBe(0);
      const module = join(directory, 'packages', 'assets', 'dist', 'meshy-run-cli.mjs');
      const externalAliases = Object.fromEntries(
        ['sharp', 'gltf-validator'].map((name) => [
          name,
          pathToFileURL(createRequire(import.meta.url).resolve(name)).href,
        ]),
      );
      buildSync({
        entryPoints: [fileURLToPath(new URL('./meshy-run-cli.ts', import.meta.url))],
        outfile: module,
        bundle: true,
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
        // Match production's external native/Dart decoders, resolved from installed dependencies.
        external: Object.values(externalAliases),
        alias: externalAliases,
      });
      const specDirectory = join(directory, 'assets', 'aircraft', 'generation');
      await mkdir(specDirectory, { recursive: true });
      await writeFile(join(specDirectory, 'a320neo-t2-v1.json'), canonicalJson(spec));
      const approvalFile = join(directory, 'approval.json');
      await writeFile(approvalFile, canonicalJson(approval));
      const sentinel = 'msy_SYNTHETIC_CLI_TEST_ONLY';
      const run = (args: string[]) =>
        spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "const file=process.argv[1]; process.argv=[process.execPath,file,...process.argv.slice(2)]; globalThis.fetch=()=>{throw Error('TEST_NETWORK_BLOCKED');}; await import(file);",
            pathToFileURL(module).href,
            ...args,
          ],
          {
            encoding: 'utf8',
            timeout: 10_000,
            env: { ...process.env, MESHY_API_KEY: sentinel },
          },
        );
      const initialized = run(['init', '--approval-file', approvalFile]);
      expect(initialized.status, initialized.stderr.replaceAll(sentinel, '[redacted]')).toBe(0);
      const status = run(['status']);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        approvedMaxCredits: 40,
        reservedOrChargedCredits: 0,
      });
      for (const args of [
        ['init', '--approval-file', approvalFile],
        ['account', '--max-credits', '39'],
        ['account', '--max-credits', '40', '--api-key', sentinel],
        ['review', '--operation', 'candidate-1'],
      ]) {
        const result = run(args);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).not.toContain(sentinel);
        expect(result.stderr).not.toContain('TEST_NETWORK_BLOCKED');
        expect(result.stderr).toContain('invalid-input-or-run-state');
      }
      const cliDatabase = meshyRunDatabasePath(directory);
      const cliStore = new MeshyRunStore(cliDatabase);
      cliStore.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
      cliStore.observe(task());
      const source = pack(fixture());
      await syncMeshyCandidate(
        cliStore,
        meshyArchiveDirectory(cliDatabase),
        spec,
        40,
        'candidate-1',
        sentinel,
        {
          now: () => new Date(now),
          pause: () => Promise.resolve(),
          fetch: vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValueOnce(
              Response.json({
                id: task().taskId,
                type: 'image-to-3d',
                status: 'SUCCEEDED',
                consumed_credits: 5,
                created_at: Date.parse(now),
                finished_at: Date.parse(now),
                model_urls: { glb: 'https://assets.meshy.ai/fixture.glb' },
              }),
            )
            .mockResolvedValueOnce(
              new Response(new Uint8Array(source), {
                headers: { 'content-type': 'model/gltf-binary' },
              }),
            ),
        },
      );
      const priorState = canonicalJson(cliStore.read());
      const reviewed = run(['review', '--operation', 'candidate-1']);
      expect(reviewed.status, reviewed.stderr.replaceAll(sentinel, '[redacted]')).toBe(0);
      expect(JSON.parse(reviewed.stdout)).toMatchObject({
        components: 1,
        triangles: 4,
        state: 'quarantine',
        liveryReady: false,
        creditsSpentByThisCommand: 0,
      });
      expect(reviewed.stdout).not.toContain('sourceTriangles');
      expect(reviewed.stdout).not.toContain('boundaryEdges');
      expect(reviewed.stdout + reviewed.stderr).not.toContain(sentinel);
      expect(run(['review', '--operation', 'candidate-1']).stdout).toBe(reviewed.stdout);
      expect(canonicalJson(cliStore.read())).toBe(priorState);
    },
  );

  it.each(
    [
      [],
      ['generate'],
      ['reset'],
      ['init'],
      ['status', '--max-credits', '40'],
      ['account'],
      ['account', '--max-credits', '40', '--api-key', 'msy_SYNTHETIC_TEST_ONLY'],
      ['account', '--max-credits', '40', '--max-credits', '40'],
      ['account', '--max-credits', '1135'],
      ['account', '--max-credits', '40', '--root', 'elsewhere'],
    ].map((args) => ({ args })),
  )('refuses unsafe options before file/network access: $args', ({ args }) => {
    expect(() => parseMeshyRunArguments(args)).toThrow();
  });
  it('supports explicit initialization, status and capped account checks', () => {
    expect(parseMeshyRunArguments(['--', 'init', '--approval-file', 'private.json']).command).toBe(
      'init',
    );
    expect(parseMeshyRunArguments(['status']).command).toBe('status');
    expect(parseMeshyRunArguments(['account', '--max-credits', '40']).command).toBe('account');
  });
});
