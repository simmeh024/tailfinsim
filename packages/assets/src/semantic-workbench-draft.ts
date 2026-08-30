const MAX_DRAFT_BYTES = 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const OPERATION = /^candidate-[1-4]$/;

export interface SemanticWorkbenchDraftIdentity {
  operationId: string;
  derivativeSha256: string;
  inventoryReportSha256: string;
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
}

function validIdentity(identity: SemanticWorkbenchDraftIdentity) {
  return (
    OPERATION.test(identity.operationId) &&
    DIGEST.test(identity.derivativeSha256) &&
    DIGEST.test(identity.inventoryReportSha256)
  );
}

/** Scope browser storage to one exact immutable candidate and inventory. */
export function semanticWorkbenchDraftKey(identity: SemanticWorkbenchDraftIdentity) {
  if (!validIdentity(identity)) throw new Error('Semantic workbench draft identity is invalid.');
  return `tailfin:semantic-draft:v1:${identity.operationId}:${identity.derivativeSha256}:${identity.inventoryReportSha256}`;
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
    value.dispositions.length > 4096
  ) {
    throw new Error('Semantic workbench draft is invalid or stale.');
  }
  return value as SemanticWorkbenchDraft;
}

export const semanticWorkbenchDraftMaxBytes = MAX_DRAFT_BYTES;
