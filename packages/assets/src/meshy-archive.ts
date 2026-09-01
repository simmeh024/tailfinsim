import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { meshySpecIdentity, type MeshyGenerationSpec } from './meshy';
import {
  MESHY_GLB_DOWNLOAD_LIMIT,
  assertMeshyGlbEnvelope,
  downloadMeshyGlb,
  recoverMeshyCandidate,
  type MeshyRecoveryDeps,
} from './meshy-recovery';
import { MeshyRetextureArchive } from './meshy-retexture';
import {
  MeshyArtifactDigest,
  MeshySha256,
  MeshyTaskReceipt,
  assertMeshyRunCap,
  meshyRunApprovalIdentity,
  type MeshyRunState,
} from './meshy-run';
import { type MeshyRunStore } from './meshy-store';

const Candidate = z.enum(['candidate-1', 'candidate-2', 'candidate-3', 'candidate-4']);
const Archive = z
  .object({
    format: z.literal('tailfin-meshy-candidate-export'),
    formatVersion: z.literal(1),
    state: z.literal('quarantine'),
    approvalSha256: MeshySha256,
    specSha256: MeshySha256,
    requestSha256: MeshySha256,
    task: MeshyTaskReceipt,
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    untouchedExport: MeshyArtifactDigest,
    evidenceComplete: z.literal(false),
    runtimeAdmission: z.literal('not-reviewed'),
  })
  .strict()
  .refine(
    (archive) =>
      Candidate.safeParse(archive.task.operationId).success &&
      archive.task.status === 'SUCCEEDED' &&
      archive.task.consumedCredits !== null &&
      Date.parse(archive.createdAt) <= Date.parse(archive.finishedAt) &&
      archive.untouchedExport.mediaType === 'model/gltf-binary' &&
      archive.untouchedExport.bytes <= MESHY_GLB_DOWNLOAD_LIMIT,
  );
type Archive = z.infer<typeof Archive>;
const REFUSED = 'Meshy quarantine archive refused; preserve files for operator inspection.';

/** Adjacent to the shared ledger, not a caller-selected directory in the CLI. */
export function meshyArchiveDirectory(databasePath: string): string {
  return join(dirname(databasePath), 'a320neo-first-run-exports');
}

function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path))
    throw new Error(REFUSED);
}

/** Bound allocation even if a file grows, and refuse redirected/hard-linked archive objects. */
export function readMeshyArtifact(path: string, limit: number): Buffer {
  // Open first, then inspect/read that same handle: a path precheck cannot authorize
  // a later open. POSIX additionally refuses symlinks and avoids blocking on FIFOs.
  // Windows does not expose those flags; its handle/path checks still precede all reads.
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(path, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit) throw new Error(REFUSED);
    const info = lstatSync(path);
    if (
      info.isSymbolicLink() ||
      info.ino !== opened.ino ||
      info.dev !== opened.dev ||
      info.nlink !== 1 ||
      info.size !== opened.size ||
      realpathSync(dirname(path)) !== resolve(dirname(path))
    )
      throw new Error(REFUSED);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error(REFUSED);
      offset += count;
    }
    if (fstatSync(fd).size !== opened.size) throw new Error(REFUSED);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** No partial final names and no overwrites, even when two recovery processes race. */
export function writeImmutableMeshyArtifact(path: string, bytes: Buffer): void {
  const parent = dirname(path);
  directory(parent);
  const verify = () => {
    const existing = readMeshyArtifact(path, bytes.length);
    if (existing.length !== bytes.length || sha256(existing) !== sha256(bytes))
      throw new Error(REFUSED);
  };
  if (existsSync(path)) return verify();
  const temporary = join(parent, `.pending-${randomUUID()}`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
  } finally {
    // Only this invocation's exact temporary path. A crash may leave an orphan for inspection.
    unlinkSync(temporary);
  }
  verify();
  // Windows does not expose directory fsync through Node; file data was flushed above.
  if (process.platform !== 'win32') {
    const parentFd = openSync(parent, 'r');
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  }
}

type RetextureArchive = z.infer<typeof MeshyRetextureArchive>;
interface RetextureBytes {
  glb: Buffer;
  baseColor: Buffer;
  normal: Buffer;
  metallic: Buffer;
  roughness: Buffer;
}

/**
 * Publishes every immutable source artifact before the completion manifest. The
 * caller supplies already-downloaded bytes; no provider URL or credential can
 * reach the durable archive.
 */
