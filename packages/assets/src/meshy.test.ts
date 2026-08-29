import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MeshyGenerationSpec,
  MeshyOperationId,
  createMeshyBudget,
  createMeshyPreflight,
  meshyCredentialStatus,
  meshyCreditExposure,
  meshySpecIdentity,
  recordMeshyCharge,
  reserveMeshyOperation,
} from './meshy';
import { readBoundedMeshyBytes, readBoundedMeshyInput, runMeshyPreflight } from './meshy-preflight';

const spec = MeshyGenerationSpec.parse(
  JSON.parse(
    await readFile(
      new URL('../../../assets/aircraft/generation/a320neo-t2-v1.json', import.meta.url),
      'utf8',
    ),
  ),
);

afterEach(() => vi.unstubAllGlobals());

describe('pinned Meshy strategy', () => {
  it('estimates exactly four untextured candidates and one selected 4K PBR retexture', () => {
    const plan = createMeshyPreflight(spec, 'present', 40);
    expect(plan.estimatedCredits).toBe(30);
    expect(plan.operations.map((operation) => operation.credits)).toEqual([5, 5, 5, 5, 10]);
    expect(plan.operations.filter((operation) => operation.requiresHumanSelection)).toHaveLength(1);
    expect(plan.geometry).toMatchObject({
      model_type: 'smart-topology',
      ai_model: 'meshy-t2',
      target_polycount: 15_000,
      should_texture: false,
    });
    expect(plan.retexture).toMatchObject({ enable_pbr: true, texture_resolution: '4k' });
    expect(plan.planFitsProposedCeiling).toBe(true);
  });

  it.each([
    { ai_model: 'latest' },
    { ai_model: 'meshy-t1' },
    { model_type: 'standard' },
    { target_polycount: 15_001 },
    { target_polycount: 99 },
    { target_polycount: 1_000.5 },
    { should_texture: true },
    { should_remesh: true },
    { topology: 'quad' },
    { symmetry_mode: 'on' },
    { image_urls: ['https://example.com/reference.png'] },
  ])('rejects a changed/unsupported generation setting: %j', (change) => {
    expect(() =>
      createMeshyPreflight({ ...spec, generation: { ...spec.generation, ...change } }, 'missing'),
    ).toThrow('Invalid Meshy generation specification');
  });

  it('rejects price drift, extra candidates and an 8K retexture', () => {
    for (const changed of [
      { ...spec, pricing: { ...spec.pricing, untexturedCandidateCredits: 4 } },
      { ...spec, candidateCount: 5 },
      { ...spec, retexture: { ...spec.retexture, texture_resolution: '8k' } },
    ]) {
      expect(() => createMeshyPreflight(changed, 'missing')).toThrow();
    }
  });

  it('canonicalizes config order but binds all prompts/settings into the identity', () => {
    const reversed = Object.fromEntries(Object.entries(spec).reverse());
    expect(meshySpecIdentity(MeshyGenerationSpec.parse(reversed))).toBe(meshySpecIdentity(spec));
    expect(
      meshySpecIdentity({ ...spec, referencePrompt: `${spec.referencePrompt} New angle.` }),
    ).not.toBe(meshySpecIdentity(spec));
  });

  it('never treats local key presence or a proposed ceiling as account/spend approval', () => {
    expect(createMeshyPreflight(spec, 'present', 40)).toMatchObject({
      spendAuthorized: false,
      liveExecutionAvailable: false,
      accountAuthentication: 'not-checked',
      apiCreditBalance: 'not-checked',
      licenceEvidence: 'not-verified',
      requiresPriceRecheckBeforeLiveRun: true,
    });
    expect(createMeshyPreflight(spec, 'missing').planFitsProposedCeiling).toBeNull();
    expect(createMeshyPreflight(spec, 'present', 29).planFitsProposedCeiling).toBe(false);
  });
});

