import {
  logoutResponseJsonSchema,
  meResponseJsonSchema,
  revokeSessionsResponseJsonSchema,
  type AuthFailureCode,
} from '@tailfin/shared';

import { type AdminCapability, type AdminRole, roleHasCapability } from '../admin/capabilities';
import { adminRoleOf, isAdmin } from '../admin/grants';
import { type DatabaseHandle } from '../db/client';
import { type AuthProviderName } from '../db/schema';
import { type ServerEnv } from '../env';

import {
  buildAuthorizeUrl as buildDiscordAuthorizeUrl,
  exchangeCode as discordExchangeCode,
  fetchProfile as discordFetchProfile,
  redirectUriFor as discordRedirectUriFor,
  type DiscordProfile,
} from './discord';
import {
  buildAuthorizeUrl as buildGoogleAuthorizeUrl,
  exchangeCode as googleExchangeCode,
  fetchProfile as googleFetchProfile,
  redirectUriFor as googleRedirectUriFor,
  type GoogleProfile,
} from './google';
import { signInWithIdentity, type IdentityFailure, type ProvenIdentity } from './identity';
import { createPkcePair, createState } from './pkce';
import { revokePlayerSessions } from './revocation';
import {
  destroySession,
  findSessionPlayer,
  replaceSession,
  safeEqual,
  SESSION_COOKIE,
  type SessionPlayer,
} from './session';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Auth routes (M0-11).
 *
 * Registered whether or not auth is configured: `/api/me` must answer either
 * way, and the sign-in routes return 503 rather than 404 when credentials are
 * absent, so a misconfigured environment says "not configured" instead of
 * looking like a missing feature.
 */

/**
 * Turns an account-policy refusal into the code the client can explain.
 *
 * Exhaustive with no `default`, so AUTH-04's conflict codes cannot be added
 * without someone deciding what a *player* should be told about each one. A
 * catch-all here would silently render every new conflict as the generic
 * failure, which is the one outcome that leaves somebody stuck with no idea
 * what to do next.
 */
function signInFailureCode(failure: IdentityFailure): AuthFailureCode {
  switch (failure.code) {
    case 'registration_closed':
      return 'registration_closed';
    case 'identity_already_linked':
      // AUTH-04: this identity is some other account's. Its own code, because
      // "try again" is the wrong advice — the attempt will be refused
      // identically, and what works is signing out or connecting it from the
      // account page.
      return 'identity_already_linked';
    case 'last_method':
    case 'not_found':
      // Unreachable from sign-in: `signInWithIdentity` neither links nor
      // unlinks, so it cannot produce these. Mapped rather than thrown, because
      // an unexpected refusal should still land the player back on the login
      // page with something to read instead of a 500.
      return 'exchange_failed';
  }
}

/** Holds the OAuth `state` and PKCE verifier between the two legs of the flow. */
const OAUTH_COOKIE = 'tailfin_oauth';
const OAUTH_COOKIE_TTL_SECONDS = 600;

