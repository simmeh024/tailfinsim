const MAX_DRAFT_BYTES = 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const OPERATION = /^candidate-[1-4]$/;

export interface SemanticWorkbenchDraftIdentity {
  operationId: string;
  derivativeSha256: string;
  inventoryReportSha256: string;
  residualReportSha256?: string;
  baselineReviewSha256?: string;
}

export interface SemanticWorkbenchDraft extends SemanticWorkbenchDraftIdentity {
  format: 'tailfin-meshy-semantic-workbench-draft';
  formatVersion: 1;
  reviewedAt: string;
  reviewedBy: string;
  activeTargetId: string;
  activeComponentId: string;
  floodAngle: number;
  targetFindings: { targetId: string; status: string; rationale?: string }[];
  dispositions: {
    targetId: string;
    componentId: string;
    ranges: { startInclusive: number; endExclusive: number }[];
  }[];
  activePatchIndex?: number;
  residualReviewedAt?: string;
  patchDecisions?: {
    patchId: string;
    resolution:
      'unreviewed' | 'assign_existing_geometry' | 'discard_artifact' | 'repair_into_new_derivative';
    semanticTargetId?: string;
    rationale: string;
    evidenceViews: string[];
  }[];
}

function validIdentity(identity: SemanticWorkbenchDraftIdentity) {
  return (
    OPERATION.test(identity.operationId) &&
    DIGEST.test(identity.derivativeSha256) &&
    DIGEST.test(identity.inventoryReportSha256) &&
    (identity.residualReportSha256 === undefined || DIGEST.test(identity.residualReportSha256)) &&
    (identity.baselineReviewSha256 === undefined || DIGEST.test(identity.baselineReviewSha256)) &&
    (identity.residualReportSha256 === undefined) === (identity.baselineReviewSha256 === undefined)
  );
}

/** Scope browser storage to one exact immutable candidate and inventory. */
export function semanticWorkbenchDraftKey(identity: SemanticWorkbenchDraftIdentity) {
  if (!validIdentity(identity)) throw new Error('Semantic workbench draft identity is invalid.');
  const evidence = identity.residualReportSha256
    ? `:${identity.residualReportSha256}:${identity.baselineReviewSha256}`
    : '';
  return `tailfin:semantic-draft:v1:${identity.operationId}:${identity.derivativeSha256}:${identity.inventoryReportSha256}${evidence}`;
}

/** Parse only a bounded, exact-identity draft; detailed face validation remains atomic at restore. */
export function parseSemanticWorkbenchDraft(
  text: string,
  identity: SemanticWorkbenchDraftIdentity,
): SemanticWorkbenchDraft {
  if (new TextEncoder().encode(text).length > MAX_DRAFT_BYTES)
    throw new Error('Semantic workbench draft exceeds its bound.');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Semantic workbench draft is invalid or stale.');
  const value = parsed as Partial<SemanticWorkbenchDraft>;
  if (
    !validIdentity(identity) ||
    value.format !== 'tailfin-meshy-semantic-workbench-draft' ||
    value.formatVersion !== 1 ||
    value.operationId !== identity.operationId ||
    value.derivativeSha256 !== identity.derivativeSha256 ||
    value.inventoryReportSha256 !== identity.inventoryReportSha256 ||
    value.residualReportSha256 !== identity.residualReportSha256 ||
    value.baselineReviewSha256 !== identity.baselineReviewSha256 ||
    typeof value.reviewedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.reviewedAt)) ||
    typeof value.reviewedBy !== 'string' ||
    typeof value.activeTargetId !== 'string' ||
    typeof value.activeComponentId !== 'string' ||
    !Number.isInteger(value.floodAngle) ||
    value.floodAngle! < 1 ||
    value.floodAngle! > 120 ||
    !Array.isArray(value.targetFindings) ||
    value.targetFindings.length > 64 ||
    !Array.isArray(value.dispositions) ||
    value.dispositions.length > 4096 ||
    (value.activePatchIndex !== undefined &&
      (!Number.isInteger(value.activePatchIndex) ||
        value.activePatchIndex < 0 ||
        value.activePatchIndex >= 100_000)) ||
    (value.residualReviewedAt !== undefined &&
      (typeof value.residualReviewedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.residualReviewedAt)))) ||
    (value.patchDecisions !== undefined &&
      (!identity.residualReportSha256 ||
        !Array.isArray(value.patchDecisions) ||
        value.patchDecisions.length > 100_000 ||
        value.patchDecisions.some(
          (decision) =>
            !decision ||
            typeof decision !== 'object' ||
            !/^residual_patch_\d{3,6}$/.test(decision.patchId) ||
            ![
              'unreviewed',
              'assign_existing_geometry',
              'discard_artifact',
              'repair_into_new_derivative',
            ].includes(decision.resolution) ||
            (decision.semanticTargetId !== undefined &&
              typeof decision.semanticTargetId !== 'string') ||
            typeof decision.rationale !== 'string' ||
            decision.rationale.length > 500 ||
            !Array.isArray(decision.evidenceViews) ||
            decision.evidenceViews.length > 10 ||
            decision.evidenceViews.some((view) => typeof view !== 'string'),
        )))
  ) {
    throw new Error('Semantic workbench draft is invalid or stale.');
  }
  return value as SemanticWorkbenchDraft;
}

export const semanticWorkbenchDraftMaxBytes = MAX_DRAFT_BYTES;
