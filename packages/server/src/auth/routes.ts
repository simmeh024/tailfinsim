import {
  disconnectMethodResponseJsonSchema,
  logoutResponseJsonSchema,
  meResponseJsonSchema,
  revokeSessionsResponseJsonSchema,
  signInMethodsResponseJsonSchema,
  type AuthFailureCode,
  type SignInProvider,
} from '@tailfin/shared';

import { writeAudit } from '../admin/audit';
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
import {
  linkIdentity,
  listIdentities,
  signInWithIdentity,
  unlinkIdentity,
  type IdentityFailure,
  type ProvenIdentity,
} from './identity';
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
import {
  buildAuthorizeUrl as buildTwitchAuthorizeUrl,
  exchangeCode as twitchExchangeCode,
  fetchProfile as twitchFetchProfile,
  redirectUriFor as twitchRedirectUriFor,
  type TwitchProfile,
} from './twitch';

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
    case 'already_signed_in':
      // AUTH-04, revised: they are already someone here, and this identity is
      // nobody's. Its own code because there is no other account to mention and
      // the useful advice is different — sign out, or connect it from the
      // account page.
      return 'already_signed_in';
    case 'last_method':
    case 'not_found':
      // Unreachable from sign-in: `signInWithIdentity` neither links nor
      // unlinks, so it cannot produce these. Mapped rather than thrown, because
      // an unexpected refusal should still land the player back on the login
      // page with something to read instead of a 500.
      return 'exchange_failed';
  }
}

/**
 * The same, for a *link* rather than a sign-in (AUTH-09).
 *
 * A separate mapping because the outcomes genuinely differ. `registration_closed`
 * cannot arise — linking creates no account — and `already_signed_in` is the
 * normal precondition here rather than a refusal, so mapping either onto the
 * link flow's vocabulary would be inventing a case that cannot happen.
 */
function linkFailureCode(failure: IdentityFailure): AuthFailureCode {
  switch (failure.code) {
    case 'identity_already_linked':
      return 'identity_already_linked';
    case 'registration_closed':
    case 'already_signed_in':
    case 'last_method':
    case 'not_found':
      // Unreachable from `linkIdentity`, which neither creates accounts nor
      // removes methods. Mapped rather than thrown so an unexpected refusal
      // still returns the player to a page with something to read.
      return 'exchange_failed';
  }
}

/** Holds the OAuth `state`, PKCE verifier and intent between the two legs of the flow. */
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
  twitchAuth?: TwitchAuthOperations;
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
  /**
   * `clientId` is passed to every provider and used by one: Twitch's
   * `helix/users` requires the application's client id alongside the bearer
   * token and refuses a request carrying only the token. Google's and
   * Discord's implementations take one argument and ignore the second, which
   * TypeScript allows and which keeps the seam honest — the interface says a
   * provider *may* need its own identity to read a profile, because one does.
   */
  fetchProfile: (accessToken: string, clientId: string) => Promise<Profile>;
}

export type GoogleAuthOperations = OAuthOperations<GoogleProfile>;
export type DiscordAuthOperations = OAuthOperations<DiscordProfile>;
export type TwitchAuthOperations = OAuthOperations<TwitchProfile>;

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

/**
 * Which providers this instance can actually offer, in the order to offer them.
 *
 * Exported because **two** surfaces need the answer and they must not disagree:
 * `/api/me` tells the React login wall, and `app.ts` renders the same list into
 * the static landing page, whose funnel carries no JavaScript. A landing page
 * showing a button the box has no credentials for sends a visitor to a 503 —
 * which is the failure `LoginPage` already avoids by asking the server.
 *
 * What the schema can *store* is a different and longer list; this is what a
 * player can click today.
 */
