import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';

/** Offline M6-25 policy. A proposed ceiling is never an approval to call the API. */
export const MESHY_FIRST_RUN_MAX_CREDITS = 40;
export const MeshyCreditCeiling = z.number().int().positive().max(MESHY_FIRST_RUN_MAX_CREDITS);
const Credits = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** No `latest`, remesh, Auto Split, multiview or implicit texturing in this strategy. */
export const MeshyGenerationSpec = z
  .object({
    format: z.literal('tailfin-meshy-generation-spec'),
    formatVersion: z.literal(1),
    id: z.literal('a320neo-t2-v1'),
    aircraftAssetId: z.literal('a320neo'),
    referencePrompt: z.string().trim().min(1).max(2_000),
    generation: z
      .object({
        model_type: z.literal('smart-topology'),
        ai_model: z.literal('meshy-t2'),
        target_polycount: z.number().int().min(100).max(15_000),
        should_texture: z.literal(false),
        target_formats: z.tuple([z.literal('glb')]),
      })
      .strict(),
    candidateCount: z.literal(4),
    retexture: z
      .object({
        // Meshy 7 is the pinned texturing model, not a geometry fallback.
        ai_model: z.literal('meshy-7'),
        enable_pbr: z.literal(true),
        // Source PBR UVs are made before Tailfin authors its canonical paint UVs.
        enable_original_uv: z.literal(false),
        texture_resolution: z.literal('4k'),
        text_style_prompt: z.string().trim().min(1).max(600),
      })
      .strict(),
    pricing: z
      .object({
        snapshotId: z.literal('meshy-api-2026-08-28'),
        observedAt: z.literal('2026-08-28'),
        source: z.literal('https://docs.meshy.ai/en/api/pricing'),
        untexturedCandidateCredits: z.literal(5),
        selectedRetextureCredits: z.literal(10),
      })
      .strict(),
  })
  .strict();
export type MeshyGenerationSpec = z.infer<typeof MeshyGenerationSpec>;

export const MeshyOperationId = z.enum([
  'candidate-1',
  'candidate-2',
  'candidate-3',
  'candidate-4',
  'retexture-selected',
]);
export type MeshyOperationId = z.infer<typeof MeshyOperationId>;

/**
 * A pure accounting kernel, NOT the durable execution ledger. M6-25 must add a
 * single-writer, write-ahead reservation store before any paid transport exists.
 * Uncertain submissions retain their full reservation; a smaller charge does
 * not free credit for a speculative retry. Overcharges remain observable.
 */
const MeshyBudget = z
  .object({
    specSha256: Sha256,
    maxCredits: MeshyCreditCeiling,
    entries: z
      .array(
        z
          .object({
            operationId: MeshyOperationId,
            reservedCredits: Credits.positive(),
            chargedCredits: Credits.nullable(),
          })
          .strict()
          .refine(
            (entry) =>
              entry.reservedCredits === (entry.operationId === 'retexture-selected' ? 10 : 5),
            'reservation must match the pinned operation price',
          ),
      )
      .max(5),
  })
  .strict()
  .refine(
    (budget) =>
      new Set(budget.entries.map((entry) => entry.operationId)).size === budget.entries.length,
    'duplicate operation reservation',
  );
export type MeshyBudget = z.infer<typeof MeshyBudget>;

export function meshySpecIdentity(spec: MeshyGenerationSpec): string {
  return sha256(canonicalJson(MeshyGenerationSpec.parse(spec)));
}

export function createMeshyBudget(spec: MeshyGenerationSpec, maxCredits: number): MeshyBudget {
  return MeshyBudget.parse({ specSha256: meshySpecIdentity(spec), maxCredits, entries: [] });
}

export function meshyCreditExposure(input: MeshyBudget): number {
  const budget = MeshyBudget.parse(input);
  return budget.entries.reduce(
    (sum, entry) => sum + Math.max(entry.reservedCredits, entry.chargedCredits ?? 0),
    0,
  );
}

export function reserveMeshyOperation(
  input: MeshyBudget,
  spec: MeshyGenerationSpec,
  operation: MeshyOperationId,
): MeshyBudget {
  const budget = MeshyBudget.parse(input);
  const parsedSpec = MeshyGenerationSpec.parse(spec);
  const operationId = MeshyOperationId.parse(operation);
  if (budget.specSha256 !== meshySpecIdentity(parsedSpec)) {
    throw new Error('The generation specification changed; this budget cannot be reused.');
  }
  if (budget.entries.some((entry) => entry.operationId === operationId)) {
    throw new Error('Operation already reserved; reconcile it instead of submitting again.');
  }
  const reservedCredits =
    operationId === 'retexture-selected'
      ? parsedSpec.pricing.selectedRetextureCredits
      : parsedSpec.pricing.untexturedCandidateCredits;
  if (meshyCreditExposure(budget) + reservedCredits > budget.maxCredits) {
    throw new Error('Meshy credit ceiling would be exceeded.');
  }
  if (
    budget.entries.some(
      (entry) => entry.chargedCredits !== null && entry.chargedCredits > entry.reservedCredits,
    )
  ) {
    throw new Error('Observed Meshy price exceeded its reservation; reconcile before continuing.');
  }
  return {
    ...budget,
    entries: [...budget.entries, { operationId, reservedCredits, chargedCredits: null }],
  };
}

