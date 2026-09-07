import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE and CSPRNG state, shared by every authorization-code provider (AUTH-08).
 *
 * These were written once for Google and would have been copied for Discord.
 * They are not provider-specific — RFC 7636 is the same challenge for everyone
 * — and a second copy is a second place for `sha256` to become something
 * cheaper, or for the entropy to be trimmed, under a well-meant edit that only
 * one of the two test files would catch.
 */

/** URL-safe random string, used for both the state and the PKCE verifier. */
function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomUrlSafe(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState(): string {
  return randomUrlSafe(16);
}
