import { describe, expect, it } from 'vitest';

import { avatarUrlFor, buildAuthorizeUrl, redirectUriFor } from './discord';

/**
 * The Discord provider's protocol surface (AUTH-08).
 *
 * The PKCE and state helpers are shared and tested in `google.test.ts` against
 * `pkce.ts`; what is Discord-specific is the endpoint, the scopes, the redirect
 * URI and the fact that an avatar arrives as a hash rather than a URL.
 */

describe('redirectUriFor', () => {
  it('is the path registered on the Discord application, exactly', () => {
    expect(redirectUriFor('https://dev.tailfinsim.com')).toBe(
      'https://dev.tailfinsim.com/api/auth/discord/callback',
    );
  });

  it('does not double the slash when the origin has none', () => {
    expect(redirectUriFor('https://tailfinsim.com')).not.toContain('//api');
  });
});

describe('buildAuthorizeUrl', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: '1546526514504278117',
      redirectUri: 'https://dev.tailfinsim.com/api/auth/discord/callback',
      state: 'state-value',
      codeChallenge: 'challenge-value',
    }),
  );

  it('points at Discord', () => {
    expect(url.origin).toBe('https://discord.com');
    expect(url.pathname).toBe('/oauth2/authorize');
  });

  /**
   * The acceptance criterion, and the one worth a test of its own: a login
   * button must not become a permissions request. Discord's OAuth can grant
   * guild lists, guild membership and connections, and none of it is needed to
   * prove who someone is.
   *
   * Asserted as an exact set rather than "contains identify", so a scope added
   * later fails here instead of quietly widening the consent screen.
   */
  it('asks for identify and email and nothing else', () => {
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', 'identify']);
  });

  it('uses the authorization-code flow with PKCE', () => {
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('carries the state and the exact redirect URI', () => {
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://dev.tailfinsim.com/api/auth/discord/callback',
    );
  });

  it('never asks for offline access', () => {
    // Sessions are ours and Discord is never called on the player's behalf
    // after sign-in, so a refresh token would be a long-lived credential stored
    // for no benefit.
    expect(url.searchParams.get('scope')).not.toContain('offline');
    expect(url.searchParams.has('access_type')).toBe(false);
  });
});

describe('avatarUrlFor', () => {
  it('builds a CDN URL from the hash', () => {
    expect(avatarUrlFor('123', 'abc')).toBe('https://cdn.discordapp.com/avatars/123/abc.png');
  });

  /**
   * An `a_` prefix means an animated avatar, which only renders as `.gif` —
   * requesting `.png` for one returns a 415 and the player sees a broken image
   * rather than no image.
   */
  it('uses gif for an animated avatar', () => {
    expect(avatarUrlFor('123', 'a_xyz')).toBe('https://cdn.discordapp.com/avatars/123/a_xyz.gif');
  });

  it('is null when the player has no avatar', () => {
    // Null, not one of Discord's default embed images: the client has its own
    // default emblem, and pointing at their CDN for a placeholder would put a
    // third-party request on the page of every player who never set one.
    expect(avatarUrlFor('123', null)).toBeNull();
    expect(avatarUrlFor('123', '')).toBeNull();
  });

  it('only ever points at the host the CSP allows', () => {
    // `deploy/Caddyfile` allows exactly `https://cdn.discordapp.com` in
    // `img-src`. An avatar URL on any other host would be blocked by the
    // browser, which looks like a broken avatar rather than a policy gap.
    const built = avatarUrlFor('123', 'abc');
    expect(built).not.toBeNull();
    expect(new URL(built!).origin).toBe('https://cdn.discordapp.com');
  });
});
