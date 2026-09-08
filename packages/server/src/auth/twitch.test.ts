import { describe, expect, it } from 'vitest';

import { buildAuthorizeUrl, fetchProfile, redirectUriFor } from './twitch';

/**
 * Twitch OAuth (AUTH-08's third provider).
 *
 * The same ground as `discord.test.ts` plus the two things that differ, both of
 * which are the kind that fail silently rather than loudly: the absent PKCE and
 * the required `Client-Id` header.
 */

const OPTIONS = {
  clientId: 'client-123',
  redirectUri: 'https://tailfinsim.com/api/auth/twitch/callback',
  state: 'state-abc',
  codeChallenge: 'challenge-xyz',
};

describe('redirectUriFor', () => {
  it('is the path registered on the Twitch application, exactly', () => {
    // Twitch compares the whole string, so this is the value a person types
    // into the developer console and any drift breaks sign-in before the
    // consent screen appears.
    expect(redirectUriFor('https://tailfinsim.com')).toBe(
      'https://tailfinsim.com/api/auth/twitch/callback',
    );
    expect(redirectUriFor('https://dev.tailfinsim.com')).toBe(
      'https://dev.tailfinsim.com/api/auth/twitch/callback',
    );
  });
});

describe('buildAuthorizeUrl', () => {
  const url = new URL(buildAuthorizeUrl(OPTIONS));

  it('points at Twitch', () => {
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
  });

  it('asks for one scope and nothing else', () => {
    // Twitch can grant channel edits, subscriptions, chat and moderation. None
    // of that proves who somebody is, and a login button that asks for it is a
    // permissions request players notice and refuse.
    expect(url.searchParams.get('scope')).toBe('user:read:email');
  });

  it('carries the state and the exact redirect URI', () => {
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(OPTIONS.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
  });

  it('sends no PKCE, because Twitch documents none', () => {
    /*
     * Asserted rather than left as an absence, because this is the one place
     * Tailfin's three providers differ and the difference is invisible.
     *
     * Twitch's authorization-code grant documents six authorize parameters and
     * `code_challenge` is not among them. Sending it would be spec-safe and
     * would put PKCE-shaped code in a flow with no PKCE in it, so the next
     * reader would believe a protection is present that is not. `twitch.ts`
     * explains what covers the gap: a confidential-client exchange and the
     * signed, provider-bound state cookie.
     *
     * If Twitch adds PKCE, this test is the thing that should fail.
     */
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
  });

  it('does not force the consent screen on a returning player', () => {
    // Matches Discord's `prompt=none` and Google's default: one click, not two,
    // for somebody who has already granted this single scope.
    expect(url.searchParams.get('force_verify')).toBeNull();
  });
});

describe('fetchProfile', () => {
  function stubFetch(body: unknown, status = 200) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = ((url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as Response);
    }) as typeof fetch;
    return calls;
  }

  const USER = {
    id: '141981764',
    login: 'twitchdev',
    display_name: 'TwitchDev',
    email: 'not-real@twitch.tv',
    profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/abc.png',
  };

  it('sends the client id alongside the token', async () => {
    /*
     * The failure this prevents is a 401 that looks like a bad token. Unlike
     * Google's and Discord's userinfo endpoints, Helix requires the application's
     * client id *as well as* the bearer token and refuses a request with only
     * one — which is why `fetchProfile` takes a second argument the other two
     * providers ignore.
     */
    const calls = stubFetch({ data: [USER] });
    await fetchProfile('token-abc', 'client-123');

    expect(calls[0]?.url).toBe('https://api.twitch.tv/helix/users');
    expect(calls[0]?.headers.authorization).toBe('Bearer token-abc');
    expect(calls[0]?.headers['client-id']).toBe('client-123');
  });

  it('reads the first user out of the data array', async () => {
    // Helix returns collections everywhere, even for "the current user".
    stubFetch({ data: [USER] });
    await expect(fetchProfile('token-abc', 'client-123')).resolves.toEqual({
      subject: '141981764',
      email: 'not-real@twitch.tv',
      name: 'TwitchDev',
      avatarUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/abc.png',
    });
  });

  it('refuses an empty data array rather than reading a user with no fields', async () => {
    stubFetch({ data: [] });
    await expect(fetchProfile('token-abc', 'client-123')).rejects.toThrow(/empty data array/);
  });

  it('falls back to the login handle when there is no display name', async () => {
    stubFetch({ data: [{ ...USER, display_name: '' }] });
    const profile = await fetchProfile('token-abc', 'client-123');
    expect(profile.name).toBe('twitchdev');
    // ...and neither is ever the subject, because both are changeable.
    expect(profile.subject).toBe('141981764');
  });

  it('treats a missing email as absent rather than as an error', async () => {
    // `user:read:email` may not have been granted. ADR-0004 matches on the
    // provider subject and never on the address, so this changes nothing.
    stubFetch({ data: [{ ...USER, email: undefined }] });
    await expect(fetchProfile('token-abc', 'client-123')).resolves.toMatchObject({ email: null });
  });

  it('gives no avatar rather than pointing at a Twitch placeholder', async () => {
    // The client has its own default emblem. Falling back to Twitch's would put
    // a third-party request on the page of every player who never set a picture.
    stubFetch({ data: [{ ...USER, profile_image_url: '' }] });
    await expect(fetchProfile('token-abc', 'client-123')).resolves.toMatchObject({
      avatarUrl: null,
    });
  });

  it('only ever points at the host the CSP allows', async () => {
    // `img-src` names `static-cdn.jtvnw.net` and nothing else of Twitch's, so an
    // avatar from anywhere else would be blocked by the browser.
    stubFetch({ data: [USER] });
    const profile = await fetchProfile('token-abc', 'client-123');
    expect(profile.avatarUrl?.startsWith('https://static-cdn.jtvnw.net/')).toBe(true);
  });

  it('says the status and nothing else when Helix refuses', async () => {
    stubFetch({ error: 'Unauthorized' }, 401);
    await expect(fetchProfile('token-abc', 'client-123')).rejects.toThrow(
      /helix\/users failed with 401/,
    );
  });
});
