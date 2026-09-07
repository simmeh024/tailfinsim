import { z } from 'zod';

import { DisplayCurrency } from './currency';
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
  /**
   * The currency this player displays money in (M8-02). Always concrete on the
   * wire — the server resolves a null `player.display_currency` to the default
   * `USD` — so the client never has to know the default. Purely a display
   * choice: every money value elsewhere is still USD minor units.
   */
  displayCurrency: DisplayCurrency,
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
/**
 * A way in that this instance actually has credentials for (AUTH-08).
 *
 * Deliberately not the whole `auth_provider` enum: that enum says what the
 * *schema* can store, and this says what a player can click today. An instance
 * with no Discord credentials must not render a Discord button that 503s.
 */
export const SignInProvider = z.enum(['google', 'discord']);
export type SignInProvider = z.infer<typeof SignInProvider>;

export const MeResponse = z.object({
  player: AuthenticatedPlayer.nullable(),
  /** Whether this instance would let a new account be created (`ALLOW_REGISTRATION`). */
  registrationOpen: z.boolean(),
  /**
   * Which sign-in providers are configured here, in the order to offer them.
   *
   * Server-decided rather than a client constant, because it differs per
   * environment: production runs with no OAuth client of its own, and dev may
   * have one provider before the other. An empty array means sign-in is not
   * configured at all, which is a real state and not an error.
   */
  signInProviders: z.array(SignInProvider),
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
  /**
   * The identity that just authenticated belongs to a different account from
   * the one currently signed in (AUTH-04).
   *
   * Its own code rather than `exchange_failed`, because the two need opposite
   * advice: "try again" is right for a failed exchange and useless here, where
   * nothing is broken and the player has to either sign out first or connect
   * the identity from the account page instead.
   *
   * Deliberately says nothing about the other account. A message naming a
   * display name or email address would confirm to whoever completed that
   * callback that the identity is in use, and by whom.
   */
  'identity_already_linked',
]);
export type AuthFailureCode = z.infer<typeof AuthFailureCode>;
