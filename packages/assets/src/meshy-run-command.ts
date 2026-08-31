import { fileURLToPath } from 'node:url';

import { canonicalJson } from './canonical';
import { MeshyGenerationSpec, meshyCreditExposure, meshySpecIdentity } from './meshy';
import { checkMeshyAccount } from './meshy-account';
import { meshyArchiveDirectory, syncMeshyCandidate } from './meshy-archive';
import { archiveMeshyCorrection } from './meshy-correction-archive';
import { meshyEvidenceDirectory, prepareMeshyEvidence } from './meshy-evidence';
import { archiveMeshyFrameAssessment } from './meshy-frame-archive';
import { reportMeshyGeometry } from './meshy-geometry-report';
import { readBoundedMeshyInput } from './meshy-preflight';
import { sealMeshyCandidateProvenance } from './meshy-provenance';
import { archiveMeshyReview } from './meshy-review-archive';
import { assertMeshyRunCap, meshyRunApprovalIdentity } from './meshy-run';
import { archiveMeshySemanticInventory } from './meshy-semantic-inventory-archive';
import { archiveMeshySemanticRepairSubmission } from './meshy-semantic-repair-intake-archive';
import { archiveMeshySemanticRepairPlan } from './meshy-semantic-repair-plan-archive';
import { archiveMeshySemanticRepairRequirements } from './meshy-semantic-repair-requirements-archive';
import { archiveMeshySemanticRepairScaffold } from './meshy-semantic-repair-scaffold-archive';
import { archiveMeshySemanticResidualReview } from './meshy-semantic-residual-review-archive';
import { archiveMeshySemanticResiduals } from './meshy-semantic-residuals-archive';
import { archiveMeshySemanticReview } from './meshy-semantic-review-archive';
import { MeshyRunStore, meshyRunDatabasePath } from './meshy-store';
import { submitMeshyCandidate } from './meshy-submit';

export const MESHY_RUN_USAGE =
  'Usage: assets:meshy-run init --approval-file PATH\n' +
  '       assets:meshy-run status\n' +
  '       assets:meshy-run audit --operation candidate-1..4\n' +
  '       assets:meshy-run review --operation candidate-1..4\n' +
  '       assets:meshy-run frame --operation candidate-1..4 --axis-review-file PATH\n' +
  '       assets:meshy-run correct --operation candidate-1..4\n' +
  '       assets:meshy-run inventory --operation candidate-1..4\n' +
  '       assets:meshy-run semantics --operation candidate-1..4 --review-file PATH\n' +
  '       assets:meshy-run repair-requirements --operation candidate-1..4 --assessment-sha256 SHA256\n' +
  '       assets:meshy-run residuals --operation candidate-1..4 --assessment-sha256 SHA256\n' +
  '       assets:meshy-run residual-review --operation candidate-1..4 --residual-sha256 SHA256 --review-file PATH\n' +
  '       assets:meshy-run repair-plan --operation candidate-1..4 --residual-review-sha256 SHA256\n' +
  '       assets:meshy-run repair-scaffold --operation candidate-1..4 --repair-plan-sha256 SHA256\n' +
  '       assets:meshy-run repair-intake --operation candidate-1..4 --scaffold-report-sha256 SHA256 --derivative-file PATH --submission-file PATH\n' +
  '       assets:meshy-run account --max-credits 1..40 [--key-file PATH]\n' +
  '       assets:meshy-run prepare --evidence-file PATH --max-credits 1..40\n' +
  '       assets:meshy-run provenance --operation candidate-1..4 --max-credits 1..40\n' +
  '       assets:meshy-run submit --operation candidate-1..4 --pricing-file PATH --max-credits 1..40 [--key-file PATH]\n' +
  '       assets:meshy-run sync --operation candidate-1..4 --max-credits 1..40 [--key-file PATH]\n' +
  'One immutable first-run approval per repository. Submit spends credits; never retry an uncertain submission. No retexture command.\n';

