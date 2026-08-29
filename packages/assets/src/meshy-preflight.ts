import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './canonical';
import { createMeshyPreflight, meshyCredentialStatus, type MeshyCredentialStatus } from './meshy';

const DEFAULT_SPEC = fileURLToPath(
  new URL('../../../assets/aircraft/generation/a320neo-t2-v1.json', import.meta.url),
);

/** Read bounded regular files through one handle, without exposing OS error messages or paths. */
export async function readBoundedMeshyBytes(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, 'r');
  const bytes = Buffer.alloc(maxBytes + 1);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Input exceeds the file limit.');
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) throw new Error('Input exceeds the file limit.');
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    bytes.fill(0);
    await file.close();
  }
}

/** Read bounded UTF-8 inputs without a separate metadata check. */
export async function readBoundedMeshyInput(path: string, maxBytes: number): Promise<string> {
  return (await readBoundedMeshyBytes(path, maxBytes)).toString('utf8');
}

export const MESHY_PREFLIGHT_USAGE =
  'Usage: assets:meshy --dry-run [--max-credits 1..40] [--key-file PATH] [--spec PATH]\n' +
  'Offline only. A proposed ceiling is not spending approval. No API calls or output files.\n';

interface PreflightIo {
  readText: (path: string, maxBytes: number) => Promise<string>;
}

/** No fetch/HTTP dependency, writes, subprocesses, registry intake or live mode. */
export async function runMeshyPreflight(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  io: PreflightIo = { readText: readBoundedMeshyInput },
): Promise<string> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.length === 1 && args[0] === '--help') return MESHY_PREFLIGHT_USAGE;
  const options = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--dry-run' && !dryRun) {
      dryRun = true;
      continue;
    }
    if (
      !option ||
      !['--max-credits', '--key-file', '--spec'].includes(option) ||
      options.has(option)
    ) {
      throw new Error('Unsupported or duplicate option. Only offline --dry-run is available.');
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('An option value is missing.');
    options.set(option, value);
  }
  if (!dryRun)
    throw new Error('Explicit --dry-run is required; live Meshy execution is unavailable.');
  const rawCeiling = options.get('--max-credits');
  if (rawCeiling !== undefined && !/^(?:[1-9]|[1-3][0-9]|40)$/.test(rawCeiling)) {
    throw new Error('--max-credits must be a whole number from 1 to 40.');
  }

  let spec: unknown;
  try {
    spec = JSON.parse(await io.readText(options.get('--spec') ?? DEFAULT_SPEC, 16_384)) as unknown;
  } catch {
    throw new Error('Cannot read a valid bounded Meshy specification.');
  }
  // Validate before inspecting any credential; no user input is echoed.
  createMeshyPreflight(spec, 'missing');
  let credentialStatus: MeshyCredentialStatus;
  const keyFile = options.get('--key-file');
  if (keyFile !== undefined) {
    try {
      credentialStatus = meshyCredentialStatus(await io.readText(keyFile, 4_096));
    } catch {
      credentialStatus = 'unreadable';
    }
  } else {
    credentialStatus = meshyCredentialStatus(environment.MESHY_API_KEY);
  }
  return canonicalJson(
    createMeshyPreflight(
      spec,
      credentialStatus,
      rawCeiling === undefined ? undefined : Number(rawCeiling),
    ),
  );
}
