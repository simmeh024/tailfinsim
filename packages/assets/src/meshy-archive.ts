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
  MESHY_TEXTURE_DOWNLOAD_LIMIT,
  assertMeshyGlbEnvelope,
  downloadMeshyGlb,
  downloadMeshyTexture,
  recoverMeshyCandidate,
  recoverMeshyRetexture,
  type MeshyRecoveryDeps,
} from './meshy-recovery';
import {
  MeshyRetextureArchive,
  assertMeshyRetextureArchiveReady,
  type MeshyRetextureArchive as MeshyRetextureArchiveValue,
} from './meshy-retexture';
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

function assertRetextureBinding(archive: RetextureArchive, state: MeshyRunState): void {
  const task = state.tasks.find((entry) => entry.operationId === 'retexture-selected');
  const request = state.requests.find((entry) => entry.operationId === 'retexture-selected');
  if (
    !state.selection ||
    archive.approvalSha256 !== meshyRunApprovalIdentity(state.approval) ||
    archive.specSha256 !== state.approval.specSha256 ||
    archive.requestSha256 !== request?.requestSha256 ||
    archive.inputTaskId !== state.selection.taskId ||
    canonicalJson(archive.task) !== canonicalJson(task)
  )
    throw new Error(REFUSED);
}

function verifiedRetextureArtifact(
  root: string,
  digest: z.infer<typeof MeshyArtifactDigest>,
  suffix: string,
  limit: number,
): void {
  const bytes = readMeshyArtifact(join(root, `retexture-${digest.sha256}${suffix}`), limit);
  if (bytes.length !== digest.bytes || sha256(bytes) !== digest.sha256) throw new Error(REFUSED);
  if (digest.mediaType === 'model/gltf-binary') assertMeshyGlbEnvelope(bytes);
}

/** A completed manifest is trusted only after every content-addressed source byte revalidates. */
export function savedMeshyRetextureArchive(
  root: string,
  state: MeshyRunState,
): MeshyRetextureArchiveValue | null {
  const path = join(root, 'retexture-selected.json');
  if (!existsSync(path)) return null;
  const archive = MeshyRetextureArchive.parse(
    JSON.parse(readMeshyArtifact(path, 16_384).toString('utf8')) as unknown,
  );
  assertRetextureBinding(archive, state);
  verifiedRetextureArtifact(root, archive.retexturedGlb, '.glb', MESHY_GLB_DOWNLOAD_LIMIT);
  for (const texture of Object.values(archive.pbrTextures))
    verifiedRetextureArtifact(root, texture, '.texture', MESHY_TEXTURE_DOWNLOAD_LIMIT);
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

const MESHY_RETEXTURE_DOWNLOAD_TOTAL_LIMIT = 192 * 1024 * 1024;

function textureDigest(bytes: Buffer) {
  const mediaType =
    bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : 'image/jpeg';
  return { sha256: sha256(bytes), bytes: bytes.length, mediaType } as const;
}

/**
 * Read-only task recovery plus immutable PBR source archival. The selected source
 * candidate must already be archived; this path never generates or accepts a URL
 * from a caller.
 */
export async function syncMeshyRetexture(
  store: MeshyRunStore,
  root: string,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  credential: string,
  deps?: MeshyRecoveryDeps,
) {
  const downloaded: Buffer[] = [];
  try {
    const state = store.read();
    assertMeshyRunCap(state, maxCredits);
    if (state.approval.specSha256 !== meshySpecIdentity(spec)) throw new Error(REFUSED);
    const existing = savedMeshyRetextureArchive(root, state);
    if (existing)
      return {
        operationId: 'retexture-selected' as const,
        status: 'SUCCEEDED' as const,
        archived: true,
        export: existing.retexturedGlb,
        pbrTextures: existing.pbrTextures,
      };
    if (!state.selection) throw new Error(REFUSED);
    const selected = state.tasks.find((task) => task.taskId === state.selection?.taskId);
    if (!selected || selected.operationId === 'retexture-selected') throw new Error(REFUSED);
    if (!savedMeshyArchive(root, selected.operationId, state)) throw new Error(REFUSED);
    const result = await recoverMeshyRetexture(store, spec, maxCredits, credential, deps);
    if (result.receipt.status !== 'SUCCEEDED')
      return {
        operationId: 'retexture-selected' as const,
        status: result.receipt.status,
        archived: false,
      };
    const task = assertMeshyRetextureArchiveReady(result.task);
    const glb = await downloadMeshyGlb(task.model_urls!.glb!, deps);
    downloaded.push(glb);
    const textureUrls = [
      task.texture_urls!.base_color!,
      task.texture_urls!.normal!,
      task.texture_urls!.metallic!,
      task.texture_urls!.roughness!,
    ];
    const textures: Buffer[] = [];
    for (const url of textureUrls) {
      const texture = await downloadMeshyTexture(url, deps);
      downloaded.push(texture);
      textures.push(texture);
      if (
        downloaded.reduce((total, bytes) => total + bytes.length, 0) >
        MESHY_RETEXTURE_DOWNLOAD_TOTAL_LIMIT
      )
        throw new Error(REFUSED);
    }
    const current = store.read();
    const receipt = current.tasks.find((entry) => entry.operationId === 'retexture-selected');
    const requestSha256 = current.requests.find(
      (request) => request.operationId === 'retexture-selected',
    )?.requestSha256;
    const archive = writeMeshyRetextureArchive(
      root,
      {
        format: 'tailfin-meshy-retexture-export',
        formatVersion: 1,
        state: 'quarantine',
        approvalSha256: meshyRunApprovalIdentity(current.approval),
        specSha256: current.approval.specSha256,
        requestSha256,
        inputTaskId: current.selection?.taskId,
        task: receipt,
        createdAt: new Date(task.created_at).toISOString(),
        finishedAt: new Date(task.finished_at!).toISOString(),
        expiresAt: task.expires_at ? new Date(task.expires_at).toISOString() : null,
        retexturedGlb: {
          sha256: sha256(glb),
          bytes: glb.length,
          mediaType: 'model/gltf-binary',
        },
        pbrTextures: {
          baseColor: textureDigest(textures[0]!),
          normal: textureDigest(textures[1]!),
          metallic: textureDigest(textures[2]!),
          roughness: textureDigest(textures[3]!),
        },
        evidenceComplete: false,
        runtimeAdmission: 'not-reviewed',
      },
      {
        glb,
        baseColor: textures[0]!,
        normal: textures[1]!,
        metallic: textures[2]!,
        roughness: textures[3]!,
      },
    );
    assertRetextureBinding(archive, current);
    return {
      operationId: 'retexture-selected' as const,
      status: 'SUCCEEDED' as const,
      archived: true,
      export: archive.retexturedGlb,
      pbrTextures: archive.pbrTextures,
    };
  } catch {
    throw new Error(REFUSED);
  } finally {
    for (const bytes of downloaded) bytes.fill(0);
  }
}