export function writeMeshyRetextureArchive(
  root: string,
  archiveInput: unknown,
  bytes: RetextureBytes,
): RetextureArchive {
  const archive = MeshyRetextureArchive.parse(archiveInput);
  const expected: [keyof RetextureBytes, z.infer<typeof MeshyArtifactDigest>, string][] = [
    ['glb', archive.retexturedGlb, '.glb'],
    ['baseColor', archive.pbrTextures.baseColor, '.texture'],
    ['normal', archive.pbrTextures.normal, '.texture'],
    ['metallic', archive.pbrTextures.metallic, '.texture'],
    ['roughness', archive.pbrTextures.roughness, '.texture'],
  ];
  for (const [name, digest, suffix] of expected) {
    const artifact = bytes[name];
    if (artifact.length !== digest.bytes || sha256(artifact) !== digest.sha256)
      throw new Error(REFUSED);
    writeImmutableMeshyArtifact(join(root, `retexture-${digest.sha256}${suffix}`), artifact);
  }
  // Completion is last: orphaned immutable files are safe, a manifest never points at unverified bytes.
  writeImmutableMeshyArtifact(
    join(root, 'retexture-selected.json'),
    Buffer.from(canonicalJson(archive)),
  );
  return archive;
}

function assertBinding(archive: Archive, state: MeshyRunState, operationId: string): void {
  const task = state.tasks.find((entry) => entry.operationId === operationId);
  const request = state.requests.find((entry) => entry.operationId === operationId);
  if (
    archive.approvalSha256 !== meshyRunApprovalIdentity(state.approval) ||
    archive.specSha256 !== state.approval.specSha256 ||
    archive.requestSha256 !== request?.requestSha256 ||
    canonicalJson(archive.task) !== canonicalJson(task)
  )
    throw new Error(REFUSED);
}

export function savedMeshyArchive(
  root: string,
  operationId: string,
  state: MeshyRunState,
): Archive | null {
  const path = join(root, `${Candidate.parse(operationId)}.json`);
  if (!existsSync(path)) return null;
  const archive = Archive.parse(
    JSON.parse(readMeshyArtifact(path, 8_192).toString('utf8')) as unknown,
  );
  assertBinding(archive, state, operationId);
  const bytes = readMeshyArtifact(
    join(root, `${archive.untouchedExport.sha256}.glb`),
    MESHY_GLB_DOWNLOAD_LIMIT,
  );
  if (
    bytes.length !== archive.untouchedExport.bytes ||
    sha256(bytes) !== archive.untouchedExport.sha256
  )
    throw new Error(REFUSED);
  assertMeshyGlbEnvelope(bytes);
  return archive;
}

/** One resumable GET pass. Completed local exports are verified without provider access. */
export async function syncMeshyCandidate(
  store: MeshyRunStore,
  root: string,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  operationId: string,
  credential: string,
  deps?: MeshyRecoveryDeps,
) {
  try {
    const state = store.read();
    assertMeshyRunCap(state, maxCredits);
    Candidate.parse(operationId);
    if (state.approval.specSha256 !== meshySpecIdentity(spec)) throw new Error(REFUSED);
    const existing = savedMeshyArchive(root, operationId, state);
    if (existing)
      return { operationId, status: 'SUCCEEDED', archived: true, export: existing.untouchedExport };
    const result = await recoverMeshyCandidate(
      store,
      spec,
      maxCredits,
      operationId,
      credential,
      deps,
    );
    if (result.receipt.status !== 'SUCCEEDED')
      return {
        operationId,
        status: result.receipt.status,
        archived: false,
        observedCredits: result.observedCredits,
      };
    if (!result.glbUrl || !result.finishedAt || result.receipt.consumedCredits === null)
      throw new Error(REFUSED);
    const bytes = await downloadMeshyGlb(result.glbUrl, deps);
    const current = store.read();
    const archive = Archive.parse({
      format: 'tailfin-meshy-candidate-export',
      formatVersion: 1,
      state: 'quarantine',
      approvalSha256: meshyRunApprovalIdentity(current.approval),
      specSha256: current.approval.specSha256,
      requestSha256: current.requests.find((request) => request.operationId === operationId)
        ?.requestSha256,
      task: result.receipt,
      createdAt: result.createdAt,
      finishedAt: result.finishedAt,
      expiresAt: result.expiresAt,
      untouchedExport: {
        sha256: sha256(bytes),
        bytes: bytes.length,
        mediaType: 'model/gltf-binary',
      },
      evidenceComplete: false,
      runtimeAdmission: 'not-reviewed',
    });
    assertBinding(archive, current, operationId);
    writeImmutableMeshyArtifact(join(root, `${archive.untouchedExport.sha256}.glb`), bytes);
    // Write the completion record last; a blob alone never means a completed archive.
    writeImmutableMeshyArtifact(
      join(root, `${operationId}.json`),
      Buffer.from(canonicalJson(archive)),
    );
    return { operationId, status: 'SUCCEEDED', archived: true, export: archive.untouchedExport };
  } catch {
    throw new Error(REFUSED);
  }
}
