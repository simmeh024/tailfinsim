import type { AuthenticatedPlayer, MeResponse } from '@tailfin/shared';

/**
 * The auth half of the client's API surface (M0-11).
 *
 * Types come from `@tailfin/shared` as **type-only imports**, so the zod schemas
 * they are inferred from stay out of the browser bundle. The server serialises
 * every response *through* the JSON Schema derived from those same schemas, which
 * strips anything undeclared — so re-validating here would buy shape safety we
 * already have, at the cost of shipping a validator to every player. What it
 * would not catch is a proxy or captive portal answering with HTML instead of
 * JSON, and `isMeResponse` below covers that case without the dependency.
 */

/**
 * Sign-in is a **link, not a fetch**.
 *
 * The endpoint 302s to Google's consent screen, and an XHR cannot follow a
 * redirect to a page the user has to interact with. It has to be a real
 * top-level navigation.
 */
export const SIGN_IN_PATH = '/api/auth/google';

function isPlayer(value: unknown): value is AuthenticatedPlayer {
  if (typeof value !== 'object' || value === null) return false;
  const player = value as Record<string, unknown>;
  return (
    typeof player.id === 'string' &&
    typeof player.displayName === 'string' &&
    (player.avatarUrl === null || typeof player.avatarUrl === 'string') &&
    typeof player.createdAt === 'string'
  );
}

function isMeResponse(value: unknown): value is MeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.registrationOpen !== 'boolean') return false;
  return body.player === null || isPlayer(body.player);
}

/**
 * Who am I?
 *
 * Answers 200 with `player: null` when nobody is signed in — never 401 — so a
 * non-ok status here means something is genuinely wrong with the server rather
 * than that the caller is anonymous.
 */
export async function fetchMe(): Promise<MeResponse> {
  const response = await fetch('/api/me', {
    headers: { accept: 'application/json' },
    // Same-origin API (ADR-0003), but stated rather than assumed: the session
    // cookie has to travel with this request.
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error(`GET /api/me failed with ${String(response.status)}`);
  }

  const body: unknown = await response.json();
  if (!isMeResponse(body)) {
    throw new Error('GET /api/me returned an unexpected body');
  }
  return body;
}

/**
 * Ends the session server-side, not just in the browser.
 *
 * No CSRF token, deliberately: the session cookie is `SameSite=Lax`, which is
 * not sent on a cross-site POST at all, so a forged form cannot reach this route
 * with a session attached. Worth revisiting the moment any state-changing route
 * needs to accept cross-site requests.
 */
export async function postSignOut(): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error(`POST /api/auth/logout failed with ${String(response.status)}`);
  }
}