export function parseMeshyRunArguments(argv: readonly string[]) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.length === 1 && args[0] === '--help')
    return { command: 'help' as const, options: new Map<string, string>() };
  const command = args[0];
  if (
    ![
      'init',
      'status',
      'account',
      'prepare',
      'submit',
      'sync',
      'provenance',
      'audit',
      'review',
      'frame',
      'correct',
      'inventory',
      'semantics',
      'repair-requirements',
      'residuals',
      'residual-review',
      'repair-plan',
      'repair-scaffold',
      'repair-intake',
    ].includes(command ?? '')
  )
    throw new Error('Unknown Meshy run command.');
  const allowed =
    command === 'init'
      ? ['--approval-file']
      : command === 'prepare'
        ? ['--evidence-file', '--max-credits']
        : command === 'provenance'
          ? ['--operation', '--max-credits']
          : command === 'submit'
            ? ['--operation', '--pricing-file', '--max-credits', '--key-file']
            : command === 'sync'
              ? ['--operation', '--max-credits', '--key-file']
              : command === 'account'
                ? ['--max-credits', '--key-file']
                : command === 'frame'
                  ? ['--operation', '--axis-review-file']
                  : command === 'semantics'
                    ? ['--operation', '--review-file']
                    : command === 'residual-review'
                      ? ['--operation', '--residual-sha256', '--review-file']
                      : command === 'repair-plan'
                        ? ['--operation', '--residual-review-sha256']
                        : command === 'repair-scaffold'
                          ? ['--operation', '--repair-plan-sha256']
                          : command === 'repair-intake'
                            ? [
                                '--operation',
                                '--scaffold-report-sha256',
                                '--derivative-file',
                                '--submission-file',
                              ]
                            : ['repair-requirements', 'residuals'].includes(command ?? '')
                              ? ['--operation', '--assessment-sha256']
                              : ['audit', 'review', 'correct', 'inventory'].includes(command ?? '')
                                ? ['--operation']
                                : [];
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.includes(key) || options.has(key) || !value || value.startsWith('--')) {
      throw new Error('Invalid Meshy run options.');
    }
    options.set(key, value);
  }
  if (command === 'init' && !options.has('--approval-file'))
    throw new Error('Approval file is required.');
  if (
    ['account', 'sync', 'prepare', 'submit', 'provenance'].includes(command!) &&
    !/^(?:[1-9]|[1-3][0-9]|40)$/.test(options.get('--max-credits') ?? '')
  ) {
    throw new Error('The approved whole-number ceiling is required.');
  }
  if (
    [
      'sync',
      'submit',
      'provenance',
      'audit',
      'review',
      'frame',
      'correct',
      'inventory',
      'semantics',
      'repair-requirements',
      'residuals',
      'residual-review',
      'repair-plan',
      'repair-scaffold',
      'repair-intake',
    ].includes(command!) &&
    !/^candidate-[1-4]$/.test(options.get('--operation') ?? '')
  )
    throw new Error('One recorded candidate operation is required.');
  if (command === 'prepare' && !options.has('--evidence-file'))
    throw new Error('Evidence import required.');
  if (command === 'submit' && !options.has('--pricing-file'))
    throw new Error('Fresh pricing review required.');
  if (command === 'frame' && !options.has('--axis-review-file'))
    throw new Error('Axis review required.');
  if (command === 'semantics' && !options.has('--review-file'))
    throw new Error('Semantic review required.');
  if (
    command === 'residual-review' &&
    (!/^[a-f0-9]{64}$/.test(options.get('--residual-sha256') ?? '') ||
      !options.has('--review-file'))
  )
    throw new Error('Residual report SHA-256 and review file required.');
  if (
    ['repair-requirements', 'residuals'].includes(command!) &&
    !/^[a-f0-9]{64}$/.test(options.get('--assessment-sha256') ?? '')
  )
    throw new Error('Semantic assessment SHA-256 required.');
  if (
    command === 'repair-plan' &&
    !/^[a-f0-9]{64}$/.test(options.get('--residual-review-sha256') ?? '')
  )
    throw new Error('Residual review assessment SHA-256 required.');
  if (
    command === 'repair-scaffold' &&
    !/^[a-f0-9]{64}$/.test(options.get('--repair-plan-sha256') ?? '')
  )
    throw new Error('Semantic repair plan SHA-256 required.');
  if (
    command === 'repair-intake' &&
    (!/^[a-f0-9]{64}$/.test(options.get('--scaffold-report-sha256') ?? '') ||
      !options.has('--derivative-file') ||
      !options.has('--submission-file'))
  )
    throw new Error('Scaffold report, authored derivative and submission manifest required.');
  return { command, options };
}

