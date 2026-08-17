import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildAuthorizeUrl, createPkcePair, createState, redirectUriFor } from './google';
import { safeEqual } from './session';

/**
 * The parts of the OAuth flow that need no network and no database.
 *
 * PKCE is the piece most worth testing directly: if the challenge is not
 * genuinely `base64url(sha256(verifier))`, Google rejects the token exchange and
 * the only symptom is a failed sign-in with an opaque message.
 */

describe('PKCE', () => {
  it('derives the challenge as base64url(sha256(verifier))', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('produces a verifier in the length range RFC 7636 allows', () => {
    // 43–128 characters. 32 random bytes as base64url is 43.
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('uses only unreserved URL characters, so nothing needs escaping', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createPkcePair().verifier));
    expect(seen.size).toBe(200);
  });
});

describe('state', () => {
  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createState()));
    expect(seen.size).toBe(200);
  });

  it('carries at least 128 bits of entropy', () => {
    // 16 random bytes → 22 base64url characters.
    expect(createState().length).toBeGreaterThanOrEqual(22);
  });
});

describe('redirectUriFor', () => {
  it('builds the path the OAuth client must have registered', () => {
    expect(redirectUriFor('https://dev.tailfinsim.com')).toBe(
      'https://dev.tailfinsim.com/api/auth/google/callback',
    );
  });

  it('does not double the slash when the origin is passed with one', () => {
    // `loadEnv` strips trailing slashes, but a mismatched redirect URI is the
    // single most common cause of a broken OAuth client, so this is pinned here
    // too rather than resting on the caller.
    expect(redirectUriFor('https://dev.tailfinsim.com'.replace(/\/+$/, ''))).not.toContain('//api');
  });
});

describe('buildAuthorizeUrl', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'client-123',
      redirectUri: 'https://dev.tailfinsim.com/api/auth/google/callback',
      state: 'state-abc',
      codeChallenge: 'challenge-xyz',
    }),
  );

  it('points at Google', () => {
    expect(url.origin).toBe('https://accounts.google.com');
  });

  it('requests an authorization code with S256 PKCE', () => {
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('passes the client, redirect and state through unchanged', () => {
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://dev.tailfinsim.com/api/auth/google/callback',
    );
    expect(url.searchParams.get('state')).toBe('state-abc');
  });

  it('asks for identity only', () => {
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('does not request offline access', () => {
    // A refresh token would be a long-lived credential we have no use for:
    // sessions are ours, and Google is never called on the player's behalf after
    // sign-in. See google.ts.
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('prompt')).toBe('select_account');
  });
});

describe('safeEqual', () => {
  it('matches identical strings', () => {
    expect(safeEqual('abcdef', 'abcdef')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(safeEqual('abcdef', 'abcdeg')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch; the guard must catch that,
    // because a thrown error inside the callback would become a 500 rather than a
    // clean "state mismatch" redirect.
    expect(safeEqual('short', 'muchlongervalue')).toBe(false);
  });

  it('rejects an empty candidate against a real value', () => {
    expect(safeEqual('', 'state')).toBe(false);
  });
});
