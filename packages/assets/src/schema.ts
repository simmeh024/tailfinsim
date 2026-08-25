import { z } from 'zod';

import { AircraftAssetBudgetException, AircraftAssetSha256 } from '@tailfin/shared';

export const AIRCRAFT_OPTIMISATION_DECISION_FORMAT =
  'tailfin-aircraft-optimisation-decision' as const;
export const AIRCRAFT_OPTIMISATION_DECISION_VERSION = 1 as const;

const MeasurementEvidence = z
  .object({
    pilotAssets: z.array(z.string().trim().min(1).max(128)).min(1),
    sourceBytes: z.number().int().positive(),
    runtimeBytes: z.number().int().positive(),
    gpuUploadMsP95: z.number().nonnegative(),
    visualReview: z.string().trim().min(20).max(1_000),
    measuredBy: z.string().trim().min(1).max(120),
    measuredAt: z.iso.date(),
  })
  .strict();

export const AircraftOptimisationDecision = z
  .object({
    format: z.literal(AIRCRAFT_OPTIMISATION_DECISION_FORMAT),
    formatVersion: z.literal(AIRCRAFT_OPTIMISATION_DECISION_VERSION),
    sourceFileSha256: AircraftAssetSha256,
    rendererCompatibilityVersion: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    geometry: z
      .object({
        mode: z.enum(['lossless', 'meshopt_lossless']),
        evidence: MeasurementEvidence,
      })
      .strict(),
    textures: z
      .object({
        mode: z.enum(['retain', 'ktx2_passthrough']),
        evidence: MeasurementEvidence,
      })
      .strict(),
    allow: z
      .object({
        animations: z.array(z.string().trim().min(1).max(128)).max(16),
        cameras: z.array(z.string().trim().min(1).max(128)).max(16),
        lights: z.array(z.string().trim().min(1).max(128)).max(32),
        metadataOwners: z.array(z.string().trim().min(1).max(128)).max(32),
      })
      .strict(),
    budgetException: AircraftAssetBudgetException.nullable(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      decision.geometry.mode === 'meshopt_lossless' &&
      decision.geometry.evidence.runtimeBytes >= decision.geometry.evidence.sourceBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['geometry', 'evidence', 'runtimeBytes'],
        message: 'Meshopt requires measured byte savings',
      });
    }
    if (decision.textures.mode === 'ktx2_passthrough') {
      if (decision.textures.evidence.runtimeBytes >= decision.textures.evidence.sourceBytes) {
        context.addIssue({
          code: 'custom',
          path: ['textures', 'evidence', 'runtimeBytes'],
          message: 'KTX2 requires measured byte savings',
        });
      }
      if (decision.textures.evidence.gpuUploadMsP95 <= 0) {
        context.addIssue({
          code: 'custom',
          path: ['textures', 'evidence', 'gpuUploadMsP95'],
          message: 'KTX2 evidence must include a measured upload time',
        });
      }
    }
  });
export type AircraftOptimisationDecision = z.infer<typeof AircraftOptimisationDecision>;

export const AssetPipelineIssue = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: z.string().min(1),
    path: z.string(),
    message: z.string().min(1),
  })
  .strict();
export type AssetPipelineIssue = z.infer<typeof AssetPipelineIssue>;

export class AssetPipelineError extends Error {
  readonly issues: readonly AssetPipelineIssue[];

  constructor(message: string, issues: readonly AssetPipelineIssue[]) {
    super(message);
    this.name = 'AssetPipelineError';
    this.issues = issues;
  }
}
