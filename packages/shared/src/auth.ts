import { z } from 'zod';

import { Timestamp, Uuid } from './primitives';

/**
 * Authentication wire types (M0-11).
 *
 * Google OAuth is the single provider — see ADR-0004 for why, and for what it
 * costs.
 */

/**
 * The signed-in player, as the client is allowed to see it.
 *
 * Deliberately does not include the email address. The client has no use for it
 * — display uses `displayName` — and the less that crosses the wire, the less
 * there is to leak and the easier M13-09's GDPR export becomes.
 */
export const AuthenticatedPlayer = z.object({
  id: Uuid,
  displayName: z.string().min(1),
  avatarUrl: z.url().nullable(),
  createdAt: Timestamp,
});
export type AuthenticatedPlayer = z.infer<typeof AuthenticatedPlayer>;

/**
 * `GET /api/me`.
 *
 * Answers 200 with `{ player: null }` when nobody is signed in, rather than 401.
 * "Who am I?" is a question an anonymous client is entitled to ask and get a
 * straight answer to; reserving 401 for *protected* routes keeps the status code
 * meaningful. A client that treats every 401 as "session expired, reload" would
 * otherwise loop on the landing page.
 */
export const MeResponse = z.object({
  player: AuthenticatedPlayer.nullable(),
  /** Whether this instance would let a new account be created (`ALLOW_REGISTRATION`). */
  registrationOpen: z.boolean(),
  /**
   * Whether this player holds an admin grant (M1A-01).
   *
   * Here so the interface can decide whether to *offer* the admin console. It is
   * not what protects it: `requireAdmin` on the server is, and every admin route
   * carries it. A client that lies to itself about this reaches a console that
   * answers 403 to everything, which is the correct outcome.
   *
   * Always `false` when `player` is null, so there is no state where an
   * anonymous visitor is told anything about admin at all.
   */
  isAdmin: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** `POST /api/auth/logout`. */
export const LogoutResponse = z.object({
  signedOut: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponse>;

/** `POST /api/auth/logout-all` and the admin session-revocation action. */
export const RevokeSessionsResponse = z.object({
  signedOut: z.literal(true),
  revokedSessions: z.number().int().nonnegative(),
});
export type RevokeSessionsResponse = z.infer<typeof RevokeSessionsResponse>;

/**
 * Reasons a sign-in attempt can fail, as stable machine-readable codes.
 *
 * `registration_closed` is the one that matters pre-launch: a valid Google
 * account with no existing player is refused while `ALLOW_REGISTRATION` is false,
 * and the client needs to say something more useful than "login failed".
 */
export const AuthFailureCode = z.enum([
  'registration_closed',
  'state_mismatch',
  'provider_error',
  'exchange_failed',
]);
export type AuthFailureCode = z.infer<typeof AuthFailureCode>;
