import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { buildFlatMeshyParts } from './meshy-correction';
import { MESHY_SEMANTIC_TARGETS } from './meshy-semantic-inventory';
import { assessMeshySemanticRepairSubmission } from './meshy-semantic-repair-intake';

const digest = (character: string) => character.repeat(64);

function evidence() {
  const geometryTargets = MESHY_SEMANTIC_TARGETS.filter(
    ([id, , , required]) => required && !['doors_left', 'doors_right'].includes(id),
  ).map(([id]) => id);
  const derivative = buildFlatMeshyParts(
    geometryTargets.map((id) => ({
      id,
      positions: [
        [-17.9, 0, -18.785],
        [17.9, 0, -18.785],
        [0, 1, 18.785],
      ],
    })),
    'Test DCC export',
  );
  const scaffold = {
    format: 'tailfin-meshy-semantic-repair-scaffold',
    formatVersion: 1,
    operationId: 'candidate-1',
    sourceDerivativeSha256: digest('a'),
    scaffoldDerivativeSha256: digest('b'),
    repairNodes: [{ nodeId: 'repair__review_component_002', patchIds: ['patch-001'] }],
    missingTargets: [
      'cockpit_glass',
      'cabin_windows_left',
      'cabin_windows_right',
      'doors_left',
      'doors_right',
      'lights',
    ],
    state: 'quarantine',
    authoringComplete: false,
    repairComplete: false,
  };
  const scaffoldReportSha256 = sha256(canonicalJson(scaffold));
  const submission = {
    format: 'tailfin-meshy-semantic-repair-submission',
    formatVersion: 1,
    operationId: 'candidate-1',
    scaffoldReportSha256,
    authoredDerivativeSha256: sha256(derivative),
    authoredAt: '2026-08-31T00:00:00.000Z',
    authoredBy: 'Test artist',
    dcc: { name: 'Blender', version: '4.5' },
    repairResolutions: [
      {
        sourceRepairNodeId: 'repair__review_component_002',
        status: 'replaced_or_retopologized',
        rationale: 'Rebuilt the reviewed rough surface with clean connected topology.',
      },
    ],
    targetEvidence: MESHY_SEMANTIC_TARGETS.filter(([, , , required]) => required).map(
      ([targetId]) =>
        ['doors_left', 'doors_right'].includes(targetId)
          ? { targetId, authoring: 'canonical_mask' as const }
          : { targetId, authoring: 'geometry' as const, nodeName: targetId },
    ),
    notes: [],
  };
  return { derivative, scaffold, scaffoldReportSha256, submission };
}

describe('semantic repair derivative intake', () => {
  it('accepts complete hash-bound structure while retaining every independent review gate', () => {
    const input = evidence();
    const assessment = assessMeshySemanticRepairSubmission(
      input.derivative,
      input.scaffold,
      input.scaffoldReportSha256,
      input.submission,
    );
    expect(assessment).toMatchObject({
      allRepairNodesResolved: true,
      allRequiredTargetsEvidenced: true,
      canonicalDimensionsRetained: true,
      structuralIntakePassed: true,
      technicalReviewPassed: false,
      visualReviewPassed: false,
      licensingReviewPassed: false,
      repairComplete: false,
      liveryReady: false,
    });
  });

  it('refuses stale identities, unresolved repair nodes and invalid mask substitution', () => {
    const input = evidence();
    expect(() =>
      assessMeshySemanticRepairSubmission(
        input.derivative,
        input.scaffold,
        digest('c'),
        input.submission,
      ),
    ).toThrow('scaffold report identity changed');
    expect(() =>
      assessMeshySemanticRepairSubmission(
        input.derivative,
        input.scaffold,
        input.scaffoldReportSha256,
        { ...input.submission, repairResolutions: [] },
      ),
    ).toThrow('resolve every scaffold repair node');
    const invalid = structuredClone(input.submission);
    invalid.targetEvidence.find((entry) => entry.targetId === 'lights')!.authoring =
      'canonical_mask';
    delete invalid.targetEvidence.find((entry) => entry.targetId === 'lights')!.nodeName;
    expect(() =>
      assessMeshySemanticRepairSubmission(
        input.derivative,
        input.scaffold,
        input.scaffoldReportSha256,
        invalid,
      ),
    ).toThrow('Only door targets');
  });
});