declare module 'fastify' {
  interface FastifyRequest {
    player?: SessionPlayer;
    /**
     * Whether the signed-in player holds an admin grant (M1A-01).
     *
     * Resolved once per request alongside the session rather than per route, so
     * a route cannot forget to look and cannot answer a different question from
     * the one `requireAdmin` asks.
     */
    isAdmin?: boolean;
    /**
     * Which role that grant carries, or null for a signed-in non-admin (M11-01).
     *
     * Resolved in the same read as `isAdmin`, so "is an administrator" and "which
     * administrator" can never disagree.
     */
    adminRole?: AdminRole | null;
  }
  interface FastifyInstance {
    /** Rejects with 401 unless a valid session is present. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Rejects with 401 without a session, 403 without an admin grant.
     *
     * Two codes because they mean different things to a client: 401 says "sign
     * in and try again", 403 says "signing in again will not help". Collapsing
     * them sends a signed-in non-admin round the login loop for ever.
     */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * The same boundary as `requireAdmin`, narrowed to one capability (M11-01).
     *
     * A factory rather than a hook, because the capability is a property of the
     * route: `{ onRequest: app.requireCapability('world.reset') }` reads as what
     * the route needs, and a route that needs nothing in particular cannot
     * silently inherit everything. The refusal is byte-identical to
     * `requireAdmin`'s, so a Support administrator probing the console learns
     * only that they may not do it — not which role could.
     */
    requireCapability: (
      capability: AdminCapability,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthRoutesOptions {
  env: ServerEnv;
  db: DatabaseHandle;
  /** Provider boundary injected only by callback integration tests. */
  googleAuth?: GoogleAuthOperations;
  discordAuth?: DiscordAuthOperations;
}

/**
 * The two network calls an authorization-code provider makes, as an injection
 * point for tests that drive a callback without reaching the real provider.
 */
export interface OAuthOperations<Profile> {
  exchangeCode: (options: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    codeVerifier: string;
  }) => Promise<string>;
  fetchProfile: (accessToken: string) => Promise<Profile>;
}

export type GoogleAuthOperations = OAuthOperations<GoogleProfile>;
export type DiscordAuthOperations = OAuthOperations<DiscordProfile>;

/**
 * Everything that genuinely differs between one OAuth provider and another.
 *
 * The credentials are read through functions rather than captured as values so
 * a test can rebuild `env` between cases without re-registering the routes.
 *
 * `toIdentity` is the seam where a provider's own profile shape becomes the
 * narrow thing account policy accepts — and it deliberately cannot pass the
 * whole profile through, because the moment it could, somebody would match on a
 * field in it.
 */
interface OAuthProvider<Profile> {
  name: AuthProviderName;
  /** Used only in the "not configured" message a misconfigured instance returns. */
  label: string;
  enabled: () => boolean;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  buildAuthorizeUrl: (options: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }) => string;
  redirectUriFor: (publicOrigin: string) => string;
  operations: OAuthOperations<Profile>;
  toIdentity: (profile: Profile) => Omit<ProvenIdentity, 'provider'>;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { env, db, googleAuth, discordAuth }: AuthRoutesOptions,
): void {
  const secureCookies = env.publicOrigin.startsWith('https://');

  const sessionCookieOptions = {
    httpOnly: true,
    // Off over plain HTTP or the cookie is never sent back on localhost.
    secure: secureCookies,
    // Lax, not Strict: an OAuth callback is a cross-site top-level navigation
    // back from the provider, and Strict would withhold the cookie on arrival.
    // Same-origin API calls (ADR-0003) mean Lax is sufficient.
    sameSite: 'lax' as const,
    path: '/',
  };

  /**
   * Populate `request.player`, without enforcing anything. Routes that require a
   * session use `requireAuth`; routes that merely adapt to one read
   * `request.player`.
   *
   * Inside `after()` on purpose. `@fastify/cookie` parses cookies in an
   * `onRequest` hook of its own, and hooks run in the order `addHook` was
   * *called* — not the order plugins finish loading. `app.register()` merely
   * queues, so calling `addHook` straight after it would put this hook first and
   * `request.cookies` would be empty every time. `after()` defers until the
   * cookie plugin has actually loaded. (`session-cookie.test.ts` fails if this
   * is moved out.)
   */
  app.after(() => {
    app.addHook('onRequest', async (request) => {
      if (!env.authEnabled) return;
      // Only the API consumes the player. Skipping the rest avoids a database
      // round trip per static asset on every page load; nothing outside /api
      // reads `request.player` (ADR-0003: the client is a separate SPA).
      if (!request.url.startsWith('/api')) return;

      const token = request.cookies[SESSION_COOKIE];
      if (!token) return;
      const found = await findSessionPlayer(db.db, token);
      if (!found) return;

      request.player = found;
      // Resolved here, once, rather than in each admin route. A grant checked in
      // one place cannot drift from the grant checked in another, and there is
      // no route that can forget to look. The role comes from the same read, so
      // `isAdmin` is exactly "holds a role this build understands" (M11-01).
      const role = await adminRoleOf(db.db, found.id);
      request.adminRole = role;
      request.isAdmin = role !== null;
    });
  });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.player) {
      await reply.code(401).send({ code: 'unauthorized', message: 'Sign in required' });
    }
  });

  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.player) {
      await reply.code(401).send({ code: 'unauthorized', message: 'Sign in required' });
      return;
    }
    if (request.isAdmin !== true) {
      // Deliberately says nothing about what the route does or whether it
      // exists. A 403 that explains the shape of the console to someone without
      // access is a map drawn for the wrong person.
      request.log.warn({ playerId: request.player.id, url: request.url }, 'admin route refused');
      await reply.code(403).send({ code: 'forbidden', message: 'Administrator access required' });
    }
  });

  app.decorate('requireCapability', (capability: AdminCapability) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.player) {
        await reply.code(401).send({ code: 'unauthorized', message: 'Sign in required' });
        return;
      }
      const role = request.adminRole;
      if (role === null || role === undefined || !roleHasCapability(role, capability)) {
        // The capability is logged but never sent. The operator who was refused
        // can be told what they lack by someone who can see the log; the response
        // stays the same one a non-admin gets, so probing the console cannot map it.
        request.log.warn(
          { playerId: request.player.id, url: request.url, capability, role },
          'admin capability refused',
        );
        await reply.code(403).send({ code: 'forbidden', message: 'Administrator access required' });
      }
    };
  });

  // ------------------------------------------------------------------ /api/me

  app.get(
    '/api/me',
    { schema: { response: { 200: meResponseJsonSchema } } },
    async (request, reply) =>
      reply.code(200).send({
        player: request.player
          ? {
              id: request.player.id,
              displayName: request.player.displayName,
              avatarUrl: request.player.avatarUrl,
              createdAt: request.player.createdAt.toISOString(),
              displayCurrency: request.player.displayCurrency,
            }
          : null,
        registrationOpen: env.allowRegistration,
        // What this instance can actually offer, not what the schema can store.
        signInProviders: [
          ...(env.googleEnabled ? (['google'] as const) : []),
          ...(env.discordEnabled ? (['discord'] as const) : []),
        ],
        // False for anonymous visitors by construction: the flag is only set
        // alongside a resolved session, so there is no state where a stranger is
        // told anything about admin at all.
        isAdmin: request.isAdmin === true,
      }),
  );

  // ------------------------------------------------------------ sign in / out

  /**
   * One provider's two routes: the redirect out, and the callback back.
   *
   * Parameterised rather than copied. The PKCE pair, the CSPRNG state, the
   * signed short-lived cookie, the constant-time comparison and the failure
   * vocabulary *are* the security of an authorization-code flow, not incidental
   * detail — and a second copy is a second place for one of them to be relaxed
   * by a well-meant edit that only one test file would catch. What genuinely
   * differs between providers is three things: the endpoints, the credentials,
   * and the shape of the profile that comes back. Those are the arguments.
   */
  function registerOAuthProvider<Profile>(config: OAuthProvider<Profile>): void {
    const { name, label } = config;

    const notConfigured = (reply: FastifyReply): FastifyReply =>
      reply
        .code(503)
        .send({ code: 'auth_not_configured', message: `${label} sign-in is not configured` });

    app.get(`/api/auth/${name}`, async (_request, reply) => {
      // This provider's own flag, never `authEnabled`: with more than one
      // provider, "auth works here" no longer implies "this provider works
      // here", and the difference is a player sent to a consent screen for an
      // application this instance has no credentials for.
      const clientId = config.clientId();
      if (!config.enabled() || !clientId) return notConfigured(reply);

      const state = createState();
      const { verifier, challenge } = createPkcePair();

      // Signed so a client cannot forge a state/verifier pair of its own. The
      // provider name rides along and is checked on the way back: with two
      // providers a state minted for one must not be presentable at the
      // other's callback.
      void reply.setCookie(OAUTH_COOKIE, JSON.stringify({ provider: name, state, verifier }), {
        ...sessionCookieOptions,
        signed: true,
        maxAge: OAUTH_COOKIE_TTL_SECONDS,
      });

      return reply.redirect(
        config.buildAuthorizeUrl({
          clientId,
          redirectUri: config.redirectUriFor(env.publicOrigin),
          state,
          codeChallenge: challenge,
        }),
      );
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      `/api/auth/${name}/callback`,
      async (request, reply) => {
        const clientId = config.clientId();
        const clientSecret = config.clientSecret();
        if (!config.enabled() || !clientId || !clientSecret) return notConfigured(reply);

        const fail = (code: string): FastifyReply => {
          void reply.clearCookie(OAUTH_COOKIE, { path: '/' });
          // Back to the app with a code the UI can explain, rather than a bare
          // error page. Never includes anything from the provider's response.
          return reply.redirect(`/?auth_error=${code}`);
        };

        if (request.query.error) {
          request.log.warn(
            { provider: name, providerError: request.query.error },
            'provider returned an error',
          );
          return fail('provider_error');
        }

        const { code, state } = request.query;
        if (!code || !state) return fail('provider_error');

        const raw = request.cookies[OAUTH_COOKIE];
        const unsigned = raw ? reply.unsignCookie(raw) : null;
        if (!unsigned?.valid || !unsigned.value) return fail('state_mismatch');

        let stored: { provider?: unknown; state?: unknown; verifier?: unknown };
        try {
          stored = JSON.parse(unsigned.value) as typeof stored;
        } catch {
          return fail('state_mismatch');
        }

        if (
          typeof stored.state !== 'string' ||
          typeof stored.verifier !== 'string' ||
          // A state minted for another provider is as invalid as a forged one.
          // The exchange would fail anyway — wrong client, wrong endpoint — but
          // failing here keeps the reason legible and the credential unused.
          stored.provider !== name ||
          !safeEqual(stored.state, state)
        ) {
          return fail('state_mismatch');
        }

        let profile: Profile;
        try {
          const accessToken = await config.operations.exchangeCode({
            code,
            clientId,
            clientSecret,
            redirectUri: config.redirectUriFor(env.publicOrigin),
            codeVerifier: stored.verifier,
          });
          profile = await config.operations.fetchProfile(accessToken);
        } catch (error) {
          request.log.error({ err: error, provider: name }, 'oauth exchange failed');
          return fail('exchange_failed');
        }

        // Account policy is one module for every provider (AUTH-02). Resolving
        // on `(provider, subject)`, the ALLOW_REGISTRATION gate and AUTH-04's
        // conflict rules all live in `signInWithIdentity`, so Discord, magic
        // link (AUTH-10) and passkeys (AUTH-15) cannot answer the same question
        // differently. Matching is on the provider subject and never the email
        // address (ADR-0004), enforced by `identity-email.test.ts`.
        const outcome = await signInWithIdentity(
          db.db,
          { provider: name, ...config.toIdentity(profile) },
          {
            allowRegistration: env.allowRegistration,
            // Refusal-only, and what makes AUTH-04's rule hold here: a callback
            // for somebody else's account must not silently replace this
            // player's session. `fail` clears only the OAuth state cookie,
            // never `tailfin_session`, so a refusal leaves them signed in as
            // whoever they were — "do not sign out, do not switch, do not link".
            currentPlayerId: request.player?.id ?? null,
          },
        );

        if (!outcome.ok) {
          request.log.info({ provider: name, failure: outcome.failure.code }, 'sign-in refused');
          return fail(signInFailureCode(outcome.failure));
        }

        const { playerId } = outcome.value;

        const ttlHours = (await isAdmin(db.db, playerId))
          ? env.adminSessionTtlHours
          : env.sessionTtlHours;
        const { token, expiresAt } = await replaceSession(
          db.db,
          request.cookies[SESSION_COOKIE],
          playerId,
          ttlHours,
        );

        void reply.clearCookie(OAUTH_COOKIE, { path: '/' });
        void reply.setCookie(SESSION_COOKIE, token, {
          ...sessionCookieOptions,
          expires: expiresAt,
        });

        return reply.redirect('/');
      },
    );
  }

  registerOAuthProvider<GoogleProfile>({
    name: 'google',
    label: 'Google',
    enabled: () => env.googleEnabled,
    clientId: () => env.googleClientId,
    clientSecret: () => env.googleClientSecret,
    buildAuthorizeUrl: buildGoogleAuthorizeUrl,
    redirectUriFor: googleRedirectUriFor,
    operations: googleAuth ?? {
      exchangeCode: googleExchangeCode,
      fetchProfile: googleFetchProfile,
    },
    toIdentity: (profile) => ({
      subject: profile.subject,
      email: profile.email,
      displayName: profile.name,
      avatarUrl: profile.picture,
    }),
  });

  registerOAuthProvider<DiscordProfile>({
    name: 'discord',
    label: 'Discord',
    enabled: () => env.discordEnabled,
    clientId: () => env.discordClientId,
    clientSecret: () => env.discordClientSecret,
    buildAuthorizeUrl: buildDiscordAuthorizeUrl,
    redirectUriFor: discordRedirectUriFor,
    operations: discordAuth ?? {
      exchangeCode: discordExchangeCode,
      fetchProfile: discordFetchProfile,
    },
    toIdentity: (profile) => ({
      subject: profile.subject,
      email: profile.email,
      displayName: profile.name,
      avatarUrl: profile.avatarUrl,
    }),
  });

  app.post(
    '/api/auth/logout',
    { schema: { response: { 200: logoutResponseJsonSchema } } },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) {
        // Server-side invalidation, not just a cleared cookie — a copied cookie
        // must stop working too.
        await destroySession(db.db, token);
      }
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(200).send({ signedOut: true });
    },
  );

  app.post(
    '/api/auth/logout-all',
    {
      onRequest: app.requireAuth,
      schema: { response: { 200: revokeSessionsResponseJsonSchema } },
    },
    async (request, reply) => {
      const revokedSessions =
        (await revokePlayerSessions(db.db, request.player!.id, {
          playerId: request.player!.id,
          label: request.player!.displayName,
          requestId: request.id,
        })) ?? 0;
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(200).send({ signedOut: true, revokedSessions });
    },
  );
}