export function configuredSignInProviders(env: ServerEnv): SignInProvider[] {
  return [
    ...(env.googleEnabled ? (['google'] as const) : []),
    ...(env.discordEnabled ? (['discord'] as const) : []),
    ...(env.twitchEnabled ? (['twitch'] as const) : []),
  ];
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { env, db, googleAuth, discordAuth, twitchAuth }: AuthRoutesOptions,
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
        signInProviders: configuredSignInProviders(env),
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

    /**
     * Begins a flow, for either intent.
     *
     * The intent rides in the **signed** cookie and never in a query parameter.
     * That is the load-bearing detail of AUTH-09: "turn this sign-in into a link
     * onto my account" is precisely the attack, and a query parameter is
     * attacker-supplied. The player id rides along too, and the callback
     * requires it to match the session it finds — so a session that changes
     * between the redirect out and the callback back cannot silently connect
     * the identity to whoever is there now.
     */
    const begin = (
      request: FastifyRequest,
      reply: FastifyReply,
      intent: 'sign_in' | 'link',
    ): FastifyReply => {
      const clientId = config.clientId();
      if (!config.enabled() || !clientId) return notConfigured(reply);

      const state = createState();
      const { verifier, challenge } = createPkcePair();

      void reply.setCookie(
        OAUTH_COOKIE,
        JSON.stringify({
          provider: name,
          state,
          verifier,
          intent,
          playerId: intent === 'link' ? (request.player?.id ?? null) : null,
        }),
        { ...sessionCookieOptions, signed: true, maxAge: OAUTH_COOKIE_TTL_SECONDS },
      );

      return reply.redirect(
        config.buildAuthorizeUrl({
          clientId,
          redirectUri: config.redirectUriFor(env.publicOrigin),
          state,
          codeChallenge: challenge,
        }),
      );
    };

    /** Connect this provider to the account already signed in (AUTH-09). */
    app.get(`/api/auth/${name}/connect`, { onRequest: app.requireAuth }, async (request, reply) =>
      begin(request, reply, 'link'),
    );

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

        let stored: {
          provider?: unknown;
          state?: unknown;
          verifier?: unknown;
          intent?: unknown;
          playerId?: unknown;
        };
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
          profile = await config.operations.fetchProfile(accessToken, clientId);
        } catch (error) {
          request.log.error({ err: error, provider: name }, 'oauth exchange failed');
          return fail('exchange_failed');
        }

        // ------------------------------------------------------------ linking
        if (stored.intent === 'link') {
          const linkFail = (code: string): FastifyReply => {
            void reply.clearCookie(OAUTH_COOKIE, { path: '/' });
            // Back to the account page rather than the login wall: the player is
            // (or was) signed in, and sending them to a door they are already
            // through would be its own kind of confusing.
            return reply.redirect(`/settings?link_error=${code}`);
          };

          // The session is the entire authority for this operation, so its
          // absence is a refusal and never a fallback to signing in — that would
          // hand them a different account than the one they were connecting to.
          const current = request.player;
          if (!current) return linkFail('link_requires_session');

          // And it must be the *same* session that started the flow.
          if (typeof stored.playerId !== 'string' || stored.playerId !== current.id) {
            return linkFail('link_requires_session');
          }

          // The link and its audit row commit together, which is what
          // `writeAudit` exists to make structural: a record written afterwards
          // is one that can go missing exactly when the change was the one
          // somebody wanted hidden.
          const linked = await db.db.transaction(async (tx) => {
            const before = (await listIdentities(tx, current.id)).map((m) => m.provider);
            const result = await linkIdentity(tx, current.id, {
              provider: name,
              ...config.toIdentity(profile),
            });
            if (!result.ok || result.value.alreadyLinked) return result;

            await writeAudit(tx, {
              actorPlayerId: current.id,
              actorLabel: current.displayName,
              action: 'identity.linked',
              subjectType: 'player',
              subjectId: current.id,
              // How this account could be entered, before and after. More use to
              // whoever reads the log later than the single provider name would
              // be, and it is what makes the before/after genuinely differ.
              before: { providers: before },
              after: { providers: [...before, name] },
              requestId: request.id,
            });
            return result;
          });

          if (!linked.ok) {
            request.log.info(
              { provider: name, failure: linked.failure.code },
              'identity link refused',
            );
            return linkFail(linkFailureCode(linked.failure));
          }

          void reply.clearCookie(OAUTH_COOKIE, { path: '/' });
          // No new session: they are already signed in as the right player, and
          // rotating the cookie here would be a change with no reason behind it.
          return reply.redirect(`/settings?linked=${name}`);
        }

        // ----------------------------------------------------------- signing in
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

  /*
   * Twitch relaxes exactly one thing the other two do, and `twitch.ts` says so
   * at length rather than leaving it to be noticed: its authorization-code grant
   * documents no PKCE, so the challenge and verifier are accepted here for
   * interface parity and not sent. The state binding and the confidential-client
   * exchange are unchanged, and they are what actually hold this flow shut.
   */
  registerOAuthProvider<TwitchProfile>({
    name: 'twitch',
    label: 'Twitch',
    enabled: () => env.twitchEnabled,
    clientId: () => env.twitchClientId,
    clientSecret: () => env.twitchClientSecret,
    buildAuthorizeUrl: buildTwitchAuthorizeUrl,
    redirectUriFor: twitchRedirectUriFor,
    operations: twitchAuth ?? {
      exchangeCode: twitchExchangeCode,
      fetchProfile: twitchFetchProfile,
    },
    toIdentity: (profile) => ({
      subject: profile.subject,
      email: profile.email,
      displayName: profile.name,
      avatarUrl: profile.avatarUrl,
    }),
  });

  // ------------------------------------------------------- sign-in methods

  /**
   * The player's own ways in (AUTH-09).
   *
   * Scoped by the session-resolved player and by nothing the client sent, so
   * there is no id here to tamper with (SEC-07) and no cross-owner case to
   * conceal — the question is only ever "mine".
   */
  app.get(
    '/api/me/sign-in-methods',
    { onRequest: app.requireAuth, schema: { response: { 200: signInMethodsResponseJsonSchema } } },
    async (request, reply) => {
      const playerId = request.player!.id;
      const methods = await listIdentities(db.db, playerId);

      return reply.code(200).send({
        methods: methods.map((method) => ({
          id: method.id,
          provider: method.provider as SignInProvider,
          email: method.email,
          linkedAt: method.createdAt.toISOString(),
          lastUsedAt: method.lastUsedAt?.toISOString() ?? null,
        })),
        // Decided here rather than by the client counting rows, so the answer
        // cannot disagree with the rule `unlinkIdentity` will actually apply.
        canDisconnect: methods.length > 1,
      });
    },
  );

  app.delete<{ Params: { identityId: string } }>(
    '/api/me/sign-in-methods/:identityId',
    {
      onRequest: app.requireAuth,
      schema: { response: { 200: disconnectMethodResponseJsonSchema } },
    },
    async (request, reply) => {
      const player = request.player!;

      // As with linking: the removal and its record commit together.
      const removed = await db.db.transaction(async (tx) => {
        const before = (await listIdentities(tx, player.id)).map((m) => m.provider);
        const result = await unlinkIdentity(tx, player.id, request.params.identityId);
        if (!result.ok) return result;

        await writeAudit(tx, {
          actorPlayerId: player.id,
          actorLabel: player.displayName,
          action: 'identity.unlinked',
          subjectType: 'player',
          subjectId: player.id,
          before: { providers: before },
          after: { providers: (await listIdentities(tx, player.id)).map((m) => m.provider) },
          requestId: request.id,
        });
        return result;
      });

      if (!removed.ok) {
        if (removed.failure.code === 'last_method') {
          // 409 rather than 403: the request is permitted and well-formed, and
          // what refuses it is the state of the account. "Sign in another way
          // first" is advice a 403 cannot carry.
          return reply.code(409).send({
            code: 'last_method',
            message: 'That is the only way into this account. Connect another first.',
          });
        }
        // Malformed, absent and another player's identity are the same answer
        // (ADR-0020) — the resolution is already scoped by owner, so there is
        // nothing here that could disclose one exists.
        return reply
          .code(404)
          .send({ code: 'not_found', message: 'No such sign-in method on this account' });
      }

      return reply
        .code(200)
        .send({ disconnected: true, provider: removed.value.provider as SignInProvider });
    },
  );

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
