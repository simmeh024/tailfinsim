import { mkdir, opendir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  AIRCRAFT_ASSET_PIPELINE_VERSION,
  AIRCRAFT_RUNTIME_REGISTRY_FORMAT,
  AIRCRAFT_RUNTIME_REGISTRY_VERSION,
  AircraftRuntimeRegistry,
  AircraftRuntimeRegistryEntry,
  type AircraftRuntimeRegistry as AircraftRuntimeRegistryValue,
  type AircraftRuntimeRegistryEntry as AircraftRuntimeRegistryEntryValue,
} from '@tailfin/shared';

import { canonicalJson, sha256 } from './canonical';
import { AssetPipelineError, type AssetPipelineIssue } from './schema';

export const EMPTY_AIRCRAFT_RUNTIME_REGISTRY: AircraftRuntimeRegistryValue = {
  format: AIRCRAFT_RUNTIME_REGISTRY_FORMAT,
  formatVersion: AIRCRAFT_RUNTIME_REGISTRY_VERSION,
  pipelineVersion: AIRCRAFT_ASSET_PIPELINE_VERSION,
  activeAssetVersions: {},
  entries: [],
};

export function registryPath(root: string): string {
  return resolve(root, 'registry.json');
}

export async function readRegistry(root: string): Promise<AircraftRuntimeRegistryValue> {
  const input = JSON.parse(await readFile(registryPath(root), 'utf8')) as unknown;
  return AircraftRuntimeRegistry.parse(input);
}

async function atomicWrite(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

export async function writeRegistry(
  root: string,
  registry: AircraftRuntimeRegistryValue,
): Promise<void> {
  const parsed = AircraftRuntimeRegistry.parse(registry);
  await atomicWrite(registryPath(root), canonicalJson(parsed));
}

export async function upsertRegistryEntry(
  root: string,
  entryInput: AircraftRuntimeRegistryEntryValue,
): Promise<AircraftRuntimeRegistryValue> {
  const entry = AircraftRuntimeRegistryEntry.parse(entryInput);
  const registry = await readRegistry(root);
  const key = `${entry.asset.id}@${entry.asset.version}`;
  const existing = registry.entries.find(
    (candidate) => `${candidate.asset.id}@${candidate.asset.version}` === key,
  );
  if (existing && existing.runtime.contentIdentity !== entry.runtime.contentIdentity) {
    throw new Error(
      `${key} is immutable: registry has ${existing.runtime.contentIdentity}, intake produced ${entry.runtime.contentIdentity}`,
    );
  }
  const entries = [...registry.entries.filter((candidate) => candidate !== existing), entry].sort(
    (left, right) =>
      `${left.asset.id}@${left.asset.version}`.localeCompare(
        `${right.asset.id}@${right.asset.version}`,
      ),
  );
  const updated = AircraftRuntimeRegistry.parse({
    ...registry,
    activeAssetVersions: { ...registry.activeAssetVersions, [entry.asset.id]: entry.asset.version },
    entries,
  });
  await writeRegistry(root, updated);
  return updated;
}

export async function selectPreviousAssetVersion(
  root: string,
  assetId: string,
  version: string,
): Promise<AircraftRuntimeRegistryValue> {
  const registry = await readRegistry(root);
  const target = registry.entries.find(
    (entry) => entry.asset.id === assetId && entry.asset.version === version,
  );
  if (!target)
    throw new Error(`Cannot select ${assetId}@${version}: registry entry does not exist`);
  const updated = AircraftRuntimeRegistry.parse({
    ...registry,
    activeAssetVersions: { ...registry.activeAssetVersions, [assetId]: version },
  });
  await writeRegistry(root, updated);
  return updated;
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await listFiles(path)));
      else if (entry.isFile()) files.push(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return files;
}

function issue(code: string, path: string, message: string): AssetPipelineIssue {
  return { severity: 'error', code, path, message };
}

export async function verifyRegistry(root: string): Promise<AircraftRuntimeRegistryValue> {
  let registry: AircraftRuntimeRegistryValue;
  try {
    registry = await readRegistry(root);
  } catch (error) {
    throw new AssetPipelineError('Aircraft runtime registry is invalid', [
      issue(
        'invalid_registry',
        'registry.json',
        error instanceof Error ? error.message : String(error),
      ),
    ]);
  }
  const issues: AssetPipelineIssue[] = [];
  const registeredGlbs = new Set<string>();
  for (const entry of registry.entries) {
    for (const [kind, artifact] of Object.entries(entry.runtime).filter(
      ([key]) => key !== 'contentIdentity',
    ) as [
      'glb' | 'report' | 'comparisonThumbnail',
      AircraftRuntimeRegistryEntryValue['runtime']['glb'],
    ][]) {
      const fullPath = resolve(root, artifact.path);
      const fromRoot = relative(resolve(root), fullPath);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
        issues.push(issue('unsafe_registry_path', artifact.path, 'artifact escapes registry root'));
        continue;
      }
      try {
        const file = await readFile(fullPath);
        const fileStat = await stat(fullPath);
        if (fileStat.size !== artifact.byteSize) {
          issues.push(
            issue(
              'artifact_size_mismatch',
              artifact.path,
              `registry declares ${String(artifact.byteSize)}, file is ${String(fileStat.size)}`,
            ),
          );
        }
        if (sha256(file) !== artifact.sha256) {
          issues.push(
            issue('artifact_hash_mismatch', artifact.path, 'SHA-256 differs from registry'),
          );
        }
        if (kind === 'report') JSON.parse(file.toString('utf8')) as unknown;
        if (kind === 'glb') registeredGlbs.add(fullPath.toLowerCase());
      } catch (error) {
        issues.push(
          issue(
            'missing_or_invalid_artifact',
            artifact.path,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }
  for (const file of await listFiles(resolve(root, 'runtime'))) {
    if (file.toLowerCase().endsWith('.glb') && !registeredGlbs.has(file.toLowerCase())) {
      issues.push(
        issue(
          'orphan_runtime_glb',
          relative(root, file).split(sep).join('/'),
          'committed runtime GLB has no generated registry entry',
        ),
      );
    }
  }
  if (issues.length > 0)
    throw new AssetPipelineError('Aircraft registry verification failed', issues);
  return registry;
}

export { atomicWrite };
