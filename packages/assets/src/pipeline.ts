import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  AIRCRAFT_ASSET_PIPELINE_VERSION,
  AircraftRuntimeRegistryEntry,
  evaluateAircraftAssetSubmission,
  liveryAssetBindingFromManifest,
  type AircraftRuntimeRegistry,
  type AircraftRuntimeRegistryEntry as AircraftRuntimeRegistryEntryValue,
} from '@tailfin/shared';

import { canonicalJson, sha256 } from './canonical';
import {
  AIRCRAFT_ASSET_TOOL_VERSIONS,
  inspectRuntime,
  loadAndInspectSource,
  optimiseModel,
} from './model';
import { atomicWrite, readRegistry, upsertRegistryEntry } from './registry';
import {
  AircraftOptimisationDecision,
  AssetPipelineError,
  type AssetPipelineIssue,
} from './schema';
import { comparisonThumbnail } from './thumbnail';

export interface IntakeOptions {
  readonly manifestPath: string;
  readonly decisionPath: string;
  readonly root: string;
  readonly today?: string;
}

export interface IntakeResult {
  readonly entry: AircraftRuntimeRegistryEntryValue;
  readonly registry: AircraftRuntimeRegistry;
  readonly report: unknown;
}

function intakeIssues(
  status: string,
  issues: readonly { code: string; path: string; message: string }[],
): AssetPipelineIssue[] {
  return issues.map((issue) => ({ severity: 'error', ...issue, code: `${status}_${issue.code}` }));
}

function assertSemanticIdentity(
  source: Awaited<ReturnType<typeof loadAndInspectSource>>['stats'],
  runtime: Awaited<ReturnType<typeof inspectRuntime>>['stats'],
): void {
  const issues: AssetPipelineIssue[] = [];
  for (const metric of ['triangles', 'drawCalls', 'materials'] as const) {
    if (source[metric] !== runtime[metric]) {
      issues.push({
        severity: 'error',
        code: 'runtime_semantic_drift',
        path: `stats.${metric}`,
        message: `source ${String(source[metric])}, runtime ${String(runtime[metric])}`,
      });
    }
  }
  for (const dimension of ['width', 'length', 'height'] as const) {
    if (Math.abs(source.boundsM[dimension] - runtime.boundsM[dimension]) > 0.002) {
      issues.push({
        severity: 'error',
        code: 'runtime_bounds_drift',
        path: `stats.boundsM.${dimension}`,
        message: `source ${source.boundsM[dimension].toFixed(6)}, runtime ${runtime.boundsM[dimension].toFixed(6)}`,
      });
    }
  }
  for (const sourceLod of source.lods) {
    const runtimeLod = runtime.lods.find((lod) => lod.level === sourceLod.level);
    if (
      runtimeLod?.triangles !== sourceLod.triangles ||
      runtimeLod?.liveryUvFingerprint !== sourceLod.liveryUvFingerprint
    ) {
      issues.push({
        severity: 'error',
        code: 'runtime_livery_uv_drift',
        path: `stats.lods.${String(sourceLod.level)}`,
        message: 'optimisation changed LOD geometry count or livery UV placement',
      });
    }
  }
  if (issues.length > 0)
    throw new AssetPipelineError('Optimisation changed the asset contract', issues);
}

