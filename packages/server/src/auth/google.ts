import { createHash, randomBytes } from 'node:crypto';

/**
 * Google OAuth 2.0, authorization-code flow with PKCE (ADR-0004).
 *
 * **No JWT verification anywhere here, on purpose.** Google returns an ID token
 * from the token endpoint, and verifying its signature against Google's JWKS is
 * both fiddly and the sort of security-critical code that is quietly wrong for
 * years. Instead the access token is used to call Google's userinfo endpoint,
 * which returns the same claims over an authenticated TLS connection. One extra
 * round trip, no crypto to get wrong.
 */

const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

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

export function redirectUriFor(publicOrigin: string): string {
  // Must match a value registered on the OAuth client exactly, path included.
  return `${publicOrigin}/api/auth/google/callback`;
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // No refresh token: sessions are ours, and we never call Google on the
  // player's behalf after sign-in. Asking for offline access would mean storing
  // a long-lived credential for no benefit.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export interface GoogleProfile {
  /** The stable account key. Never the email — see ADR-0004. */
  subject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

/** Exchanges the authorization code for an access token. */
export async function exchangeCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // Google's error body can echo request parameters, so it is not logged.
    throw new Error(`Google token exchange failed with ${String(response.status)}`);
  }

  const json: unknown = await response.json();
  const accessToken =
    typeof json === 'object' && json !== null && 'access_token' in json
      ? (json as { access_token?: unknown }).access_token
      : undefined;

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Google token response contained no access_token');
  }
  return accessToken;
}

/** Reads the profile from Google's userinfo endpoint. */
export async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Google userinfo failed with ${String(response.status)}`);
  }

  const json: unknown = await response.json();
  if (typeof json !== 'object' || json === null) {
    throw new Error('Google userinfo returned a non-object');
  }

  const claims = json as Record<string, unknown>;
  const subject = claims.sub;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error('Google userinfo returned no sub claim');
  }

  const asStringOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  return {
    subject,
    email: asStringOrNull(claims.email),
    name: asStringOrNull(claims.name),
    picture: asStringOrNull(claims.picture),
  };
}
