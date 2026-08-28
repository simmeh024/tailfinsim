import { fileURLToPath } from 'node:url';

import { canonicalJson } from './canonical';
import { MeshyGenerationSpec, meshyCreditExposure, meshySpecIdentity } from './meshy';
import { checkMeshyAccount } from './meshy-account';
import { meshyArchiveDirectory, syncMeshyCandidate } from './meshy-archive';
import { meshyEvidenceDirectory, prepareMeshyEvidence } from './meshy-evidence';
import { reportMeshyGeometry } from './meshy-geometry-report';
import { readBoundedMeshyInput } from './meshy-preflight';
import { sealMeshyCandidateProvenance } from './meshy-provenance';
import { archiveMeshyReview } from './meshy-review-archive';
import { assertMeshyRunCap, meshyRunApprovalIdentity } from './meshy-run';
import { MeshyRunStore, meshyRunDatabasePath } from './meshy-store';
import { submitMeshyCandidate } from './meshy-submit';

export const MESHY_RUN_USAGE =
  'Usage: assets:meshy-run init --approval-file PATH\n' +
  '       assets:meshy-run status\n' +
  '       assets:meshy-run audit --operation candidate-1..4\n' +
  '       assets:meshy-run review --operation candidate-1..4\n' +
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
                : command === 'audit' || command === 'review'
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
    ['sync', 'submit', 'provenance', 'audit', 'review'].includes(command!) &&
    !/^candidate-[1-4]$/.test(options.get('--operation') ?? '')
  )
    throw new Error('One recorded candidate operation is required.');
  if (command === 'prepare' && !options.has('--evidence-file'))
    throw new Error('Evidence import required.');
  if (command === 'submit' && !options.has('--pricing-file'))
    throw new Error('Fresh pricing review required.');
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
