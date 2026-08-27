import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminAudit, adminGrant, player, playerIdentity, session } from '../db/schema';
import { type ServerEnv } from '../env';

import {
  createSession,
  destroyPlayerSessions,
  destroySession,
  findSessionPlayer,
  SESSION_COOKIE,
} from './session';

/**
 * The session round trip, against a real Postgres and a real Fastify instance.
 *
 * These are the tests that can actually fail. The interesting ones are:
 *
 *   - **A cookie authenticates a request.** `@fastify/cookie` parses cookies in
 *     an `onRequest` hook, and hooks run in the order `addHook` was *called* — so
 *     registering the auth hook without waiting for the plugin to load leaves
 *     `request.cookies` empty and every session silently anonymous. This suite
 *     fails if `routes.ts` stops deferring with `after()`.
 *   - **The token is not in the database.** Only its hash is.
 *   - **Logout invalidates server-side**, so a copied cookie stops working.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;

if (!url) {
  console.warn('\n  [session-cookie.test] DATABASE_URL not set — skipping session tests.\n');
}

const describeDb = url ? describe : describe.skip;

const baseEnv: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 2,
  databaseConnectTimeoutMs: 5000,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  // http, not https, so the cookies are not `Secure` and travel under inject().
  publicOrigin: 'http://localhost:3000',
  googleClientId: 'test-client-id.apps.googleusercontent.com',
  googleClientSecret: 'test-client-secret',
  sessionSecret: 'a'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

/** Auth switched off, as production runs until its OAuth client exists. */
const unconfiguredEnv: ServerEnv = {
  ...baseEnv,
  googleClientId: undefined,
  googleClientSecret: undefined,
  sessionSecret: undefined,
  authEnabled: false,
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Reads one Set-Cookie value by name from an inject() reply. */
function setCookie(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers['set-cookie'];
  const all: string[] = Array.isArray(raw)
    ? (raw as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];
  return all.find((entry) => entry.startsWith(`${name}=`));
}

function cookieValue(value: string): string {
  const end = value.indexOf(';');
  return decodeURIComponent(value.slice(value.indexOf('=') + 1, end === -1 ? undefined : end));
}

describeDb('sessions over HTTP', () => {
  let db: DatabaseHandle;
  let app: ReturnType<typeof buildApp>;
  let playerId: string;

  beforeAll(async () => {
    db = createDatabase();
    app = buildApp({ env: baseEnv, db });
    await app.ready();

    const created = await db.db
      .insert(player)
      .values({ displayName: 'Session Test Pilot', avatarUrl: 'https://example.test/a.png' })
      .returning({ id: player.id });
    playerId = created[0]!.id;
  });

  afterAll(async () => {
    // Sessions cascade with the player.
    await db.db.delete(player).where(eq(player.id, playerId));
    await app.close();
    await db.close();
  });

  describe('GET /api/me', () => {
    it('answers 200 with a null player when nobody is signed in', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/me' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ player: null, registrationOpen: false, isAdmin: false });
    });

    it('identifies the player behind a valid session cookie', async () => {
      // The load-bearing test: if the cookie plugin has not parsed cookies by the
      // time the auth hook runs, this comes back anonymous.
      const { token } = await createSession(db.db, playerId, 24);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE]: token },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ player: { id: string; displayName: string } | null }>();
      expect(body.player).not.toBeNull();
      expect(body.player?.id).toBe(playerId);
      expect(body.player?.displayName).toBe('Session Test Pilot');
    });

    it('never returns the email address', async () => {
      const { token } = await createSession(db.db, playerId, 24);
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE]: token },
      });
      const body = res.json<{ player: Record<string, unknown> }>();
      expect(Object.keys(body.player).sort()).toEqual([
        'avatarUrl',
        'createdAt',
        'displayName',
        'id',
      ]);
    });

    it('treats an unknown token as anonymous rather than erroring', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE]: 'not-a-real-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ player: null });
    });

    it('reports registration as open when the flag says so', async () => {
      const openApp = buildApp({ env: { ...baseEnv, allowRegistration: true }, db });
      await openApp.ready();
      try {
        const res = await openApp.inject({ method: 'GET', url: '/api/me' });
        expect(res.json()).toMatchObject({ registrationOpen: true });
      } finally {
        await openApp.close();
      }
    });
  });

  describe('token storage', () => {
    it('stores the hash and not the token', async () => {
      const { token } = await createSession(db.db, playerId, 24);

      const byToken = await db.db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.tokenHash, token));
      expect(byToken).toHaveLength(0);

      const byHash = await db.db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.tokenHash, sha256Hex(token)));
      expect(byHash).toHaveLength(1);
    });
  });

  describe('expiry', () => {
    it('refuses a session whose expiry has passed', async () => {
      const token = 'expired-token-fixture';
      const now = Date.now();
      await db.db.insert(session).values({
        playerId,
        tokenHash: sha256Hex(token),
        // Explicit created_at: the CHECK requires expires_at > created_at, so an
        // already-expired row has to be backdated rather than given a past expiry.
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
        expiresAt: new Date(now - 60 * 60 * 1000),
      });

      expect(await findSessionPlayer(db.db, token)).toBeNull();

      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(res.json()).toMatchObject({ player: null });
    });
  });

  describe('POST /api/auth/logout', () => {
    it('invalidates the session server-side, so a copied cookie stops working', async () => {
      const { token } = await createSession(db.db, playerId, 24);

      const before = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(before.json()).toMatchObject({ player: { id: playerId } });

      const out = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(out.statusCode).toBe(200);
      expect(out.json()).toEqual({ signedOut: true });

      // Replaying the same cookie must fail even though the client kept it.
      const after = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { [SESSION_COOKIE]: token },
      });
      expect(after.json()).toMatchObject({ player: null });
    });

    it('succeeds when there was no session to end', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/auth/logout-all', () => {
    it('revokes every device immediately and records no session secret', async () => {
      await destroyPlayerSessions(db.db, playerId);
      const first = await createSession(db.db, playerId, 24);
      const second = await createSession(db.db, playerId, 24);

      const out = await app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        cookies: { [SESSION_COOKIE]: first.token },
      });
      expect(out.statusCode).toBe(200);
      expect(out.json()).toEqual({ signedOut: true, revokedSessions: 2 });
      expect(await findSessionPlayer(db.db, first.token)).toBeNull();
      expect(await findSessionPlayer(db.db, second.token)).toBeNull();

      const audits = await db.db
        .select({ action: adminAudit.action, after: adminAudit.after })
        .from(adminAudit)
        .where(eq(adminAudit.subjectId, playerId));
      const audit = audits.find((entry) => entry.action === 'sessions.revoked');
      expect(audit?.after).toBe(
        JSON.stringify({ activeSessions: 0, result: 'success', revokedSessions: 2 }),
      );
      expect(audit?.after).not.toContain(first.token);
      expect(audit?.after).not.toContain(second.token);
    });

    it('requires a live session', async () => {
      const out = await app.inject({ method: 'POST', url: '/api/auth/logout-all' });
      expect(out.statusCode).toBe(401);
    });
  });

  describe('destroySession', () => {
    it('is idempotent', async () => {
      const { token } = await createSession(db.db, playerId, 24);
      await destroySession(db.db, token);
      await expect(destroySession(db.db, token)).resolves.toBeUndefined();
    });
  });

  describe('GET /api/auth/google', () => {
    it('redirects to Google with the configured client and PKCE challenge', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/google' });
      expect(res.statusCode).toBe(302);

      const location = new URL(res.headers.location!);
      expect(location.origin).toBe('https://accounts.google.com');
      expect(location.searchParams.get('client_id')).toBe(baseEnv.googleClientId);
      expect(location.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/auth/google/callback',
      );
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('stores the state in an httpOnly cookie and never in the response body', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/google' });
      const cookie = setCookie(res.headers, 'tailfin_oauth');

      expect(cookie).toBeDefined();
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(res.body).not.toContain('verifier');
    });

    it('does not mark the cookie Secure when the origin is plain http', async () => {
      // Otherwise the cookie is dropped on localhost and sign-in cannot be
      // exercised in development at all.
      const res = await app.inject({ method: 'GET', url: '/api/auth/google' });
      const cookie = setCookie(res.headers, 'tailfin_oauth');
      expect(cookie).not.toContain('Secure');
    });

    it('marks the cookie Secure when the origin is https', async () => {
      const secureApp = buildApp({
        env: { ...baseEnv, publicOrigin: 'https://dev.tailfinsim.com' },
        db,
      });
      await secureApp.ready();
      try {
        const res = await secureApp.inject({ method: 'GET', url: '/api/auth/google' });
        const cookie = setCookie(res.headers, 'tailfin_oauth');
        expect(cookie).toContain('Secure');
      } finally {
        await secureApp.close();
      }
    });
  });

  describe('GET /api/auth/google/callback', () => {
    it('refuses a callback with no state cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google/callback?code=abc&state=xyz',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/?auth_error=state_mismatch');
    });

    it('refuses a state that does not match the cookie', async () => {
      const start = await app.inject({ method: 'GET', url: '/api/auth/google' });
      const cookie = setCookie(start.headers, 'tailfin_oauth')!;
      const value = cookie.slice('tailfin_oauth='.length, cookie.indexOf(';'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google/callback?code=abc&state=not-the-stored-state',
        cookies: { tailfin_oauth: decodeURIComponent(value) },
      });
      expect(res.headers.location).toBe('/?auth_error=state_mismatch');
    });

    it('reports a provider error without echoing what Google said', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google/callback?error=access_denied',
      });
      expect(res.headers.location).toBe('/?auth_error=provider_error');
    });

    it('refuses a callback carrying no code', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/google/callback?state=xyz' });
      expect(res.headers.location).toBe('/?auth_error=provider_error');
    });

    it('atomically replaces a pre-login session instead of preserving its id', async () => {
      const subject = `session-fixation-${Math.random().toString(36).slice(2)}`;
      await db.db.insert(playerIdentity).values({
        playerId,
        provider: 'google',
        subject,
        email: 'session-test@example.test',
      });
      await destroyPlayerSessions(db.db, playerId);
      const old = await createSession(db.db, playerId, 24);

      const callbackApp = buildApp({
        env: baseEnv,
        db,
        googleAuth: {
          exchangeCode: () => Promise.resolve('provider-access-token'),
          fetchProfile: () =>
            Promise.resolve({
              subject,
              email: 'session-test@example.test',
              name: 'Session Test Pilot',
              picture: null,
            }),
        },
      });
      await callbackApp.ready();
      try {
        const start = await callbackApp.inject({ method: 'GET', url: '/api/auth/google' });
        const state = new URL(start.headers.location!).searchParams.get('state')!;
        const oauthCookie = cookieValue(setCookie(start.headers, 'tailfin_oauth')!);
        const signedIn = await callbackApp.inject({
          method: 'GET',
          url: `/api/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`,
          cookies: { tailfin_oauth: oauthCookie, [SESSION_COOKIE]: old.token },
        });

        expect(signedIn.statusCode).toBe(302);
        expect(signedIn.headers.location).toBe('/');
        const fresh = cookieValue(setCookie(signedIn.headers, SESSION_COOKIE)!);
        expect(fresh).not.toBe(old.token);
        expect(await findSessionPlayer(db.db, old.token)).toBeNull();
        expect((await findSessionPlayer(db.db, fresh))?.id).toBe(playerId);

        const stored = await db.db
          .select({ expiresAt: session.expiresAt })
          .from(session)
          .where(eq(session.tokenHash, sha256Hex(fresh)))
          .limit(1);
        const remainingHours = (stored[0]!.expiresAt.getTime() - Date.now()) / 3_600_000;
        expect(remainingHours).toBeGreaterThan(23.9);
        expect(remainingHours).toBeLessThanOrEqual(24);
      } finally {
        await callbackApp.close();
      }
    });

    it('issues the shorter configured lifetime to an admin', async () => {
      const created = await db.db
        .insert(player)
        .values({ displayName: 'Short Session Admin' })
        .returning({ id: player.id });
      const adminId = created[0]!.id;
      const subject = `admin-ttl-${Math.random().toString(36).slice(2)}`;
      await db.db.insert(playerIdentity).values({ playerId: adminId, provider: 'google', subject });
      await db.db.insert(adminGrant).values({ playerId: adminId });

      const callbackApp = buildApp({
        env: { ...baseEnv, adminSessionTtlHours: 2 },
        db,
        googleAuth: {
          exchangeCode: () => Promise.resolve('provider-access-token'),
          fetchProfile: () =>
            Promise.resolve({
              subject,
              email: null,
              name: 'Short Session Admin',
              picture: null,
            }),
        },
      });
      await callbackApp.ready();
      try {
        const start = await callbackApp.inject({ method: 'GET', url: '/api/auth/google' });
        const state = new URL(start.headers.location!).searchParams.get('state')!;
        const oauthCookie = cookieValue(setCookie(start.headers, 'tailfin_oauth')!);
        const signedIn = await callbackApp.inject({
          method: 'GET',
          url: `/api/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`,
          cookies: { tailfin_oauth: oauthCookie },
        });
        const token = cookieValue(setCookie(signedIn.headers, SESSION_COOKIE)!);
        const stored = await db.db
          .select({ expiresAt: session.expiresAt })
          .from(session)
          .where(eq(session.tokenHash, sha256Hex(token)))
          .limit(1);
        const remainingHours = (stored[0]!.expiresAt.getTime() - Date.now()) / 3_600_000;
        expect(remainingHours).toBeGreaterThan(1.9);
        expect(remainingHours).toBeLessThanOrEqual(2);
      } finally {
        await callbackApp.close();
        await db.db.delete(adminGrant).where(eq(adminGrant.playerId, adminId));
        await db.db.delete(player).where(eq(player.id, adminId));
      }
    });
  });
});

describeDb('with auth not configured', () => {
  let db: DatabaseHandle;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = createDatabase();
    app = buildApp({ env: unconfiguredEnv, db });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('still answers /api/me, so the client is not left guessing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ player: null, registrationOpen: false, isAdmin: false });
  });

  it('returns 503 from the sign-in route rather than 404', async () => {
    // 404 would read as "this feature does not exist"; 503 says "not configured
    // here", which is the truth on production until its client is created.
    const res = await app.inject({ method: 'GET', url: '/api/auth/google' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'auth_not_configured' });
  });

  it('returns 503 from the callback too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=a&state=b',
    });
    expect(res.statusCode).toBe(503);
  });

  it('ignores a session cookie entirely', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [SESSION_COOKIE]: 'anything' },
    });
    expect(res.json()).toMatchObject({ player: null });
  });
});
