import { fileURLToPath } from 'node:url';

import { canonicalJson } from './canonical';
import { MeshyGenerationSpec, meshyCreditExposure, meshySpecIdentity } from './meshy';
import { checkMeshyAccount } from './meshy-account';
import { readBoundedMeshyInput } from './meshy-preflight';
import { assertMeshyRunCap, meshyRunApprovalIdentity } from './meshy-run';
import { MeshyRunStore, meshyRunDatabasePath } from './meshy-store';

export const MESHY_RUN_USAGE =
  'Usage: assets:meshy-run init --approval-file PATH\n' +
  '       assets:meshy-run status\n' +
  '       assets:meshy-run account --max-credits 1..40 [--key-file PATH]\n' +
  'One immutable first-run approval per repository. Account is GET-only. No generation command exists.\n';

export function parseMeshyRunArguments(argv: readonly string[]) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.length === 1 && args[0] === '--help')
    return { command: 'help' as const, options: new Map<string, string>() };
  const command = args[0];
  if (!['init', 'status', 'account'].includes(command ?? ''))
    throw new Error('Unknown Meshy run command.');
  const allowed =
    command === 'init'
      ? ['--approval-file']
      : command === 'account'
        ? ['--max-credits', '--key-file']
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
    command === 'account' &&
    !/^(?:[1-9]|[1-3][0-9]|40)$/.test(options.get('--max-credits') ?? '')
  ) {
    throw new Error('The approved whole-number ceiling is required.');
  }
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
  const store = new MeshyRunStore(meshyRunDatabasePath(repository));
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
      generationAvailable: false,
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
      generationAvailable: false,
    });
  const maxCredits = Number(options.get('--max-credits'));
  assertMeshyRunCap(state, maxCredits);
  const keyFile = options.get('--key-file');
  const credential =
    keyFile === undefined
      ? (environment.MESHY_API_KEY ?? '')
      : await readBoundedMeshyInput(keyFile, 4_096);
  return canonicalJson(await checkMeshyAccount(state, spec, maxCredits, credential));
}
