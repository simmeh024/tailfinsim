/**
 * Twitch OAuth 2.0, authorization-code flow (AUTH-08's third provider).
 *
 * Structurally the same as `google.ts` and `discord.ts` — the CSPRNG `state`,
 * the signed short-lived state cookie and the constant-time comparison are
 * shared by `registerAuthRoutes` and are not negotiable per provider.
 *
 * ## Twitch does not do PKCE, and that is stated rather than hidden
 *
 * `discord.ts` warns that *"a second provider that quietly relaxed one of them
 * would be the weaker of two doors into the same account"*. This is the third
 * provider and it does relax one — so it is said out loud.
 *
 * Twitch's authorization-code grant documents exactly six authorize parameters
 * (`response_type`, `client_id`, `redirect_uri`, `scope`, `state`,
 * `force_verify`) and five token parameters (`client_id`, `client_secret`,
 * `code`, `grant_type`, `redirect_uri`). `code_challenge` and `code_verifier`
 * are not among them. Sending them anyway would be spec-safe — RFC 6749 says an
 * authorization server must ignore unrecognised parameters — but it would put
 * PKCE-shaped code in a flow that has no PKCE in it, and the next reader would
 * believe the protection is there.
 *
 * **What still protects this flow**, and why it is not the weaker door:
 *
 * - It is a **confidential client**. The code is exchanged with
 *   `client_secret`, which never leaves the server, so an intercepted
 *   authorization code is not by itself exchangeable. PKCE's primary job —
 *   protecting a public client that has no secret — does not apply.
 * - **Code injection is covered by the state binding.** `state` is a CSPRNG
 *   value stored in a signed, short-lived, `SameSite` cookie and compared in
 *   constant time on return. An attacker cannot graft their own code onto a
 *   victim's session without also forging that cookie.
 *
 * If Twitch adds PKCE, turn it on here: pass `code_challenge` and
 * `code_challenge_method` in {@link buildAuthorizeUrl} and `code_verifier` in
 * {@link exchangeCode}, both of which already receive the values.
 *
 * ## One scope
 *
 * `user:read:email`, and nothing else. Twitch's OAuth can grant a great deal —
 * channel edits, subscriptions, chat, moderation — and none of it proves who
 * somebody is. Without this one scope `helix/users` simply omits the email.
 *
 * ## The Client-Id header is not optional
 *
 * Unlike Google's and Discord's userinfo endpoints, `helix/users` requires the
 * application's client id **alongside** the bearer token. A request with only
 * the token is refused, which is why {@link fetchProfile} takes a second
 * argument the other two providers ignore.
 */

const AUTHORIZE_ENDPOINT = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
const USERINFO_ENDPOINT = 'https://api.twitch.tv/helix/users';

export function redirectUriFor(publicOrigin: string): string {
  // Must match a value registered on the Twitch application exactly, path
  // included. Twitch compares the whole string and rejects a mismatch before
  // the player ever sees a consent screen.
  return `${publicOrigin}/api/auth/twitch/callback`;
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Accepted for interface parity and deliberately unused — see the file header. */
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'user:read:email');
  url.searchParams.set('state', options.state);
  /*
   * `force_verify` is deliberately left off, which matches Discord's `prompt=none`
   * and Google's default: a returning player who has already granted this one
   * scope gets one click rather than two.
   *
   * Same trade as Discord's, named for the same reason. The player stops
   * *seeing* which Twitch account is being used, so on a shared browser they can
   * arrive as whoever Twitch is already signed in as. AUTH-04 is what limits
   * the damage: arriving as somebody other than the current session is refused
   * rather than switched.
   */
  return url.toString();
}

export interface TwitchProfile {
  /** The stable account key: Twitch's numeric user `id`. Never the login name. */
  subject: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/** Exchanges the authorization code for an access token. */
export async function exchangeCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Accepted for interface parity and deliberately unused — see the file header. */
  codeVerifier: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // The status and nothing else: Twitch's error body can echo request
    // parameters, and one of those is the client secret.
    throw new Error(`Twitch token exchange failed with ${String(response.status)}`);
  }

  const json: unknown = await response.json();
  const accessToken =
    typeof json === 'object' && json !== null && 'access_token' in json
      ? (json as { access_token?: unknown }).access_token
      : undefined;

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Twitch token response contained no access_token');
  }
  return accessToken;
}

/**
 * Reads the profile from Twitch's Helix users endpoint.
 *
 * Takes the client id as well as the token because Twitch requires both; the
 * other two providers' `fetchProfile` ignores the second argument.
 *
 * The response wraps the user in a `data` array — Helix returns collections
 * everywhere, even for "the current user" — so an empty array is a real
 * possibility and is refused rather than read as a user with no fields.
 */
export async function fetchProfile(accessToken: string, clientId: string): Promise<TwitchProfile> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'client-id': clientId,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Twitch helix/users failed with ${String(response.status)}`);
  }

  const json: unknown = await response.json();
  if (typeof json !== 'object' || json === null || !('data' in json)) {
    throw new Error('Twitch helix/users returned no data array');
  }

  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Twitch helix/users returned an empty data array');
  }

  const user: unknown = data[0];
  if (typeof user !== 'object' || user === null) {
    throw new Error('Twitch helix/users returned a non-object user');
  }

  const claims = user as Record<string, unknown>;
  const subject = claims.id;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error('Twitch helix/users returned no id');
  }

  const asStringOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  return {
    subject,
    /*
     * Absent unless `user:read:email` was granted, and absent is a legitimate
     * answer rather than an error: ADR-0004 matches accounts on the provider
     * subject and never on the address, so a player with no email is a player
     * with no email. A future feature that *mails* somebody has to check.
     */
    email: asStringOrNull(claims.email),
    // `display_name` is what Twitch shows; `login` is the lowercase handle and
    // the fallback. Both are changeable, which is exactly why neither is the
    // subject — they only ever name a *new* account.
    name: asStringOrNull(claims.display_name) ?? asStringOrNull(claims.login),
    /*
     * A full URL from Twitch's own CDN, unlike Discord's hash. Empty for a user
     * who never set one, which becomes null rather than a Twitch default image
     * — the client has its own emblem, and pointing at their CDN would put a
     * third-party request on the page of every player without a picture.
     */
    avatarUrl: asStringOrNull(claims.profile_image_url),
  };
}
