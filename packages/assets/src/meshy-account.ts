import { z } from 'zod';

import { meshyCredentialStatus, meshySpecIdentity, type MeshyGenerationSpec } from './meshy';
import { assertMeshyRunCap, type MeshyRunState } from './meshy-run';

const BALANCE_URL = 'https://api.meshy.ai/openapi/v1/balance';
const Balance = z.object({ balance: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const RESPONSE_LIMIT = 4_096;

export class MeshyAccountError extends Error {
  constructor(
    readonly code: 'unavailable' | 'authentication-refused' | 'http-refused' | 'invalid-response',
  ) {
    super(`Meshy account check ${code}; no generation submitted.`);
  }
}

async function readBalance(response: Response): Promise<number> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel();
    throw new Error('Invalid account response.');
  }
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT || !response.body) {
    await response.body?.cancel();
    throw new Error('Invalid account response.');
  }
  // Fetch response bodies carry bytes; reject malformed injected transports too.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid account response.');
      length += value.length;
      if (length > RESPONSE_LIMIT) throw new Error('Invalid account response.');
      chunks.push(value);
    }
    return Balance.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown).balance;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export interface MeshyAccountDeps {
  fetch: typeof globalThis.fetch;
  pause: (milliseconds: number) => Promise<void>;
  now: () => Date;
}

/** Read-only provider access. No POST, custom host, redirect, key echo or raw error escapes. */
export async function checkMeshyAccount(
  state: MeshyRunState,
  spec: MeshyGenerationSpec,
  maxCredits: number,
  credential: string,
  deps: MeshyAccountDeps = {
    fetch: globalThis.fetch,
    pause: (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds)),
    now: () => new Date(),
  },
) {
  assertMeshyRunCap(state, maxCredits);
  if (
    state.approval.specSha256 !== meshySpecIdentity(spec) ||
    meshyCredentialStatus(credential) !== 'present'
  ) {
    throw new Error('Approved specification and local credential are required.');
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await deps.fetch(BALANCE_URL, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${credential.trim()}`, Accept: 'application/json' },
      });
    } catch {
      if (attempt === 2) throw new MeshyAccountError('unavailable');
      await deps.pause(250 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        throw new MeshyAccountError('invalid-response');
      }
      if (response.status === 401 || response.status === 403)
        throw new MeshyAccountError('authentication-refused');
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await deps.pause(250 * (attempt + 1));
        continue;
      }
      throw new MeshyAccountError('http-refused');
    }
    try {
      const balance = await readBalance(response);
      return {
        format: 'tailfin-meshy-account-readiness',
        formatVersion: 1,
        checkedAt: deps.now().toISOString(),
        authenticated: true,
        balance,
        approvedMaxCredits: state.approval.maxCredits,
        coversApprovedCeiling: balance >= state.approval.maxCredits,
        generationAvailable: false,
        creditsSpentByThisCommand: 0,
        planAndPrivateLicenceVerified: false,
      };
    } catch {
      throw new MeshyAccountError('invalid-response');
    }
  }
  throw new MeshyAccountError('unavailable');
}
