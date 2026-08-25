import { z } from 'zod';

import { AircraftAssetSha256 } from './aircraft-asset';
import { LiveryAssetBinding, LiveryResourceId, LiveryResourceVersion } from './livery';

export const AIRCRAFT_RUNTIME_REGISTRY_FORMAT = 'tailfin-aircraft-runtime-registry' as const;
export const AIRCRAFT_RUNTIME_REGISTRY_VERSION = 1 as const;
export const AIRCRAFT_ASSET_PIPELINE_VERSION = '1.0.0' as const;

const RelativeArtifactPath = z
  .string()
  .min(1)
  .max(300)
  .regex(/^(?![a-z]+:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/i, 'must be a safe relative path');

export const AircraftRuntimeArtifact = z
  .object({
    path: RelativeArtifactPath,
    sha256: AircraftAssetSha256,
    byteSize: z.number().int().positive(),
  })
  .strict();
export type AircraftRuntimeArtifact = z.infer<typeof AircraftRuntimeArtifact>;

export const AircraftRuntimeStats = z
  .object({
    triangles: z.number().int().positive(),
    vertices: z.number().int().positive(),
    drawCalls: z.number().int().positive(),
    materials: z.number().int().positive(),
    textures: z.number().int().nonnegative(),
    textureMemoryBytes: z.number().int().nonnegative(),
    gpuGeometryBytes: z.number().int().positive(),
    boundsM: z
      .object({
        width: z.number().positive(),
        length: z.number().positive(),
        height: z.number().positive(),
      })
      .strict(),
    lods: z
      .array(
        z
          .object({
            level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
            nodeName: LiveryResourceId,
            triangles: z.number().int().positive(),
            liveryUvFingerprint: AircraftAssetSha256,
          })
          .strict(),
      )
      .length(3),
  })
  .strict()
  .superRefine((stats, context) => {
    const levels = new Set(stats.lods.map((lod) => lod.level));
    for (const level of [0, 1, 2] as const) {
      if (!levels.has(level)) {
        context.addIssue({
          code: 'custom',
          path: ['lods'],
          message: `missing LOD${String(level)} statistics`,
        });
      }
    }
  });
export type AircraftRuntimeStats = z.infer<typeof AircraftRuntimeStats>;

export const AircraftAssetBudgetException = z
  .object({
    issueUrl: z.url().regex(/^https:\/\/github\.com\/simmeh024\/tailfinsim\/issues\/\d+$/),
    approvedBy: z.string().trim().min(1).max(120),
    approvedAt: z.iso.date(),
    expiresAt: z.iso.date(),
    metrics: z
      .array(
        z.enum([
          'lod0Triangles',
          'drawCalls',
          'materials',
          'textureMemoryBytes',
          'boundsWidth',
          'boundsLength',
          'boundsHeight',
        ]),
      )
      .min(1),
    justification: z.string().trim().min(20).max(1_000),
  })
  .strict()
  .refine((exception) => exception.expiresAt >= exception.approvedAt, {
    message: 'expiresAt cannot precede approvedAt',
    path: ['expiresAt'],
  });
export type AircraftAssetBudgetException = z.infer<typeof AircraftAssetBudgetException>;

export const AircraftRuntimeRegistryEntry = z
  .object({
    asset: z.object({ id: LiveryResourceId, version: LiveryResourceVersion }).strict(),
    previousAssetVersion: LiveryResourceVersion.nullable(),
    source: z
      .object({
        manifestSha256: AircraftAssetSha256,
        fileSha256: AircraftAssetSha256,
      })
      .strict(),
    runtime: z
      .object({
        contentIdentity: AircraftAssetSha256,
        glb: AircraftRuntimeArtifact,
        report: AircraftRuntimeArtifact,
        comparisonThumbnail: AircraftRuntimeArtifact,
      })
      .strict(),
    stats: AircraftRuntimeStats,
    compatibility: z
      .object({
        rendererVersion: LiveryResourceVersion,
        liveryBinding: LiveryAssetBinding,
      })
      .strict(),
    pipeline: z
      .object({
        version: z.literal(AIRCRAFT_ASSET_PIPELINE_VERSION),
        gltfTransformVersion: z.string().min(1).max(32),
        gltfValidatorVersion: z.string().min(1).max(32),
        meshoptimizerVersion: z.string().min(1).max(32),
        optimisationDecisionSha256: AircraftAssetSha256,
      })
      .strict(),
    budgetException: AircraftAssetBudgetException.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    const prefix = `runtime/${entry.asset.id}/${entry.asset.version}/${entry.runtime.contentIdentity}`;
    const expected = {
      glb: `${prefix}/aircraft.glb`,
      report: `${prefix}/validation-report.json`,
      comparisonThumbnail: `${prefix}/comparison.svg`,
    } as const;
    for (const artifact of Object.keys(expected) as (keyof typeof expected)[]) {
      if (entry.runtime[artifact].path !== expected[artifact]) {
        context.addIssue({
          code: 'custom',
          path: ['runtime', artifact, 'path'],
          message: `path must be generated as "${expected[artifact]}"`,
        });
      }
    }
    const binding = entry.compatibility.liveryBinding.aircraftAsset;
    if (binding.id !== entry.asset.id || binding.version !== entry.asset.version) {
      context.addIssue({
        code: 'custom',
        path: ['compatibility', 'liveryBinding', 'aircraftAsset'],
        message: 'livery binding must select this exact aircraft asset version',
      });
    }
  });
export type AircraftRuntimeRegistryEntry = z.infer<typeof AircraftRuntimeRegistryEntry>;

export const AircraftRuntimeRegistry = z
  .object({
    format: z.literal(AIRCRAFT_RUNTIME_REGISTRY_FORMAT),
    formatVersion: z.literal(AIRCRAFT_RUNTIME_REGISTRY_VERSION),
    pipelineVersion: z.literal(AIRCRAFT_ASSET_PIPELINE_VERSION),
    activeAssetVersions: z.record(LiveryResourceId, LiveryResourceVersion),
    entries: z.array(AircraftRuntimeRegistryEntry),
  })
  .strict()
  .superRefine((registry, context) => {
    const entryByKey = new Map<string, AircraftRuntimeRegistryEntry>();
    const paths = new Set<string>();
    let previousKey = '';
    for (const [index, entry] of registry.entries.entries()) {
      const key = `${entry.asset.id}@${entry.asset.version}`;
      if (entryByKey.has(key)) {
        context.addIssue({ code: 'custom', path: ['entries', index], message: `duplicate ${key}` });
      }
      if (key.localeCompare(previousKey) < 0) {
        context.addIssue({
          code: 'custom',
          path: ['entries'],
          message: 'entries must be sorted by asset id and version',
        });
      }
      previousKey = key;
      entryByKey.set(key, entry);
      for (const artifact of [
        entry.runtime.glb,
        entry.runtime.report,
        entry.runtime.comparisonThumbnail,
      ]) {
        if (paths.has(artifact.path)) {
          context.addIssue({
            code: 'custom',
            path: ['entries', index, 'runtime'],
            message: `duplicate artifact path "${artifact.path}"`,
          });
        }
        paths.add(artifact.path);
      }
    }

    for (const [assetId, version] of Object.entries(registry.activeAssetVersions)) {
      if (!entryByKey.has(`${assetId}@${version}`)) {
        context.addIssue({
          code: 'custom',
          path: ['activeAssetVersions', assetId],
          message: 'active version has no registry entry',
        });
      }
    }
    for (const [index, entry] of registry.entries.entries()) {
      if (
        entry.previousAssetVersion !== null &&
        !entryByKey.has(`${entry.asset.id}@${entry.previousAssetVersion}`)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'previousAssetVersion'],
          message: 'previous version has no retained registry entry',
        });
      }
    }
  });
export type AircraftRuntimeRegistry = z.infer<typeof AircraftRuntimeRegistry>;
