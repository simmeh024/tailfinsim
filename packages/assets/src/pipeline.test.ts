import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical';
import { intakeAircraftAsset } from './pipeline';
import { selectPreviousAssetVersion, verifyRegistry } from './registry';
import { AssetPipelineError } from './schema';
import { createAircraftAssetFixture } from './test-fixture';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tailfin-aircraft-assets-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('the deterministic aircraft asset pipeline', () => {
  it('produces byte-identical output, generated paths and a complete review report', async () => {
    const first = await createAircraftAssetFixture(await temporaryDirectory());
    const second = await createAircraftAssetFixture(await temporaryDirectory());
    const firstResult = await intakeAircraftAsset({
      manifestPath: first.manifestPath,
      decisionPath: first.decisionPath,
      root: first.registryRoot,
      today: '2026-08-25',
    });
    const secondResult = await intakeAircraftAsset({
      manifestPath: second.manifestPath,
      decisionPath: second.decisionPath,
      root: second.registryRoot,
      today: '2026-08-25',
    });

    expect(firstResult.entry.runtime.contentIdentity).toBe(
      secondResult.entry.runtime.contentIdentity,
    );
    expect(firstResult.entry.runtime.glb.path).toBe(
      `runtime/a220-300/1.0.0/${firstResult.entry.runtime.contentIdentity}/aircraft.glb`,
    );
    for (const artifact of ['glb', 'report', 'comparisonThumbnail'] as const) {
      const firstBytes = await readFile(
        resolve(first.registryRoot, firstResult.entry.runtime[artifact].path),
      );
      const secondBytes = await readFile(
        resolve(second.registryRoot, secondResult.entry.runtime[artifact].path),
      );
      expect(firstBytes.equals(secondBytes)).toBe(true);
    }
    await expect(verifyRegistry(first.registryRoot)).resolves.toMatchObject({
      activeAssetVersions: { 'a220-300': '1.0.0' },
      entries: [{ asset: { id: 'a220-300', version: '1.0.0' } }],
    });
    expect(firstResult.report).toMatchObject({
      verdict: 'accepted',
      runtime: { stats: { triangles: 6, drawCalls: 1 } },
    });
  }, 15_000);

  it('rejects out-of-range livery UVs with an actionable project error', async () => {
    const fixture = await createAircraftAssetFixture(await temporaryDirectory(), {
      outOfRangeUv: true,
    });
    const error = await intakeAircraftAsset({
      manifestPath: fixture.manifestPath,
      decisionPath: fixture.decisionPath,
      root: fixture.registryRoot,
      today: '2026-08-25',
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssetPipelineError);
    expect((error as AssetPipelineError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'livery_uv_out_of_range' })]),
    );
  });

  it('rejects undeclared network dependencies before any resource is fetched', async () => {
    const fixture = await createAircraftAssetFixture(await temporaryDirectory(), {
      unsafeExternalUri: true,
    });
    const error = await intakeAircraftAsset({
      manifestPath: fixture.manifestPath,
      decisionPath: fixture.decisionPath,
      root: fixture.registryRoot,
      today: '2026-08-25',
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssetPipelineError);
    expect((error as AssetPipelineError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'undeclared_external_uri' }),
        expect.objectContaining({ code: 'unsafe_external_uri' }),
      ]),
    );
  });

  it('rejects a pilot asset whose protected materials and geometry features are absent', async () => {
    const fixture = await createAircraftAssetFixture(await temporaryDirectory(), {
      designation: 'A320neo',
    });
    const error = await intakeAircraftAsset({
      manifestPath: fixture.manifestPath,
      decisionPath: fixture.decisionPath,
      root: fixture.registryRoot,
      today: '2026-08-25',
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssetPipelineError);
    expect((error as AssetPipelineError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_model_missing_pilot_material' }),
      ]),
    );
  });

  it('retains both versions when the active selection rolls back', async () => {
    const directory = await temporaryDirectory();
    const first = await createAircraftAssetFixture(directory, { assetVersion: '1.0.0' });
    await intakeAircraftAsset({
      manifestPath: first.manifestPath,
      decisionPath: first.decisionPath,
      root: first.registryRoot,
      today: '2026-08-25',
    });
    const second = await createAircraftAssetFixture(directory, { assetVersion: '2.0.0' });
    const secondResult = await intakeAircraftAsset({
      manifestPath: second.manifestPath,
      decisionPath: second.decisionPath,
      root: second.registryRoot,
      today: '2026-08-25',
    });
    expect(secondResult.entry.previousAssetVersion).toBe('1.0.0');

    const rolledBack = await selectPreviousAssetVersion(second.registryRoot, 'a220-300', '1.0.0');
    expect(rolledBack.activeAssetVersions['a220-300']).toBe('1.0.0');
    expect(rolledBack.entries).toHaveLength(2);
    expect(
      rolledBack.entries.find((entry) => entry.asset.version === '2.0.0')?.compatibility
        .liveryBinding.aircraftAsset,
    ).toEqual({ id: 'a220-300', version: '2.0.0' });
  });

  it('fails CI validation for an unregistered runtime GLB', async () => {
    const fixture = await createAircraftAssetFixture(await temporaryDirectory());
    const orphan = resolve(fixture.registryRoot, 'runtime', 'orphan.glb');
    await writeFile(
      resolve(fixture.registryRoot, 'registry.json'),
      canonicalJson({
        activeAssetVersions: {},
        entries: [],
        format: 'tailfin-aircraft-runtime-registry',
        formatVersion: 1,
        pipelineVersion: '1.0.0',
      }),
    );
    await mkdir(resolve(orphan, '..'), { recursive: true });
    await writeFile(orphan, Buffer.from('orphan'));
    const error = await verifyRegistry(fixture.registryRoot).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AssetPipelineError);
    expect((error as AssetPipelineError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'orphan_runtime_glb' })]),
    );
  });
});
