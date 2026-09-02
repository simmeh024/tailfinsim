import { z } from 'zod';

import { meshyCredentialStatus, meshySpecIdentity, type MeshyGenerationSpec } from './meshy';
import { MeshyRetextureTaskOutput } from './meshy-retexture';
import { assertMeshyRunCap, type MeshyTaskReceipt } from './meshy-run';
import { type MeshyRunStore } from './meshy-store';

const TaskResponse = z.object({
  id: z.uuid(),
  type: z.literal('image-to-3d'),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']),
  consumed_credits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  created_at: z.number().int().nonnegative().max(8_640_000_000_000_000),
  finished_at: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
  expires_at: z.number().int().nonnegative().max(8_640_000_000_000_000).optional(),
  model_urls: z.object({ glb: z.string().max(8_192).optional() }).optional(),
});
const MeshyTaskId = z.uuid();
const terminal = (status: MeshyTaskReceipt['status']) =>
  ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status);

export class MeshyRecoveryError extends Error {
  constructor(
    readonly code:
      | 'not-authorized'
      | 'unknown-candidate'
      | 'unavailable'
      | 'http-refused'
      | 'invalid-response'
      | 'download-refused',
  ) {
    super(`Meshy recovery ${code}; no generation submitted.`);
  }
}

export interface MeshyRecoveryDeps {
  fetch: typeof globalThis.fetch;
  pause: (milliseconds: number) => Promise<void>;
  now: () => Date;
}
export const meshyRecoveryDefaults: MeshyRecoveryDeps = {
  fetch: globalThis.fetch,
  pause: (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)),
  now: () => new Date(),
};

/** The limit applies to decoded bytes, not a compressed Content-Length header. */
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Invalid bounded body.');
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid byte stream.');
      length += value.byteLength;
      if (length > limit) throw new Error('Body exceeds limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Only GET is possible. A fresh abort deadline covers headers AND the decoded body. */
async function boundedGet(
  url: string,
  headers: Record<string, string>,
  mediaTypes: readonly string[],
  limit: number,
  deadline: number,
  deps: MeshyRecoveryDeps,
): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(deadline),
        headers,
      });
    } catch {
      if (attempt === 2) throw new MeshyRecoveryError('unavailable');
      await deps.pause(250 * (attempt + 1));
      continue;
    }
    try {
      if (!response.ok) {
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await deps.pause(250 * (attempt + 1));
          continue;
        }
        throw new MeshyRecoveryError('http-refused');
      }
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (!mediaType || !mediaTypes.includes(mediaType)) {
        await response.body?.cancel();
        throw new MeshyRecoveryError('invalid-response');
      }
      return await boundedBody(response, limit);
    } catch (error) {
      if (error instanceof MeshyRecoveryError) throw error;
      // Never propagate fetch/stream/provider messages or signed download URLs.
      throw new MeshyRecoveryError('invalid-response');
    }
  }
  throw new MeshyRecoveryError('unavailable');
}

/**
 * Reads one exact retexture task. It never lists tasks, adopts a provider ID, or
 * persists transient provider URLs; callers must bind the ID to their own ledger.
 */
export async function fetchMeshyRetextureTask(
  taskIdInput: string,
  credential: string,
  deps: MeshyRecoveryDeps = meshyRecoveryDefaults,
) {
  let taskId: string;
  try {
    taskId = MeshyTaskId.parse(taskIdInput);
    if (meshyCredentialStatus(credential) !== 'present') throw new Error('Credential required.');
  } catch {
    throw new MeshyRecoveryError('not-authorized');
  }
  const bytes = await boundedGet(
    `https://api.meshy.ai/openapi/v1/retexture/${taskId}`,
    { Authorization: `Bearer ${credential.trim()}`, Accept: 'application/json' },
    ['application/json'],
    65_536,
    10_000,
    deps,
  );
  try {
    const task = MeshyRetextureTaskOutput.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (task.id !== taskId) throw new Error('Task identity changed.');
    return task;
  } catch {
    throw new MeshyRecoveryError('invalid-response');
  } finally {
    bytes.fill(0);
  }
}

/**
 * One bounded polling pass, only for an already recorded candidate. Does not adopt
 * arbitrary task IDs or resolve uncertain POSTs. Charge observations survive download failure.
 * Output URLs are ephemeral transport values; callers must never persist/log this object.
 */
