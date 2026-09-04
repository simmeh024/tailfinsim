import { createHash } from 'node:crypto';

import { inArray } from 'drizzle-orm';
import { type FastifyInstance, type InjectOptions } from 'fastify';

import { BOOTSTRAP_ACTOR, grantAdmin } from '../admin/grants';
import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { type DatabaseHandle } from '../db/client';
import { adminGrant, player, session } from '../db/schema';
import { type ServerEnv } from '../env';

export const AUTHORIZATION_ACTORS = ['guest', 'playerA', 'playerB', 'admin'] as const;

export type AuthorizationActor = (typeof AUTHORIZATION_ACTORS)[number];

export interface AuthorizationIdentity {
  actor: AuthorizationActor;
  playerId: string | null;
  displayName: string;
  /** Complete Cookie header value, or undefined for the guest. */
  cookie: string | undefined;
}

export type AuthorizationIdentities = Record<AuthorizationActor, AuthorizationIdentity>;
export type AuthorizationExpectations = Record<AuthorizationActor, number>;

export type AuthorizationMatrixCase = { request: InjectOptions } & AuthorizationExpectations;

export interface AuthorizationTestSuite {
  app: FastifyInstance;
  identities: AuthorizationIdentities;
  /** Exercises the same request as every canonical actor and checks every status. */
  expectAuthorization(testCase: AuthorizationMatrixCase): Promise<void>;
  /** Idempotent, identity-scoped cleanup for this suite only. */
  cleanup(): Promise<void>;
}

export interface AuthorizationTestSuiteOptions {
  db: DatabaseHandle;
  env: ServerEnv;
  /** Stable and unique within the test file; it is the deterministic fixture namespace. */
  suite: string;
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  // UUID v4 layout, with deterministic entropy. Keeping the standard variant
  // makes these valid for Postgres' uuid type while preserving stable fixtures.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function playerIdentity(suite: string, actor: 'playerA' | 'playerB' | 'admin') {
  return {
    actor,
    id: deterministicUuid(`tailfin:authorization:v1:${suite}:${actor}`),
    displayName: `Authorization ${suite} ${actor}`,
  };
}

function requestLabel(request: InjectOptions): string {
  const method = request.method?.toUpperCase() ?? 'GET';
  const url =
    typeof request.url === 'string' ? request.url : (request.url?.pathname ?? '<unknown request>');
  return `${method} ${url}`;
}