describe('conservative, offline budget accounting', () => {
  it.each([0, -1, 41, 1_135, 30.5, NaN, Infinity])('rejects an invalid ceiling %s', (cap) => {
    expect(() => createMeshyBudget(spec, cap)).toThrow();
  });

  it('reserves the complete plan at exactly 30, and refuses the final operation at 29', () => {
    let exact = createMeshyBudget(spec, 30);
    let short = createMeshyBudget(spec, 29);
    for (const operation of MeshyOperationId.options) {
      exact = reserveMeshyOperation(exact, spec, operation);
      if (operation !== 'retexture-selected') short = reserveMeshyOperation(short, spec, operation);
    }
    expect(meshyCreditExposure(exact)).toBe(30);
    expect(() => reserveMeshyOperation(short, spec, 'retexture-selected')).toThrow('ceiling');
    expect(meshyCreditExposure(short)).toBe(20);
  });

  it('retains unknown/failed reservations and rejects duplicate attempts', () => {
    const original = createMeshyBudget(spec, 5);
    const reserved = reserveMeshyOperation(original, spec, 'candidate-1');
    expect(original.entries).toEqual([]);
    expect(reserved.entries[0]?.chargedCredits).toBeNull();
    const zeroReported = recordMeshyCharge(reserved, 'candidate-1', 0);
    expect(meshyCreditExposure(zeroReported)).toBe(5);
    expect(() => reserveMeshyOperation(zeroReported, spec, 'candidate-2')).toThrow('ceiling');
    expect(() => reserveMeshyOperation(reserved, spec, 'candidate-1')).toThrow('already reserved');
  });

  it('records unexpected charges without losing them and refuses further spending', () => {
    const reserved = reserveMeshyOperation(createMeshyBudget(spec, 40), spec, 'candidate-1');
    const overcharged = recordMeshyCharge(reserved, 'candidate-1', 42);
    expect(meshyCreditExposure(overcharged)).toBe(42);
    expect(() => reserveMeshyOperation(overcharged, spec, 'candidate-2')).toThrow('ceiling');
    expect(recordMeshyCharge(overcharged, 'candidate-1', 42)).toEqual(overcharged);
    expect(() => recordMeshyCharge(overcharged, 'candidate-1', 5)).toThrow('Conflicting');
    expect(() => recordMeshyCharge(reserved, 'candidate-2', 5)).toThrow('without a reservation');
    expect(() => recordMeshyCharge(reserved, 'candidate-1', -1)).toThrow();
  });

  it('rejects changed specs and understated/duplicated reservation data', () => {
    const reserved = reserveMeshyOperation(createMeshyBudget(spec, 40), spec, 'candidate-1');
    expect(() =>
      reserveMeshyOperation(reserved, { ...spec, referencePrompt: 'changed' }, 'candidate-2'),
    ).toThrow('specification changed');
    expect(() =>
      meshyCreditExposure({
        ...reserved,
        entries: [{ operationId: 'candidate-1', reservedCredits: 1, chargedCredits: null }],
      }),
    ).toThrow();
    expect(() =>
      meshyCreditExposure({ ...reserved, entries: [...reserved.entries, ...reserved.entries] }),
    ).toThrow();
  });

  it('halts on price drift even when an unexpected charge still fits the ceiling', () => {
    const reserved = reserveMeshyOperation(createMeshyBudget(spec, 40), spec, 'candidate-1');
    const drifted = recordMeshyCharge(reserved, 'candidate-1', 6);
    expect(meshyCreditExposure(drifted)).toBe(6);
    expect(() => reserveMeshyOperation(drifted, spec, 'candidate-2')).toThrow(
      'reconcile before continuing',
    );
  });
});

