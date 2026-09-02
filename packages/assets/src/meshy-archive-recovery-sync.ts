import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { readMeshyArtifact, writeImmutableMeshyArtifact } from './meshy-archive';
import { type MeshyArchiveRecoveryStore } from './meshy-archive-recovery-store';
import { MeshyArchiveRecoverySubmissionProof } from './meshy-archive-recovery-submit';
import { loadMeshyEvidenceJson } from './meshy-evidence';
import {
  MESHY_TEXTURE_DOWNLOAD_LIMIT,
  assertMeshyGlbEnvelope,
  downloadMeshyGlb,
  downloadMeshyTexture,
  fetchMeshyRetextureTask,
  type MeshyRecoveryDeps,
} from './meshy-recovery';
import { assertMeshyRetextureArchiveReady } from './meshy-retexture';
import { MeshyArtifactDigest } from './meshy-run';

const TOTAL_DOWNLOAD_LIMIT = 192 * 1024 * 1024;
const Archive = z
  .object({
    format: z.literal('tailfin-meshy-archive-recovery-retexture-export'),
    formatVersion: z.literal(1),
    state: z.literal('quarantine'),
    proofSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    task: z
      .object({
        taskId: z.uuid(),
        consumedCredits: z.number().int().nonnegative(),
        observedAt: z.iso.datetime(),
      })
      .strict(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    retexturedGlb: MeshyArtifactDigest,
    pbrTextures: z
      .object({
        baseColor: MeshyArtifactDigest,
        normal: MeshyArtifactDigest,
        metallic: MeshyArtifactDigest,
        roughness: MeshyArtifactDigest,
      })
      .strict(),
    runtimeAdmission: z.literal('not-reviewed'),
  })
  .strict();
type Archive = z.infer<typeof Archive>;

function textureDigest(bytes: Buffer) {
  const mediaType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : 'image/jpeg';
  return MeshyArtifactDigest.parse({ sha256: sha256(bytes), bytes: bytes.length, mediaType });
}
function path(root: string) {
  return join(root, 'archive-recovery-retexture.json');
}
function artifactPath(root: string, digest: string, suffix: string) {
  return join(root, `archive-recovery-${digest}${suffix}`);
}

function readExisting(root: string, proofSha256: string): Archive | null {
  if (!existsSync(path(root))) return null;
  const archive = Archive.parse(
    JSON.parse(readMeshyArtifact(path(root), 16_384).toString('utf8')) as unknown,
  );
  if (archive.proofSha256 !== proofSha256) throw new Error('Recovery archive proof changed.');
  const artifacts: [z.infer<typeof MeshyArtifactDigest>, string][] = [
    [archive.retexturedGlb, '.glb'],
    ...Object.values(archive.pbrTextures).map(
      (digest) => [digest, '.texture'] as [z.infer<typeof MeshyArtifactDigest>, string],
    ),
  ];
  for (const [digest, suffix] of artifacts) {
    const bytes = readMeshyArtifact(
      artifactPath(root, digest.sha256, suffix),
      MESHY_TEXTURE_DOWNLOAD_LIMIT,
    );
    try {
      if (bytes.length !== digest.bytes || sha256(bytes) !== digest.sha256)
        throw new Error('Recovery archive changed.');
      if (suffix === '.glb') assertMeshyGlbEnvelope(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  return archive;
}

/** Read-only polling plus immutable quarantine archival for the one recovery ledger task. */
export async function syncArchiveMeshyRetexture(
  store: MeshyArchiveRecoveryStore,
  evidenceRoot: string,
  archiveRoot: string,
  credential: string,
  deps?: MeshyRecoveryDeps,
) {
  const state = store.read();
  if (!state.reservation || !state.task)
    throw new Error('Archive recovery task is not reconciled.');
  const proof = MeshyArchiveRecoverySubmissionProof.parse(
    loadMeshyEvidenceJson(evidenceRoot, state.reservation.proofSha256),
  );
  if (
    proof.requestBodySha256 !== state.reservation.requestBodySha256 ||
    proof.source.sha256 !== state.reservation.sourceSha256
  )
    throw new Error('Archive recovery proof differs.');
  const existing = readExisting(archiveRoot, state.reservation.proofSha256);
  if (existing)
    return {
      status: 'SUCCEEDED' as const,
      archived: true,
      export: existing.retexturedGlb,
      pbrTextures: existing.pbrTextures,
    };
  const provider = await fetchMeshyRetextureTask(state.task.taskId, credential, deps);
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(provider.status);
  store.observe({
    taskId: provider.id,
    status: provider.status,
    consumedCredits: terminal ? (provider.consumed_credits ?? null) : null,
    observedAt: (deps?.now ?? (() => new Date()))().toISOString(),
  });
  if (provider.status !== 'SUCCEEDED') return { status: provider.status, archived: false };
  const task = assertMeshyRetextureArchiveReady(provider);
  const bytes: Buffer[] = [];
  try {
    const glb = await downloadMeshyGlb(task.model_urls!.glb!, deps);
    bytes.push(glb);
    const textures: Buffer[] = [];
    for (const url of [
      task.texture_urls!.base_color!,
      task.texture_urls!.normal!,
      task.texture_urls!.metallic!,
      task.texture_urls!.roughness!,
    ]) {
      const texture = await downloadMeshyTexture(url, deps);
      bytes.push(texture);
      textures.push(texture);
      if (bytes.reduce((total, value) => total + value.length, 0) > TOTAL_DOWNLOAD_LIMIT)
        throw new Error('Recovery output budget exceeded.');
    }
    const current = store.read();
    if (
      !current.reservation ||
      current.task?.status !== 'SUCCEEDED' ||
      current.task?.consumedCredits === null
    )
      throw new Error('Recovery task changed.');
    const archive = Archive.parse({
      format: 'tailfin-meshy-archive-recovery-retexture-export',
      formatVersion: 1,
      state: 'quarantine',
      proofSha256: current.reservation.proofSha256,
      sourceSha256: current.reservation.sourceSha256,
      task: {
        taskId: current.task.taskId,
        consumedCredits: current.task.consumedCredits,
        observedAt: current.task.observedAt,
      },
      createdAt: new Date(task.created_at).toISOString(),
      finishedAt: new Date(task.finished_at!).toISOString(),
      expiresAt: task.expires_at ? new Date(task.expires_at).toISOString() : null,
      retexturedGlb: MeshyArtifactDigest.parse({
        sha256: sha256(glb),
        bytes: glb.length,
        mediaType: 'model/gltf-binary',
      }),
      pbrTextures: {
        baseColor: textureDigest(textures[0]!),
        normal: textureDigest(textures[1]!),
        metallic: textureDigest(textures[2]!),
        roughness: textureDigest(textures[3]!),
      },
      runtimeAdmission: 'not-reviewed',
    });
    const files: [Buffer, z.infer<typeof MeshyArtifactDigest>, string][] = [
      [glb, archive.retexturedGlb, '.glb'],
      [textures[0]!, archive.pbrTextures.baseColor, '.texture'],
      [textures[1]!, archive.pbrTextures.normal, '.texture'],
      [textures[2]!, archive.pbrTextures.metallic, '.texture'],
      [textures[3]!, archive.pbrTextures.roughness, '.texture'],
    ];
    for (const [value, digest, suffix] of files)
      writeImmutableMeshyArtifact(artifactPath(archiveRoot, digest.sha256, suffix), value);
    writeImmutableMeshyArtifact(path(archiveRoot), Buffer.from(canonicalJson(archive)));
    return {
      status: 'SUCCEEDED' as const,
      archived: true,
      export: archive.retexturedGlb,
      pbrTextures: archive.pbrTextures,
    };
  } finally {
    for (const value of bytes) value.fill(0);
  }
}