export async function runMeshyRunCommand(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const { command, options } = parseMeshyRunArguments(argv);
  if (command === 'help') return MESHY_RUN_USAGE;
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const spec = MeshyGenerationSpec.parse(
    JSON.parse(
      await readBoundedMeshyInput(
        fileURLToPath(
          new URL('../../../assets/aircraft/generation/a320neo-t2-v1.json', import.meta.url),
        ),
        16_384,
      ),
    ) as unknown,
  );
  const database = meshyRunDatabasePath(repository);
  const store = new MeshyRunStore(database);
  if (command === 'init') {
    const approval = JSON.parse(
      await readBoundedMeshyInput(options.get('--approval-file')!, 8_192),
    ) as unknown;
    const state = store.initialize(approval, spec);
    return canonicalJson({
      runId: state.approval.runId,
      approvalSha256: meshyRunApprovalIdentity(state.approval),
      approvedMaxCredits: state.approval.maxCredits,
      reservedOrChargedCredits: 0,
      candidateSubmissionImplemented: true,
      spendingAuthorizedByThisCommand: false,
    });
  }
  const state = store.read();
  if (state.approval.specSha256 !== meshySpecIdentity(spec))
    throw new Error('Approved specification changed.');
  if (command === 'status')
    return canonicalJson({
      runId: state.approval.runId,
      approvalSha256: meshyRunApprovalIdentity(state.approval),
      approvedMaxCredits: state.approval.maxCredits,
      reservedOrChargedCredits: meshyCreditExposure(state.budget),
      uncertainOperations: state.requests
        .filter((r) => !state.tasks.some((t) => t.operationId === r.operationId))
        .map((r) => r.operationId),
      taskCount: state.tasks.length,
      candidateSubmissionImplemented: true,
      spendingAuthorizedByThisCommand: false,
    });
  if (command === 'audit')
    return canonicalJson(
      reportMeshyGeometry(store, meshyArchiveDirectory(database), options.get('--operation')!),
    );
  if (command === 'review') {
    const { operationId, reportSha256, report } = await archiveMeshyReview(
      store,
      meshyArchiveDirectory(database),
      options.get('--operation')!,
    );
    // Keep full geometry/source-face mappings in private evidence, not terminal logs.
    return canonicalJson({
      operationId,
      reportSha256,
      reportFile: `${operationId}-review-v1.json`,
      derivativeFile: `review-${report.derivativeSha256}.glb`,
      derivativeSha256: report.derivativeSha256,
      derivativeBytes: report.derivativeBytes,
      components: report.components.length,
      triangles: report.after.sourceTriangles,
      removedTriangles: report.removedTriangles.length,
      ambiguousCoincidentFacePairs: report.ambiguousCoincidentFaces.length,
      state: report.state,
      runtimeAdmission: report.runtimeAdmission,
      liveryReady: report.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'frame') {
    const { operationId, reportSha256, report } = await archiveMeshyFrameAssessment(
      store,
      meshyArchiveDirectory(database),
      options.get('--operation')!,
      options.get('--axis-review-file')!,
    );
    return canonicalJson({
      operationId,
      reportSha256,
      reportFile: `${operationId}-frame-v1.json`,
      eligibleForCanonicalTransform: report.eligibleForCanonicalTransform,
      proposedUniformScaleMetresPerSourceUnit: report.proposedUniformScaleMetresPerSourceUnit,
      proposedDimensions: report.proposedDimensions,
      deviations: report.deviations,
      blockingReasons: report.blockingReasons,
      state: report.state,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'correct') {
    const { operationId, reportSha256, report } = await archiveMeshyCorrection(
      store,
      meshyArchiveDirectory(database),
      options.get('--operation')!,
    );
    return canonicalJson({
      operationId,
      reportSha256,
      reportFile: `${operationId}-correction-v1.json`,
      derivativeFile: `correction-${report.derivativeSha256}.glb`,
      derivativeSha256: report.derivativeSha256,
      dimensionsMet: report.targetDimensionsMet,
      lengthMetres: report.after.boundsSourceUnits.extent[2],
      wingspanMetres: report.after.boundsSourceUnits.extent[0],
      maxVertexDisplacementMetres: report.transform.maxVertexDisplacementMetres,
      state: report.state,
      runtimeAdmission: report.runtimeAdmission,
      liveryReady: report.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'inventory') {
    const { operationId, reportSha256, report } = await archiveMeshySemanticInventory(
      meshyArchiveDirectory(database),
      options.get('--operation')!,
    );
    return canonicalJson({
      operationId,
      reportSha256,
      reportFile: `${operationId}-semantic-inventory-v1.json`,
      derivativeSha256: report.derivativeSha256,
      components: report.components.length,
      centrePlaneReviewComponents: report.components
        .filter((component) => component.requiresManualTriangleLevelReview)
        .map((component) => component.componentId),
      semanticAssignmentsMade: report.semanticAssignmentsMade,
      state: report.state,
      runtimeAdmission: report.runtimeAdmission,
      liveryReady: report.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'semantics') {
    const { operationId, assessmentSha256, assessment } = await archiveMeshySemanticReview(
      meshyArchiveDirectory(database),
      options.get('--operation')!,
      options.get('--review-file')!,
    );
    return canonicalJson({
      operationId,
      assessmentSha256,
      reviewSourceSha256: assessment.reviewSourceSha256,
      semanticAssignmentsMade: assessment.semanticAssignmentsMade,
      readyForSemanticRepair: assessment.readyForSemanticRepair,
      uncoveredTriangles: assessment.uncoveredByComponent.reduce(
        (sum, component) => sum + component.triangles,
        0,
      ),
      missingTargets: assessment.missingTargets,
      unreviewedTargets: assessment.unreviewedTargets,
      state: assessment.state,
      runtimeAdmission: assessment.runtimeAdmission,
      liveryReady: assessment.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'repair-requirements') {
    const { operationId, requirementsSha256, requirements } =
      await archiveMeshySemanticRepairRequirements(
        meshyArchiveDirectory(database),
        options.get('--operation')!,
        options.get('--assessment-sha256')!,
      );
    return canonicalJson({
      operationId,
      requirementsSha256,
      assessmentSha256: requirements.assessmentSha256,
      modeledTargets: requirements.modeledTargetRequirements.map((entry) => entry.targetId),
      residualTriangles: requirements.residualTriangleRequirements.reduce(
        (sum, component) => sum + component.triangles,
        0,
      ),
      repairAuthoringMayBegin: requirements.repairAuthoringMayBegin,
      repairComplete: requirements.repairComplete,
      state: requirements.state,
      runtimeAdmission: requirements.runtimeAdmission,
      liveryReady: requirements.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'residuals') {
    const { operationId, reportSha256, report } = await archiveMeshySemanticResiduals(
      meshyArchiveDirectory(database),
      options.get('--operation')!,
      options.get('--assessment-sha256')!,
    );
    return canonicalJson({
      operationId,
      reportSha256,
      assessmentSha256: report.assessmentSha256,
      residualTriangles: report.residualTriangles,
      residualPatches: report.residualPatches.length,
      largestPatchTriangleCounts: report.residualPatches
        .map((patch) => patch.triangles)
        .sort((a, b) => b - a)
        .slice(0, 12),
      patchesWithCoincidentTriangles: report.patchesWithCoincidentTriangles,
      patchesWithOppositeWindingTriangles: report.patchesWithOppositeWindingTriangles,
      state: report.state,
      runtimeAdmission: report.runtimeAdmission,
      liveryReady: report.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'residual-review') {
    const { operationId, assessmentFileSha256, assessment } =
      await archiveMeshySemanticResidualReview(
        meshyArchiveDirectory(database),
        options.get('--operation')!,
        options.get('--residual-sha256')!,
        options.get('--review-file')!,
      );
    return canonicalJson({
      operationId,
      assessmentSha256: assessmentFileSha256,
      residualReportSha256: assessment.residualReportSha256,
      allPatchesReviewed: assessment.allPatchesReviewed,
      repairComplete: assessment.repairComplete,
      patchCounts: assessment.patchCounts,
      triangleCounts: assessment.triangleCounts,
      state: assessment.state,
      runtimeAdmission: assessment.runtimeAdmission,
      liveryReady: assessment.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'repair-plan') {
    const { operationId, planSha256, plan } = await archiveMeshySemanticRepairPlan(
      meshyArchiveDirectory(database),
      options.get('--operation')!,
      options.get('--residual-review-sha256')!,
    );
    return canonicalJson({
      operationId,
      planSha256,
      sourceDerivativeSha256: plan.sourceDerivativeSha256,
      components: plan.componentPlans.length,
      patchCounts: plan.patchCounts,
      triangleCounts: plan.triangleCounts,
      repairDerivativeRequired: plan.repairDerivativeRequired,
      repairComplete: plan.repairComplete,
      state: plan.state,
      runtimeAdmission: plan.runtimeAdmission,
      liveryReady: plan.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'repair-scaffold') {
    const { operationId, reportSha256, report } = await archiveMeshySemanticRepairScaffold(
      meshyArchiveDirectory(database),
      options.get('--operation')!,
      options.get('--repair-plan-sha256')!,
    );
    return canonicalJson({
      operationId,
      reportSha256,
      scaffoldDerivativeSha256: report.scaffoldDerivativeSha256,
      sourceTriangles: report.sourceTriangles,
      scaffoldTriangles: report.scaffoldTriangles,
      repairNodes: report.repairNodes.length,
      missingTargets: report.missingTargets,
      authoringComplete: report.authoringComplete,
      repairComplete: report.repairComplete,
      state: report.state,
      runtimeAdmission: report.runtimeAdmission,
      liveryReady: report.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  if (command === 'repair-intake') {
    const { operationId, assessmentSha256, assessment } =
      await archiveMeshySemanticRepairSubmission(
        meshyArchiveDirectory(database),
        options.get('--operation')!,
        options.get('--scaffold-report-sha256')!,
        options.get('--derivative-file')!,
        options.get('--submission-file')!,
      );
    return canonicalJson({
      operationId,
      assessmentSha256,
      authoredDerivativeSha256: assessment.authoredDerivativeSha256,
      allRepairNodesResolved: assessment.allRepairNodesResolved,
      allRequiredTargetsEvidenced: assessment.allRequiredTargetsEvidenced,
      structuralIntakePassed: assessment.structuralIntakePassed,
      technicalReviewPassed: assessment.technicalReviewPassed,
      visualReviewPassed: assessment.visualReviewPassed,
      licensingReviewPassed: assessment.licensingReviewPassed,
      repairComplete: assessment.repairComplete,
      state: assessment.state,
      runtimeAdmission: assessment.runtimeAdmission,
      liveryReady: assessment.liveryReady,
      creditsSpentByThisCommand: 0,
    });
  }
  const maxCredits = Number(options.get('--max-credits'));
  assertMeshyRunCap(state, maxCredits);
  if (command === 'provenance')
    return canonicalJson(
      await sealMeshyCandidateProvenance(
        store,
        meshyEvidenceDirectory(database),
        meshyArchiveDirectory(database),
        spec,
        maxCredits,
        options.get('--operation')!,
      ),
    );
  if (command === 'prepare')
    return canonicalJson(
      await prepareMeshyEvidence(
        meshyEvidenceDirectory(database),
        JSON.parse(await readBoundedMeshyInput(options.get('--evidence-file')!, 32_768)) as unknown,
        state,
        spec,
      ),
    );
  const keyFile = options.get('--key-file');
  const credential =
    keyFile === undefined
      ? (environment.MESHY_API_KEY ?? '')
      : await readBoundedMeshyInput(keyFile, 4_096);
  if (command === 'submit')
    return canonicalJson(
      await submitMeshyCandidate(
        store,
        meshyEvidenceDirectory(database),
        meshyArchiveDirectory(database),
        spec,
        maxCredits,
        options.get('--operation')!,
        JSON.parse(await readBoundedMeshyInput(options.get('--pricing-file')!, 8_192)) as unknown,
        credential,
      ),
    );
  if (command === 'sync')
    return canonicalJson({
      ...(await syncMeshyCandidate(
        store,
        meshyArchiveDirectory(database),
        spec,
        maxCredits,
        options.get('--operation')!,
        credential,
      )),
      creditsSpentByThisCommand: 0,
      generationAvailable: false,
    });
  return canonicalJson(await checkMeshyAccount(state, spec, maxCredits, credential));
}