async function writeDeterministic(path: string, value: Uint8Array | string): Promise<void> {
  try {
    const existing = await readFile(path);
    const proposed = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    if (!existing.equals(proposed)) {
      throw new Error(
        `deterministic content identity collision at ${path}; bump the pipeline version before changing output`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await atomicWrite(path, value);
  }
}

export async function intakeAircraftAsset(options: IntakeOptions): Promise<IntakeResult> {
  const manifestInput = JSON.parse(await readFile(options.manifestPath, 'utf8')) as unknown;
  const intake = evaluateAircraftAssetSubmission(manifestInput);
  if (intake.status !== 'accepted') {
    throw new AssetPipelineError(
      `Aircraft manifest was not accepted: ${intake.status}`,
      intakeIssues(intake.status, intake.issues),
    );
  }
  const decisionInput = JSON.parse(await readFile(options.decisionPath, 'utf8')) as unknown;
  const decision = AircraftOptimisationDecision.parse(decisionInput);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const source = await loadAndInspectSource(options.manifestPath, decision, today);
  const manifestSha256 = sha256(canonicalJson(intake.manifest));
  const decisionSha256 = sha256(canonicalJson(decision));
  const contentIdentity = sha256(
    canonicalJson({
      format: 'tailfin-aircraft-runtime-content',
      formatVersion: 1,
      pipelineVersion: AIRCRAFT_ASSET_PIPELINE_VERSION,
      tools: AIRCRAFT_ASSET_TOOL_VERSIONS,
      sourceFileSha256: source.manifest.technical.delivery.fileSha256,
      manifestSha256,
      decisionSha256,
    }),
  );

  const runtimeBytes = await optimiseModel(source, decision);
  const runtime = await inspectRuntime(runtimeBytes, source.manifest, decision, today);
  const runtimeErrors = runtime.issues.filter((issue) => issue.severity === 'error');
  if (runtimeErrors.length > 0) {
    throw new AssetPipelineError('Optimised runtime asset failed validation', runtime.issues);
  }
  assertSemanticIdentity(source.stats, runtime.stats);

  const runtimeSha256 = sha256(runtimeBytes);
  const asset = source.manifest.technical.identity;
  const prefix = `runtime/${asset.assetId}/${asset.assetVersion}/${contentIdentity}`;
  const report = {
    format: 'tailfin-aircraft-validation-report',
    formatVersion: 1,
    pipelineVersion: AIRCRAFT_ASSET_PIPELINE_VERSION,
    contentIdentity,
    asset: { id: asset.assetId, version: asset.assetVersion },
    inputs: {
      sourceFile: source.manifest.technical.delivery.filePath,
      sourceFileSha256: source.manifest.technical.delivery.fileSha256,
      manifestSha256,
      optimisationDecisionSha256: decisionSha256,
    },
    tools: AIRCRAFT_ASSET_TOOL_VERSIONS,
    decision,
    source: {
      byteSize: source.bytes.byteLength,
      stats: source.stats,
      validator: source.officialReport,
      warnings: source.issues,
    },
    runtime: {
      sha256: runtimeSha256,
      byteSize: runtimeBytes.byteLength,
      stats: runtime.stats,
      validator: runtime.officialReport,
      warnings: runtime.issues,
    },
    verdict: 'accepted',
  } as const;
  const reportJson = canonicalJson(report);
  const thumbnail = comparisonThumbnail(
    source.document,
    runtime.document,
    source.manifest,
    `${String(source.stats.triangles)} tris · ${String(source.bytes.byteLength)} bytes`,
    `${String(runtime.stats.triangles)} tris · ${String(runtimeBytes.byteLength)} bytes`,
  );

  const registry = await readRegistry(options.root);
  const existing = registry.entries.find(
    (entry) => entry.asset.id === asset.assetId && entry.asset.version === asset.assetVersion,
  );
  const activeVersion = registry.activeAssetVersions[asset.assetId] ?? null;
  const previousAssetVersion =
    existing?.previousAssetVersion ?? (activeVersion === asset.assetVersion ? null : activeVersion);
  const entry = AircraftRuntimeRegistryEntry.parse({
    asset: { id: asset.assetId, version: asset.assetVersion },
    previousAssetVersion,
    source: {
      manifestSha256,
      fileSha256: source.manifest.technical.delivery.fileSha256,
    },
    runtime: {
      contentIdentity,
      glb: {
        path: `${prefix}/aircraft.glb`,
        sha256: runtimeSha256,
        byteSize: runtimeBytes.byteLength,
      },
      report: {
        path: `${prefix}/validation-report.json`,
        sha256: sha256(reportJson),
        byteSize: Buffer.byteLength(reportJson),
      },
      comparisonThumbnail: {
        path: `${prefix}/comparison.svg`,
        sha256: sha256(thumbnail),
        byteSize: Buffer.byteLength(thumbnail),
      },
    },
    stats: runtime.stats,
    compatibility: {
      rendererVersion: decision.rendererCompatibilityVersion,
      liveryBinding: liveryAssetBindingFromManifest(
        source.manifest,
        `aircraft/${asset.assetId}/${asset.assetVersion}`,
      ),
    },
    pipeline: {
      version: AIRCRAFT_ASSET_PIPELINE_VERSION,
      gltfTransformVersion: AIRCRAFT_ASSET_TOOL_VERSIONS.gltfTransform,
      gltfValidatorVersion: AIRCRAFT_ASSET_TOOL_VERSIONS.gltfValidator,
      meshoptimizerVersion: AIRCRAFT_ASSET_TOOL_VERSIONS.meshoptimizer,
      optimisationDecisionSha256: decisionSha256,
    },
    budgetException: decision.budgetException,
  });

  await writeDeterministic(resolve(options.root, entry.runtime.glb.path), runtimeBytes);
  await writeDeterministic(resolve(options.root, entry.runtime.report.path), reportJson);
  await writeDeterministic(
    resolve(options.root, entry.runtime.comparisonThumbnail.path),
    thumbnail,
  );
  const updatedRegistry = await upsertRegistryEntry(options.root, entry);
  return { entry, registry: updatedRegistry, report };
}
