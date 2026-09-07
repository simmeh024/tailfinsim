/**
 * Discord OAuth 2.0, authorization-code flow with PKCE (AUTH-08).
 *
 * Structurally the same as `google.ts`, and deliberately so: the PKCE pair, the
 * CSPRNG `state`, the signed short-lived state cookie and the constant-time
 * comparison are not a Google-specific implementation detail, they are what
 * makes an authorization-code flow safe. A second provider that quietly relaxed
 * one of them would be the weaker of two doors into the same account.
 *
 * **No JWT verification here either.** Discord's token response is not an ID
 * token to validate; the access token is spent immediately on `users/@me` over
 * an authenticated TLS connection, which returns the same claims with no crypto
 * for us to get wrong. One extra round trip, as with Google.
 *
 * **Two scopes and no more.** `identify` and `email`. Discord's OAuth can grant
 * a great deal else — guild lists, guild membership, connections — and none of
 * it is needed to prove who someone is. Asking for more would turn a login
 * button into a permissions request, which players notice and dislike, and
 * `discord.test.ts` asserts the authorize URL requests exactly these two.
 *
 * **Authentication and any future Discord community integration stay separate.**
 * If Tailfin ever wants a bot or server-role sync, that is a different
 * application, a different consent screen and a different issue. Nothing here
 * should be reused as a foundation that assumes they share credentials.
 */

const AUTHORIZE_ENDPOINT = 'https://discord.com/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://discord.com/api/v10/oauth2/token';
const USERINFO_ENDPOINT = 'https://discord.com/api/v10/users/@me';

/** Discord's CDN, which is also the one host AUTH-08 adds to the CSP's `img-src`. */
const AVATAR_CDN = 'https://cdn.discordapp.com';

export function redirectUriFor(publicOrigin: string): string {
  // Must match a value registered on the Discord application exactly, path
  // included. Discord compares the whole string.
  return `${publicOrigin}/api/auth/discord/callback`;
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
  url.searchParams.set('scope', 'identify email');
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Discord re-shows its authorization screen on every login by default;
  // `none` skips it once the player has granted these exact scopes, so a
  // return visit is one click instead of two.
  //
  // The trade is worth naming rather than assuming. Nothing cryptographic
  // changes — the code exchange, PKCE verifier and state check are identical —
  // but the player stops *seeing* which Discord account is being used, so on a
  // shared browser they can land in whichever account Discord is already signed
  // in as. Google's equivalent is `select_account`, which Discord has no
  // counterpart for. What limits the damage is AUTH-04: arriving as somebody
  // other than the current session is refused rather than switched, and an
  // unwanted account is one sign-out away rather than a lost airline.
  url.searchParams.set('prompt', 'none');
  return url.toString();
}

export interface DiscordProfile {
  /** The stable account key: Discord's snowflake `id`. Never the username. */
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
    // Discord's error body can echo request parameters, so it is not logged.
    throw new Error(`Discord token exchange failed with ${String(response.status)}`);
  }

  const json: unknown = await response.json();
  const accessToken =
    typeof json === 'object' && json !== null && 'access_token' in json
      ? (json as { access_token?: unknown }).access_token
      : undefined;

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Discord token response contained no access_token');
  }
  return accessToken;
}

/**
 * Builds the CDN URL for a user's avatar, or null if they have none.
 *
 * Discord returns an avatar *hash*, not a URL, and the extension depends on the
 * hash: one prefixed `a_` is animated and only renders as `.gif`. A user with no
 * avatar gets null rather than one of Discord's default embed images — the
 * client already has its own default emblem, and pointing at Discord for a
 * placeholder would put a request to their CDN on the page of every player who
 * never set one.
 */
export function avatarUrlFor(userId: string, avatarHash: string | null): string | null {
  if (avatarHash === null || avatarHash.length === 0) return null;
  const extension = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `${AVATAR_CDN}/avatars/${userId}/${avatarHash}.${extension}`;
}

/** Reads the profile from Discord's user endpoint. */
export async function fetchProfile(accessToken: string): Promise<DiscordProfile> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Discord users/@me failed with ${String(response.status)}`);
  }

  const json: unknown = await response.json();
  if (typeof json !== 'object' || json === null) {
    throw new Error('Discord users/@me returned a non-object');
  }

  const claims = json as Record<string, unknown>;
  const subject = claims.id;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error('Discord users/@me returned no id');
  }

  const asStringOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  return {
    subject,
    // `verified` says whether Discord has confirmed the address. It is recorded
    // either way and matched on never (ADR-0004), so it changes nothing here —
    // but a future feature that *mails* a player must consult it rather than
    // assuming this column is deliverable.
    email: asStringOrNull(claims.email),
    // `global_name` is the modern display name; `username` is the legacy handle
    // and the fallback. Both are changeable, which is exactly why neither is the
    // subject — they are only ever used to name a *new* account.
    name: asStringOrNull(claims.global_name) ?? asStringOrNull(claims.username),
    avatarUrl: avatarUrlFor(subject, asStringOrNull(claims.avatar)),
  };
}