describe('offline CLI and credential boundary', () => {
  const sentinel = 'msy_SYNTHETIC_TEST_ONLY_DO_NOT_USE';
  const io = {
    readText: (path: string) =>
      Promise.resolve(path === 'credential-file' ? sentinel : JSON.stringify(spec)),
  };

  it('has no network activity and emits neither key, path nor prompt bytes', async () => {
    const network = vi.fn(() => {
      throw new Error('network must never run');
    });
    vi.stubGlobal('fetch', network);
    const text = await runMeshyPreflight(
      ['--', '--dry-run', '--max-credits', '40', '--key-file', 'credential-file'],
      {},
      io,
    );
    expect(JSON.parse(text)).toMatchObject({
      credentialStatus: 'present',
      estimatedCredits: 30,
      spendAuthorized: false,
    });
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain('credential-file');
    expect(text).not.toContain(spec.referencePrompt);
    expect(text).not.toContain(spec.retexture.text_style_prompt);
    expect(network).not.toHaveBeenCalled();
  });

  it('uses only the explicitly chosen file or the environment, never scans files', async () => {
    const readText = vi.fn(io.readText);
    const fromEnv = JSON.parse(
      await runMeshyPreflight(['--dry-run'], { MESHY_API_KEY: sentinel }, { readText }),
    ) as unknown;
    expect(fromEnv).toMatchObject({ credentialStatus: 'present', proposedMaxCredits: null });
    expect(readText).toHaveBeenCalledTimes(1);
    const missing = JSON.parse(await runMeshyPreflight(['--dry-run'], {}, io)) as unknown;
    expect(missing).toMatchObject({ credentialStatus: 'missing' });
  });

  it.each([undefined, '', '   '])('reports empty credentials as missing', (key) => {
    expect(meshyCredentialStatus(key)).toBe('missing');
  });

  it.each(['wrong-shape', `${sentinel}\nother text`, 'msy_' + 'a'.repeat(4_096)])(
    'rejects malformed key shape without echo',
    (key) => {
      expect(meshyCredentialStatus(key)).toBe('invalid');
    },
  );

  it.each(
    [
      [],
      ['--live'],
      ['--dry-run', '--api-key', sentinel],
      ['--dry-run', '--max-credits'],
      ['--dry-run', '--max-credits', '1135'],
      ['--dry-run', '--max-credits', '30.0'],
      ['--dry-run', '--max-credits', '4e1'],
      ['--dry-run', '--dry-run'],
      ['--dry-run', '--max-credits', '30', '--max-credits', '40'],
    ].map((args) => ({ args })),
  )('refuses unsupported/ambiguous arguments before any file read', async ({ args }) => {
    const readText = vi.fn(io.readText);
    await expect(runMeshyPreflight(args, {}, { readText })).rejects.toThrow();
    expect(readText).not.toHaveBeenCalled();
  });

  it('bounds real file reads and rejects directories, missing files and oversized inputs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tailfin-meshy-preflight-test-'));
    const path = join(directory, 'synthetic.txt');
    try {
      await writeFile(path, sentinel);
      expect(await readBoundedMeshyInput(path, sentinel.length)).toBe(sentinel);
      expect(await readBoundedMeshyBytes(path, sentinel.length)).toEqual(Buffer.from(sentinel));
      await expect(readBoundedMeshyInput(path, sentinel.length - 1)).rejects.toThrow();
      await expect(readBoundedMeshyInput(directory, 4096)).rejects.toThrow();
      await expect(readBoundedMeshyInput(join(directory, 'missing.txt'), 4096)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('redacts parser/filesystem errors and still reports unreadable credentials safely', async () => {
    const failed = {
      readText: () => Promise.reject(new Error(sentinel)),
    };
    await expect(runMeshyPreflight(['--dry-run'], {}, failed)).rejects.toThrow(
      'Cannot read a valid bounded Meshy specification.',
    );
    const readText = (path: string) =>
      path === 'credential-file'
        ? Promise.reject(new Error(sentinel))
        : Promise.resolve(JSON.stringify(spec));
    const text = await runMeshyPreflight(
      ['--dry-run', '--key-file', 'credential-file'],
      {},
      { readText },
    );
    expect(JSON.parse(text)).toMatchObject({ credentialStatus: 'unreadable' });
    expect(text).not.toContain(sentinel);
    const corrupt = { readText: () => Promise.resolve(sentinel) };
    await expect(runMeshyPreflight(['--dry-run'], {}, corrupt)).rejects.toThrow(
      'Cannot read a valid bounded Meshy specification.',
    );
  });
});
