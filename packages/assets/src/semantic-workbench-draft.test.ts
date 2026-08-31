import { describe, expect, it } from 'vitest';

import {
  parseSemanticWorkbenchDraft,
  semanticWorkbenchDraftKey,
  semanticWorkbenchDraftMaxBytes,
  type SemanticWorkbenchDraft,
} from './semantic-workbench-draft';

const identity = {
  operationId: 'candidate-1',
  derivativeSha256: 'a'.repeat(64),
  inventoryReportSha256: 'b'.repeat(64),
};

const draft: SemanticWorkbenchDraft = {
  format: 'tailfin-meshy-semantic-workbench-draft',
  formatVersion: 1,
  ...identity,
  reviewedAt: '2026-08-30T04:00:00.000Z',
  reviewedBy: 'local-operator',
  activeTargetId: 'fuselage',
  activeComponentId: 'review_component_001',
  floodAngle: 25,
  targetFindings: [{ targetId: 'fuselage', status: 'unreviewed' }],
  dispositions: [],
};

describe('semantic workbench local drafts', () => {
  it('uses the complete immutable identity in its storage key', () => {
    expect(semanticWorkbenchDraftKey(identity)).toBe(
      `tailfin:semantic-draft:v1:candidate-1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
    );
    const residualIdentity = {
      ...identity,
      residualReportSha256: 'c'.repeat(64),
      baselineReviewSha256: 'd'.repeat(64),
    };
    expect(semanticWorkbenchDraftKey(residualIdentity)).toBe(
      `tailfin:semantic-draft:v1:candidate-1:${'a'.repeat(64)}:${'b'.repeat(64)}:${'c'.repeat(64)}:${'d'.repeat(64)}`,
    );
    expect(
      parseSemanticWorkbenchDraft(
        JSON.stringify({
          ...draft,
          ...residualIdentity,
          activePatchIndex: 0,
          residualReviewedAt: '2026-08-31T04:00:00.000Z',
          patchDecisions: [
            {
              patchId: 'residual_patch_001',
              resolution: 'repair_into_new_derivative',
              rationale: 'This patch crosses multiple semantic surfaces.',
              evidenceViews: ['tail', 'top'],
            },
          ],
        }),
        residualIdentity,
      ),
    ).toMatchObject({ ...residualIdentity, activePatchIndex: 0 });
  });

  it('accepts a matching bounded draft without rewriting it', () => {
    expect(parseSemanticWorkbenchDraft(JSON.stringify(draft), identity)).toEqual(draft);
  });

  it('rejects stale identities, invalid controls and oversized storage', () => {
    expect(() =>
      parseSemanticWorkbenchDraft(
        JSON.stringify({ ...draft, derivativeSha256: 'c'.repeat(64) }),
        identity,
      ),
    ).toThrow('invalid or stale');
    expect(() =>
      parseSemanticWorkbenchDraft(JSON.stringify({ ...draft, floodAngle: 121 }), identity),
    ).toThrow('invalid or stale');
    expect(() =>
      parseSemanticWorkbenchDraft(' '.repeat(semanticWorkbenchDraftMaxBytes + 1), identity),
    ).toThrow('exceeds its bound');
    expect(() => parseSemanticWorkbenchDraft('null', identity)).toThrow('invalid or stale');
    expect(() =>
      parseSemanticWorkbenchDraft(
        JSON.stringify({ ...draft, targetFindings: new Array(65).fill(draft.targetFindings[0]) }),
        identity,
      ),
    ).toThrow('invalid or stale');
  });

  it('rejects malformed storage keys before touching local storage', () => {
    expect(() => semanticWorkbenchDraftKey({ ...identity, operationId: '../candidate-1' })).toThrow(
      'identity is invalid',
    );
    expect(() =>
      semanticWorkbenchDraftKey({ ...identity, residualReportSha256: 'c'.repeat(64) }),
    ).toThrow('identity is invalid');
    expect(() =>
      parseSemanticWorkbenchDraft(
        JSON.stringify({
          ...draft,
          patchDecisions: [
            {
              patchId: '../patch',
              resolution: 'unreviewed',
              rationale: '',
              evidenceViews: [],
            },
          ],
        }),
        identity,
      ),
    ).toThrow('invalid or stale');
  });
});
