import { and, eq } from 'drizzle-orm';

import {
  logoutResponseJsonSchema,
  meResponseJsonSchema,
  revokeSessionsResponseJsonSchema,
} from '@tailfin/shared';

import { type AdminCapability, type AdminRole, roleHasCapability } from '../admin/capabilities';
import { adminRoleOf, isAdmin } from '../admin/grants';
import { type DatabaseHandle } from '../db/client';
import { player, playerIdentity } from '../db/schema';
import { type ServerEnv } from '../env';

import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCode,
  fetchProfile,
  redirectUriFor,
  type GoogleProfile,
} from './google';
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
}

export interface GoogleAuthOperations {
  exchangeCode: typeof exchangeCode;
  fetchProfile: typeof fetchProfile;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { env, db, googleAuth }: AuthRoutesOptions,
): void {
  const secureCookies = env.publicOrigin.startsWith('https://');
  const provider = googleAuth ?? { exchangeCode, fetchProfile };

  const sessionCookieOptions = {
    httpOnly: true,
    // Off over plain HTTP or the cookie is never sent back on localhost.
    secure: secureCookies,
    // Lax, not Strict: the OAuth callback is a cross-site top-level navigation
    // back from Google, and Strict would withhold the cookie on arrival.
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
        // False for anonymous visitors by construction: the flag is only set
        // alongside a resolved session, so there is no state where a stranger is
        // told anything about admin at all.
        isAdmin: request.isAdmin === true,
      }),
  );

  // ------------------------------------------------------------ sign in / out

  app.get('/api/auth/google', async (_request, reply) => {
    if (!env.authEnabled || !env.googleClientId) {
      return reply
        .code(503)
        .send({ code: 'auth_not_configured', message: 'Google sign-in is not configured' });
    }

    const state = createState();
    const { verifier, challenge } = createPkcePair();

    // Signed so a client cannot forge a state/verifier pair of its own.
    void reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
      ...sessionCookieOptions,
      signed: true,
      maxAge: OAUTH_COOKIE_TTL_SECONDS,
    });

    return reply.redirect(
      buildAuthorizeUrl({
        clientId: env.googleClientId,
        redirectUri: redirectUriFor(env.publicOrigin),
        state,
        codeChallenge: challenge,
      }),
    );
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/google/callback',
    async (request, reply) => {
      if (!env.authEnabled || !env.googleClientId || !env.googleClientSecret) {
        return reply
          .code(503)
          .send({ code: 'auth_not_configured', message: 'Google sign-in is not configured' });
      }

      const fail = (code: string): FastifyReply => {
        void reply.clearCookie(OAUTH_COOKIE, { path: '/' });
        // Back to the app with a code the UI can explain, rather than a bare
        // error page. Never includes anything from the provider's response.
        return reply.redirect(`/?auth_error=${code}`);
      };

      if (request.query.error) {
        request.log.warn({ providerError: request.query.error }, 'google returned an error');
        return fail('provider_error');
      }

      const { code, state } = request.query;
      if (!code || !state) return fail('provider_error');

      const raw = request.cookies[OAUTH_COOKIE];
      const unsigned = raw ? reply.unsignCookie(raw) : null;
      if (!unsigned?.valid || !unsigned.value) return fail('state_mismatch');

      let stored: { state?: unknown; verifier?: unknown };
      try {
        stored = JSON.parse(unsigned.value) as { state?: unknown; verifier?: unknown };
      } catch {
        return fail('state_mismatch');
      }

      if (
        typeof stored.state !== 'string' ||
        typeof stored.verifier !== 'string' ||
        !safeEqual(stored.state, state)
      ) {
        return fail('state_mismatch');
      }

      let profile: GoogleProfile;
      try {
        const accessToken = await provider.exchangeCode({
          code,
          clientId: env.googleClientId,
          clientSecret: env.googleClientSecret,
          redirectUri: redirectUriFor(env.publicOrigin),
          codeVerifier: stored.verifier,
        });
        profile = await provider.fetchProfile(accessToken);
      } catch (error) {
        request.log.error({ err: error }, 'google exchange failed');
        return fail('exchange_failed');
      }

      // Match on the provider subject, never the email address (ADR-0004).
      const existing = await db.db
        .select({ playerId: playerIdentity.playerId })
        .from(playerIdentity)
        .where(
          and(eq(playerIdentity.provider, 'google'), eq(playerIdentity.subject, profile.subject)),
        )
        .limit(1);

      let playerId = existing[0]?.playerId;

      if (!playerId) {
        if (!env.allowRegistration) {
          // The pre-launch gate. A valid Google account is still refused.
          request.log.info('sign-in refused: registration closed');
          return fail('registration_closed');
        }

        const created = await db.db
          .insert(player)
          .values({
            displayName: profile.name ?? 'New player',
            avatarUrl: profile.picture,
          })
          .returning({ id: player.id });

        playerId = created[0]?.id;
        if (!playerId) return fail('exchange_failed');

        await db.db.insert(playerIdentity).values({
          playerId,
          provider: 'google',
          subject: profile.subject,
          email: profile.email,
        });
      }

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
      void reply.setCookie(SESSION_COOKIE, token, { ...sessionCookieOptions, expires: expiresAt });

      return reply.redirect('/');
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
