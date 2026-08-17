import { and, eq } from 'drizzle-orm';

import { logoutResponseJsonSchema, meResponseJsonSchema } from '@tailfin/shared';

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
import {
  createSession,
  destroySession,
  findSessionPlayer,
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
  }
  interface FastifyInstance {
    /** Rejects with 401 unless a valid session is present. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthRoutesOptions {
  env: ServerEnv;
  db: DatabaseHandle;
}

export function registerAuthRoutes(app: FastifyInstance, { env, db }: AuthRoutesOptions): void {
  const secureCookies = env.publicOrigin.startsWith('https://');

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
      if (found) request.player = found;
    });
  });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.player) {
      await reply.code(401).send({ code: 'unauthorized', message: 'Sign in required' });
    }
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
            }
          : null,
        registrationOpen: env.allowRegistration,
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
        const accessToken = await exchangeCode({
          code,
          clientId: env.googleClientId,
          clientSecret: env.googleClientSecret,
          redirectUri: redirectUriFor(env.publicOrigin),
          codeVerifier: stored.verifier,
        });
        profile = await fetchProfile(accessToken);
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

      const { token, expiresAt } = await createSession(db.db, playerId, env.sessionTtlHours);

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
}