export async function recoverMeshyCandidate(
  store: MeshyRunStore,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  operationId: string,
  credential: string,
  deps: MeshyRecoveryDeps = meshyRecoveryDefaults,
) {
  const state = store.read();
  try {
    assertMeshyRunCap(state, maxCredits);
    if (
      state.approval.specSha256 !== meshySpecIdentity(spec) ||
      meshyCredentialStatus(credential) !== 'present'
    )
      throw new Error('Invalid authority.');
  } catch {
    throw new MeshyRecoveryError('not-authorized');
  }
  const before = state.tasks.find((task) => task.operationId === operationId);
  if (!before || before.operationId === 'retexture-selected')
    throw new MeshyRecoveryError('unknown-candidate');
  const bytes = await boundedGet(
    `https://api.meshy.ai/openapi/v1/image-to-3d/${before.taskId}`,
    { Authorization: `Bearer ${credential.trim()}`, Accept: 'application/json' },
    ['application/json'],
    65_536,
    10_000,
    deps,
  );
  try {
    const task = TaskResponse.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (task.id !== before.taskId) throw new Error('Task identity changed.');
    const consumedCredits = terminal(task.status) ? (task.consumed_credits ?? null) : null;
    // Repeated progress/URL refreshes must not exhaust the bounded ledger's history.
    const receipt: MeshyTaskReceipt = {
      operationId: before.operationId,
      taskId: before.taskId,
      status: task.status,
      consumedCredits,
      observedAt:
        before.status === task.status && before.consumedCredits === consumedCredits
          ? before.observedAt
          : deps.now().toISOString(),
    };
    const persisted = store.observeProgress(receipt);
    return {
      receipt: persisted.tasks.find((entry) => entry.operationId === operationId)!,
      createdAt: new Date(task.created_at).toISOString(),
      finishedAt: task.finished_at ? new Date(task.finished_at).toISOString() : null,
      expiresAt: task.expires_at ? new Date(task.expires_at).toISOString() : null,
      glbUrl: task.status === 'SUCCEEDED' ? (task.model_urls?.glb ?? null) : null,
      // A mid-flight price increase is reported, never treated as a refund/reservation release.
      observedCredits: task.consumed_credits ?? null,
    };
  } catch {
    throw new MeshyRecoveryError('invalid-response');
  } finally {
    bytes.fill(0);
  }
}

/** One bounded read-only poll for the already-recorded selected retexture task. */
export async function recoverMeshyRetexture(
  store: MeshyRunStore,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  credential: string,
  deps: MeshyRecoveryDeps = meshyRecoveryDefaults,
) {
  const state = store.read();
  try {
    assertMeshyRunCap(state, maxCredits);
    if (
      state.approval.specSha256 !== meshySpecIdentity(spec) ||
      meshyCredentialStatus(credential) !== 'present'
    )
      throw new Error('Invalid authority.');
  } catch {
    throw new MeshyRecoveryError('not-authorized');
  }
  const before = state.tasks.find((task) => task.operationId === 'retexture-selected');
  if (!before || !state.selection) throw new MeshyRecoveryError('unknown-candidate');
  const bytes = await boundedGet(
    `https://api.meshy.ai/openapi/v1/retexture/${before.taskId}`,
    { Authorization: `Bearer ${credential.trim()}`, Accept: 'application/json' },
    ['application/json'],
    65_536,
    10_000,
    deps,
  );
  try {
    const task = MeshyRetextureTaskOutput.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (task.id !== before.taskId) throw new Error('Task identity changed.');
    const consumedCredits = terminal(task.status) ? (task.consumed_credits ?? null) : null;
    const receipt: MeshyTaskReceipt = {
      operationId: 'retexture-selected',
      taskId: before.taskId,
      status: task.status,
      consumedCredits,
      observedAt:
        before.status === task.status && before.consumedCredits === consumedCredits
          ? before.observedAt
          : deps.now().toISOString(),
    };
    store.observeProgress(receipt);
    return { receipt, task: task.status === 'SUCCEEDED' ? task : null };
  } catch {
    throw new MeshyRecoveryError('invalid-response');
  } finally {
    bytes.fill(0);
  }
}

/**
 * Attaches an operator-supplied provider task to the one retained uncertain
 * retexture reservation. It performs only a bounded GET and never discovers,
 * creates, replaces, or retries a task. The task must have been created no
 * earlier than the durable submission proof and may not be future-dated.
 */