function responseExcerpt(body: string): string {
  const compact = body.replaceAll(/\s+/g, ' ').trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 297)}...`;
}

/** Whether a status means the request was carried out. */
function allowed(status: number): boolean {
  return status >= 200 && status < 400;
}

/**
 * What a mismatch *means*, in the only two directions that matter (SEC-12).
 *
 * `expected 403, received 200` is a puzzle. Saying which way the boundary moved
 * is an incident report — and the two directions are not equally urgent: one is
 * a feature that stopped working, the other is a door that stopped being locked.
 */
export function classifyAuthorizationMismatch(
  expected: number,
  received: number,
): { severity: 'breach' | 'regression' | 'mismatch'; meaning: string } {
  if (!allowed(expected) && allowed(received)) {
    return { severity: 'breach', meaning: 'access GRANTED where it must be refused' };
  }
  if (allowed(expected) && !allowed(received)) {
    return { severity: 'regression', meaning: 'access refused where it must be allowed' };
  }
  return { severity: 'mismatch', meaning: 'unexpected status' };
}

/**
 * One failure line, written to be actionable without opening the test file.
 *
 * `playerA · PATCH /api/airlines/… · expected 403 · received 200 · access
 * GRANTED where it must be refused`.
 */
export function authorizationFailureLine(
  actor: string,
  label: string,
  expected: number,
  received: number,
  body: string,
): string {
  const { severity, meaning } = classifyAuthorizationMismatch(expected, received);
  const prefix = severity === 'breach' ? 'AUTHORIZATION BREACH' : `authorization ${severity}`;
  const excerpt = responseExcerpt(body);
  return (
    `${prefix} · ${actor} · ${label} · expected ${String(expected)} · ` +
    `received ${String(received)} · ${meaning}` +
    (excerpt === '' ? '' : `\n    response: ${excerpt}`)
  );
}

function requestFor(identity: AuthorizationIdentity, request: InjectOptions): InjectOptions {
  const cookieFreeRequest = { ...request };
  delete cookieFreeRequest.cookies;
  const headers = {
    ...(request.headers as Record<string, string | string[] | undefined> | undefined),
  };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'cookie') delete headers[name];
  }
  if (identity.cookie !== undefined) headers.cookie = identity.cookie;
  return { ...cookieFreeRequest, headers };
}

async function removeOwnedPlayers(db: DatabaseHandle, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return db.db.transaction(async (tx) => {
    await tx.delete(session).where(inArray(session.playerId, ids));
    await tx.delete(adminGrant).where(inArray(adminGrant.playerId, ids));
    const removed = await tx
      .delete(player)
      .where(inArray(player.id, ids))
      .returning({ id: player.id });
    return removed.length;
  });
}

/**
 * Canonical HTTP authorization fixtures for server integration tests (SEC-02).
 *
 * Every suite gets one guest, two ordinary players, and one administrator. IDs
 * derive from the caller's stable suite name, while session tokens remain real
 * opaque credentials issued by production code. Cleanup is limited to exact IDs
 * owned by this instance; a missing deletion is reported instead of hidden.
 */
export async function createAuthorizationTestSuite({
  db,
  env,
  suite,
}: AuthorizationTestSuiteOptions): Promise<AuthorizationTestSuite> {
  const namespace = suite.trim();
  if (namespace === '') throw new Error('An authorization fixture suite name cannot be empty');

  const definitions = [
    playerIdentity(namespace, 'playerA'),
    playerIdentity(namespace, 'playerB'),
    playerIdentity(namespace, 'admin'),
  ] as const;
  let ownedIds: string[] = [];

  try {
    const inserted = await db.db
      .insert(player)
      .values(definitions.map(({ id, displayName }) => ({ id, displayName })))
      .returning({ id: player.id });
    ownedIds = inserted.map(({ id }) => id);
    if (ownedIds.length !== definitions.length) {
      throw new Error(
        `Authorization fixture ${namespace} inserted ${ownedIds.length} of ${definitions.length} players`,
      );
    }

    const adminDefinition = definitions[2];
    await grantAdmin(db.db, adminDefinition.id, BOOTSTRAP_ACTOR);

    const playerASession = await createSession(db.db, definitions[0].id, env.sessionTtlHours);
    const playerBSession = await createSession(db.db, definitions[1].id, env.sessionTtlHours);
    // Granting rotates sessions, so the privileged credential must be minted last.
    const adminSession = await createSession(db.db, adminDefinition.id, env.adminSessionTtlHours);

    const identities: AuthorizationIdentities = {
      guest: {
        actor: 'guest',
        playerId: null,
        displayName: 'Guest',
        cookie: undefined,
      },
      playerA: {
        actor: 'playerA',
        playerId: definitions[0].id,
        displayName: definitions[0].displayName,
        cookie: `${SESSION_COOKIE}=${playerASession.token}`,
      },
      playerB: {
        actor: 'playerB',
        playerId: definitions[1].id,
        displayName: definitions[1].displayName,
        cookie: `${SESSION_COOKIE}=${playerBSession.token}`,
      },
      admin: {
        actor: 'admin',
        playerId: adminDefinition.id,
        displayName: adminDefinition.displayName,
        cookie: `${SESSION_COOKIE}=${adminSession.token}`,
      },
    };

    const app = await buildApp({ env, db });
    let appClosed = false;
    let cleaned = false;

    return {
      app,
      identities,
      async expectAuthorization(testCase) {
        const { request } = testCase;
        const failures: string[] = [];

        let breaches = 0;
        for (const actor of AUTHORIZATION_ACTORS) {
          const response = await app.inject(requestFor(identities[actor], request));
          const wanted = testCase[actor];
          if (response.statusCode !== wanted) {
            if (classifyAuthorizationMismatch(wanted, response.statusCode).severity === 'breach') {
              breaches += 1;
            }
            failures.push(
              authorizationFailureLine(
                actor,
                requestLabel(request),
                wanted,
                response.statusCode,
                response.body,
              ),
            );
          }
        }

        if (failures.length > 0) {
          // A breach is led with, not buried: in a run of hundreds of tests this
          // line is what has to be unmistakable (SEC-12).
          const headline =
            breaches > 0
              ? `${String(breaches)} AUTHORIZATION BREACH${breaches === 1 ? '' : 'ES'} on ${requestLabel(request)}`
              : `authorization mismatch on ${requestLabel(request)}`;
          throw new Error([headline, ...failures].join('\n  '));
        }
      },
      async cleanup() {
        if (cleaned) return;
        if (!appClosed) {
          await app.close();
          appClosed = true;
        }
        const expected = ownedIds.length;
        const removed = await removeOwnedPlayers(db, ownedIds);
        if (removed !== expected) {
          throw new Error(
            `Authorization fixture ${namespace} cleaned ${removed} of ${expected} owned players; a resource may have leaked`,
          );
        }
        ownedIds = [];
        cleaned = true;
      },
    };
  } catch (error) {
    await removeOwnedPlayers(db, ownedIds);
    throw error;
  }
}