export function recordMeshyCharge(
  input: MeshyBudget,
  operation: MeshyOperationId,
  chargedCredits: number,
): MeshyBudget {
  const budget = MeshyBudget.parse(input);
  const operationId = MeshyOperationId.parse(operation);
  Credits.parse(chargedCredits);
  const existing = budget.entries.find((entry) => entry.operationId === operationId);
  if (!existing) throw new Error('Cannot record a charge without a reservation.');
  if (existing.chargedCredits !== null && existing.chargedCredits !== chargedCredits) {
    throw new Error('Conflicting charge observation requires explicit reconciliation.');
  }
  return {
    ...budget,
    entries: budget.entries.map((entry) =>
      entry.operationId === operationId ? { ...entry, chargedCredits } : entry,
    ),
  };
}

export type MeshyCredentialStatus = 'missing' | 'present' | 'invalid' | 'unreadable';

/** Never return, interpolate, hash or otherwise expose a credential in a report. */
export function meshyCredentialStatus(value: string | undefined): MeshyCredentialStatus {
  if (value === undefined || value.trim() === '') return 'missing';
  return value.length <= 4_096 && /^msy_[A-Za-z0-9_-]+$/.test(value.trim()) ? 'present' : 'invalid';
}

export function createMeshyPreflight(
  input: unknown,
  credentialStatus: MeshyCredentialStatus,
  proposedMaxCredits?: number,
) {
  const parsed = MeshyGenerationSpec.safeParse(input);
  // Zod/JSON errors can contain caller-supplied values. Only a fixed error escapes.
  if (!parsed.success) throw new Error('Invalid Meshy generation specification.');
  const spec = parsed.data;
  const ceiling =
    proposedMaxCredits === undefined ? null : MeshyCreditCeiling.parse(proposedMaxCredits);
  const estimatedCredits =
    spec.candidateCount * spec.pricing.untexturedCandidateCredits +
    spec.pricing.selectedRetextureCredits;
  return {
    format: 'tailfin-meshy-preflight' as const,
    formatVersion: 1 as const,
    mode: 'offline-dry-run' as const,
    specId: spec.id,
    specSha256: meshySpecIdentity(spec),
    referencePromptSha256: sha256(spec.referencePrompt),
    retexturePromptSha256: sha256(spec.retexture.text_style_prompt),
    credentialStatus,
    accountAuthentication: 'not-checked' as const,
    apiCreditBalance: 'not-checked' as const,
    referenceImage: 'not-supplied' as const,
    licenceEvidence: 'not-verified' as const,
    candidateState: 'quarantine-only' as const,
    pricing: spec.pricing,
    operations: MeshyOperationId.options.map((operationId) => ({
      operationId,
      credits:
        operationId === 'retexture-selected'
          ? spec.pricing.selectedRetextureCredits
          : spec.pricing.untexturedCandidateCredits,
      requiresHumanSelection: operationId === 'retexture-selected',
    })),
    geometry: spec.generation,
    retexture: {
      ai_model: spec.retexture.ai_model,
      enable_pbr: spec.retexture.enable_pbr,
      enable_original_uv: spec.retexture.enable_original_uv,
      texture_resolution: spec.retexture.texture_resolution,
    },
    estimatedCredits,
    proposedMaxCredits: ceiling,
    planFitsProposedCeiling: ceiling === null ? null : estimatedCredits <= ceiling,
    requiresPriceRecheckBeforeLiveRun: true,
    spendAuthorized: false,
    liveExecutionAvailable: false,
    blockers: [
      ...(credentialStatus === 'present' ? [] : ['local-credential-not-ready']),
      ...(ceiling === null ? ['explicit-credit-ceiling-needed'] : []),
      ...(ceiling !== null && ceiling < estimatedCredits ? ['plan-exceeds-proposed-ceiling'] : []),
      'explicit-user-approval-not-recorded-by-dry-run',
      'live-client-and-durable-ledger-not-implemented',
      'api-pricing-and-balance-not-rechecked',
      'reference-image-rights-and-provenance-incomplete',
    ],
  };
}