export async function reconcileUncertainMeshyRetexture(
  store: MeshyRunStore,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  taskId: string,
  submittedAt: string,
  credential: string,
  deps: MeshyRecoveryDeps = meshyRecoveryDefaults,
) {
  const state = store.read();
  let providerTaskId: string;
  let submittedAtMilliseconds: number;
  try {
    providerTaskId = MeshyTaskId.parse(taskId);
    submittedAtMilliseconds = Date.parse(submittedAt);
    assertMeshyRunCap(state, maxCredits);
    if (
      !Number.isFinite(submittedAtMilliseconds) ||
      state.approval.specSha256 !== meshySpecIdentity(spec) ||
      meshyCredentialStatus(credential) !== 'present'
    )
      throw new Error('Invalid authority.');
  } catch {
    throw new MeshyRecoveryError('not-authorized');
  }
  if (
    !state.selection ||
    !state.requests.some((request) => request.operationId === 'retexture-selected') ||
    state.tasks.some((task) => task.operationId === 'retexture-selected')
  )
    throw new MeshyRecoveryError('unknown-candidate');
  const bytes = await boundedGet(
    `https://api.meshy.ai/openapi/v1/retexture/${providerTaskId}`,
    { Authorization: `Bearer ${credential.trim()}`, Accept: 'application/json' },
    ['application/json'],
    65_536,
    10_000,
    deps,
  );
  try {
    const task = MeshyRetextureTaskOutput.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    const now = deps.now().getTime();
    if (
      task.id !== providerTaskId ||
      task.created_at < submittedAtMilliseconds ||
      task.created_at > now + 5 * 60_000
    )
      throw new Error('Task identity or timing differs.');
    const receipt: MeshyTaskReceipt = {
      operationId: 'retexture-selected',
      taskId: providerTaskId,
      status: task.status,
      consumedCredits: terminal(task.status) ? (task.consumed_credits ?? null) : null,
      observedAt: deps.now().toISOString(),
    };
    const persisted = store.observe(receipt);
    return {
      receipt: persisted.tasks.find((entry) => entry.operationId === 'retexture-selected')!,
      task: task.status === 'SUCCEEDED' ? task : null,
    };
  } catch {
    throw new MeshyRecoveryError('invalid-response');
  } finally {
    bytes.fill(0);
  }
}

export const MESHY_GLB_DOWNLOAD_LIMIT = 64 * 1024 * 1024;
export const MESHY_TEXTURE_DOWNLOAD_LIMIT = 64 * 1024 * 1024;

/** Envelope check only, not glTF conformance, topology, self-containment or licence admission. */
export function assertMeshyGlbEnvelope(bytes: Buffer): void {
  if (
    bytes.length < 20 ||
    bytes.length > MESHY_GLB_DOWNLOAD_LIMIT ||
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    throw new MeshyRecoveryError('download-refused');
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new MeshyRecoveryError('download-refused');
    const length = bytes.readUInt32LE(offset);
    if (length % 4 !== 0 || offset + 8 + length > bytes.length)
      throw new MeshyRecoveryError('download-refused');
    offset += 8 + length;
  }
}

/** No Authorization header crosses to the asset host; redirects and arbitrary URLs are refused. */
export async function downloadMeshyGlb(
  signedUrl: string,
  deps: MeshyRecoveryDeps = meshyRecoveryDefaults,
): Promise<Buffer> {
  try {
    const url = new URL(signedUrl);
    if (
      signedUrl.length > 8_192 ||
      url.protocol !== 'https:' ||
      url.hostname !== 'assets.meshy.ai' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Refused asset URL.');
    const bytes = await boundedGet(
      url.href,
      { Accept: 'model/gltf-binary, application/octet-stream' },
      ['model/gltf-binary', 'application/octet-stream'],
      MESHY_GLB_DOWNLOAD_LIMIT,
      30_000,
      deps,
    );
    assertMeshyGlbEnvelope(bytes);
    return bytes;
  } catch {
    throw new MeshyRecoveryError('download-refused');
  }
}

/** Same fixed asset-host rule as GLBs, with no credentials forwarded to texture URLs. */
export async function downloadMeshyTexture(
  signedUrl: string,
  deps: MeshyRecoveryDeps = meshyRecoveryDefaults,
): Promise<Buffer> {
  try {
    const url = new URL(signedUrl);
    if (
      signedUrl.length > 8_192 ||
      url.protocol !== 'https:' ||
      url.hostname !== 'assets.meshy.ai' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Refused asset URL.');
    const bytes = await boundedGet(
      url.href,
      { Accept: 'image/png, image/jpeg' },
      ['image/png', 'image/jpeg'],
      MESHY_TEXTURE_DOWNLOAD_LIMIT,
      30_000,
      deps,
    );
    const png =
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) throw new Error('Invalid texture bytes.');
    return bytes;
  } catch {
    throw new MeshyRecoveryError('download-refused');
  }
}
