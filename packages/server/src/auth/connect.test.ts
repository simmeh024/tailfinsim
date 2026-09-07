import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminAudit, player, playerIdentity } from '../db/schema';
import { makeMultiProviderTestEnv } from '../test-fixtures/env';

import { createSession, SESSION_COOKIE } from './session';

/**
 * Connecting and disconnecting a provider on an account you already hold
 * (AUTH-09), over HTTP.
 *
 * These have to be HTTP tests rather than module tests. The thing AUTH-09
 * actually decides lives in the *route*: that the intent rides in a signed
 * cookie and never in a query parameter, that the callback requires a session
 * and requires it to be the same one that started the flow, and that a refusal
 * leaves the player signed in as whoever they were. None of that is visible
 * from `linkIdentity`, which is why #288 could not close its own version of
 * this criterion.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [auth/connect.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

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

/** The listing endpoint's body, typed once rather than at each call site. */
interface MethodsBody {
  methods: { id: string; provider: string; lastUsedAt: string | null }[];
  canDisconnect: boolean;
}

function methodsBody(payload: string): MethodsBody {
  return JSON.parse(payload) as MethodsBody;
}

let subjectCounter = 0;
function nextSubject(): string {
  subjectCounter += 1;
  return `connect-${String(subjectCounter)}-${String(Date.now())}`;
}

describeDb('connecting a provider to an existing account', () => {
  let db: DatabaseHandle;
  const madePlayers: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    const ids = madePlayers.splice(0);
    // Deliberately does not clean up `admin_audit`: migration 0008 installs
    // triggers that refuse DELETE, and the first draft of this file found out by
    // having its cleanup rejected. That is the guarantee working. The rows are
    // harmless — `actor_player_id` is not a foreign key, precisely so a deleted
    // account cannot rewrite the log — and every assertion below scopes to its
    // own freshly created player.
    if (ids.length > 0) await db.db.delete(player).where(inArray(player.id, ids));
  });

  afterAll(async () => {
    await db.close();
  });

  /** A player with one Google identity and a live session, as a real one has. */
  async function existingPlayer(displayName = 'Connector') {
    const rows = await db.db.insert(player).values({ displayName }).returning({ id: player.id });
    const id = rows[0]!.id;
    madePlayers.push(id);
    await db.db.insert(playerIdentity).values({
      playerId: id,
      provider: 'google',
      subject: nextSubject(),
      email: null,
    });
    const { token } = await createSession(db.db, id, 24);
    return { id, token };
  }

  /** An app whose Discord exchange returns `subject`, with no network involved. */
  async function appReturning(subject: string, overrides: { allowRegistration?: boolean } = {}) {
    const app = await buildApp({
      env: makeMultiProviderTestEnv(overrides),
      db,
      discordAuth: {
        exchangeCode: () => Promise.resolve('provider-access-token'),
        fetchProfile: () =>
          Promise.resolve({
            subject,
            email: 'connect@example.test',
            name: 'Connected Person',
            avatarUrl: null,
          }),
      },
    });
    await app.ready();
    return app;
  }

  /** Walks the connect flow and returns the callback's reply. */
  async function connect(
    app: Awaited<ReturnType<typeof buildApp>>,
    startCookie: string | undefined,
    callbackCookie: string | undefined,
  ) {
    const start = await app.inject({
      method: 'GET',
      url: '/api/auth/discord/connect',
      cookies: startCookie ? { [SESSION_COOKIE]: startCookie } : {},
    });
    if (start.statusCode !== 302) return { start, callback: null };

    const state = new URL(start.headers.location!).searchParams.get('state')!;
    const oauthCookie = cookieValue(setCookie(start.headers, 'tailfin_oauth')!);

    const callback = await app.inject({
      method: 'GET',
      url: `/api/auth/discord/callback?code=ok&state=${encodeURIComponent(state)}`,
      cookies: {
        tailfin_oauth: oauthCookie,
        ...(callbackCookie ? { [SESSION_COOKIE]: callbackCookie } : {}),
      },
    });
    return { start, callback };
  }

  it('refuses to start a connect without a session', async () => {
    const app = await appReturning(nextSubject());
    try {
      const res = await app.inject({ method: 'GET', url: '/api/auth/discord/connect' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('connects Discord to the account already signed in, keeping the same player', async () => {
    const owner = await existingPlayer();
    const subject = nextSubject();
    const app = await appReturning(subject);
    try {
      const { callback } = await connect(app, owner.token, owner.token);

      expect(callback!.statusCode).toBe(302);
      expect(callback!.headers.location).toBe('/settings?linked=discord');

      const identities = await db.db
        .select({ provider: playerIdentity.provider })
        .from(playerIdentity)
        .where(eq(playerIdentity.playerId, owner.id));
      expect(identities.map((i) => i.provider).sort()).toEqual(['discord', 'google']);

      // No new account, and no new session: they were already signed in as the
      // right player, so rotating the cookie would be a change with no reason.
      expect(setCookie(callback!.headers, SESSION_COOKIE)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('records the link in the audit log, with what changed', async () => {
    const owner = await existingPlayer();
    const app = await appReturning(nextSubject());
    try {
      await connect(app, owner.token, owner.token);

      const rows = await db.db
        .select({ action: adminAudit.action, before: adminAudit.before, after: adminAudit.after })
        .from(adminAudit)
        .where(eq(adminAudit.actorPlayerId, owner.id));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('identity.linked');
      // The snapshots are the ways in, before and after — the question an audit
      // log is actually being asked here.
      expect(JSON.parse(rows[0]!.before!)).toEqual({ providers: ['google'] });
      expect(JSON.parse(rows[0]!.after!)).toEqual({ providers: ['google', 'discord'] });
    } finally {
      await app.close();
    }
  });

  it('refuses when the session went away between the redirect and the callback', async () => {
    const owner = await existingPlayer();
    const app = await appReturning(nextSubject());
    try {
      // Started signed in, came back with no session cookie at all.
      const { callback } = await connect(app, owner.token, undefined);

      expect(callback!.statusCode).toBe(302);
      expect(callback!.headers.location).toBe('/settings?link_error=link_requires_session');

      // Refused, not quietly turned into a sign-in — which would have handed
      // them a different account than the one they were connecting to.
      const identities = await db.db
        .select({ id: playerIdentity.id })
        .from(playerIdentity)
        .where(eq(playerIdentity.playerId, owner.id));
      expect(identities).toHaveLength(1);
      expect(setCookie(callback!.headers, SESSION_COOKIE)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('refuses when the session changed to a different player mid-flow', async () => {
    const starter = await existingPlayer('Starter');
    const other = await existingPlayer('Other');
    const app = await appReturning(nextSubject());
    try {
      const { callback } = await connect(app, starter.token, other.token);

      expect(callback!.headers.location).toBe('/settings?link_error=link_requires_session');
      // The identity did not attach to whoever happened to be there at the end.
      for (const id of [starter.id, other.id]) {
        const identities = await db.db
          .select({ id: playerIdentity.id })
          .from(playerIdentity)
          .where(eq(playerIdentity.playerId, id));
        expect(identities).toHaveLength(1);
      }
    } finally {
      await app.close();
    }
  });

  it('ignores an intent supplied as a query parameter', async () => {
    const owner = await existingPlayer();
    const subject = nextSubject();
    // Registration open, so the refusal that arrives is AUTH-04's rather than
    // the pre-launch gate's — which is what makes this test about the *intent*
    // being ignored rather than about registration being closed.
    const app = await appReturning(subject, { allowRegistration: true });
    try {
      // The ordinary *sign-in* start, with `intent=link` bolted onto the query
      // string. The cookie is what decides, so this is a sign-in — and a
      // sign-in for an identity nobody owns, on a live session, is refused
      // (AUTH-04) rather than becoming a link.
      const start = await app.inject({
        method: 'GET',
        url: '/api/auth/discord?intent=link',
        cookies: { [SESSION_COOKIE]: owner.token },
      });
      const state = new URL(start.headers.location!).searchParams.get('state')!;
      const oauthCookie = cookieValue(setCookie(start.headers, 'tailfin_oauth')!);

      const callback = await app.inject({
        method: 'GET',
        url: `/api/auth/discord/callback?code=ok&state=${encodeURIComponent(state)}&intent=link`,
        cookies: { tailfin_oauth: oauthCookie, [SESSION_COOKIE]: owner.token },
      });

      expect(callback.headers.location).toBe('/?auth_error=already_signed_in');
      const identities = await db.db
        .select({ id: playerIdentity.id })
        .from(playerIdentity)
        .where(eq(playerIdentity.playerId, owner.id));
      expect(identities).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('refuses an identity that belongs to another player, disclosing nothing', async () => {
    const owner = await existingPlayer('Owner');
    const rival = await existingPlayer('Rival');
    const subject = nextSubject();
    await db.db
      .insert(playerIdentity)
      .values({ playerId: rival.id, provider: 'discord', subject, email: null });

    const app = await appReturning(subject);
    try {
      const { callback } = await connect(app, owner.token, owner.token);

      expect(callback!.headers.location).toBe('/settings?link_error=identity_already_linked');
      // The location carries a code and nothing else: no display name, no id.
      expect(callback!.headers.location).not.toContain('Rival');

      const moved = await db.db
        .select({ playerId: playerIdentity.playerId })
        .from(playerIdentity)
        .where(eq(playerIdentity.subject, subject));
      expect(moved[0]!.playerId).toBe(rival.id);
    } finally {
      await app.close();
    }
  });

  it('is idempotent when the same connect completes twice', async () => {
    const owner = await existingPlayer();
    const subject = nextSubject();
    const app = await appReturning(subject);
    try {
      await connect(app, owner.token, owner.token);
      await connect(app, owner.token, owner.token);

      const identities = await db.db
        .select({ id: playerIdentity.id })
        .from(playerIdentity)
        .where(eq(playerIdentity.playerId, owner.id));
      expect(identities).toHaveLength(2);

      // And the second one wrote no audit row, because nothing changed.
      const rows = await db.db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actorPlayerId, owner.id));
      expect(rows).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------- disconnect

  describe('disconnecting', () => {
    it('lists the account own methods and removes one', async () => {
      const owner = await existingPlayer();
      const subject = nextSubject();
      const app = await appReturning(subject);
      try {
        await connect(app, owner.token, owner.token);

        const listed = await app.inject({
          method: 'GET',
          url: '/api/me/sign-in-methods',
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        expect(listed.statusCode).toBe(200);
        const body = methodsBody(listed.payload);
        expect(body.canDisconnect).toBe(true);
        expect(body.methods.map((m) => m.provider).sort()).toEqual(['discord', 'google']);
        // Linked, not yet used to sign in.
        expect(body.methods.find((m) => m.provider === 'discord')!.lastUsedAt).toBeNull();

        const target = body.methods.find((m) => m.provider === 'discord')!;
        const removed = await app.inject({
          method: 'DELETE',
          url: `/api/me/sign-in-methods/${target.id}`,
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.json()).toEqual({ disconnected: true, provider: 'discord' });
      } finally {
        await app.close();
      }
    });

    it('refuses to remove the only way into the account', async () => {
      const owner = await existingPlayer();
      const app = await appReturning(nextSubject());
      try {
        const listed = await app.inject({
          method: 'GET',
          url: '/api/me/sign-in-methods',
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        const body = methodsBody(listed.payload);
        expect(body.canDisconnect).toBe(false);

        const refused = await app.inject({
          method: 'DELETE',
          url: `/api/me/sign-in-methods/${body.methods[0]!.id}`,
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        // 409, not 403: the request is permitted and well formed, and what
        // refuses it is the state of the account.
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({ code: 'last_method' });
      } finally {
        await app.close();
      }
    });

    it('conceals another player identity behind the same 404 as an absent one', async () => {
      const owner = await existingPlayer('Owner');
      const rival = await existingPlayer('Rival');
      const theirs = await db.db
        .insert(playerIdentity)
        .values({ playerId: rival.id, provider: 'discord', subject: nextSubject(), email: null })
        .returning({ id: playerIdentity.id });

      const app = await appReturning(nextSubject());
      try {
        const crossOwner = await app.inject({
          method: 'DELETE',
          url: `/api/me/sign-in-methods/${theirs[0]!.id}`,
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        const absent = await app.inject({
          method: 'DELETE',
          url: '/api/me/sign-in-methods/00000000-0000-4000-8000-000000000000',
          cookies: { [SESSION_COOKIE]: owner.token },
        });
        const malformed = await app.inject({
          method: 'DELETE',
          url: '/api/me/sign-in-methods/not-a-uuid',
          cookies: { [SESSION_COOKIE]: owner.token },
        });

        // ADR-0020: identical bodies, so none of them confirms the other exists.
        expect(crossOwner.statusCode).toBe(404);
        expect(crossOwner.json()).toEqual(absent.json());
        expect(crossOwner.json()).toEqual(malformed.json());

        // And the rival still holds both of theirs.
        const rivalMethods = await db.db
          .select({ id: playerIdentity.id })
          .from(playerIdentity)
          .where(eq(playerIdentity.playerId, rival.id));
        expect(rivalMethods).toHaveLength(2);
      } finally {
        await app.close();
      }
    });

    it('refuses to list or remove without a session', async () => {
      const app = await appReturning(nextSubject());
      try {
        const listed = await app.inject({ method: 'GET', url: '/api/me/sign-in-methods' });
        const removed = await app.inject({
          method: 'DELETE',
          url: '/api/me/sign-in-methods/00000000-0000-4000-8000-000000000000',
        });
        expect(listed.statusCode).toBe(401);
        expect(removed.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });
});
