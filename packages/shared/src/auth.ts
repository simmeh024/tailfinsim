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
 * A way in that this instance actually has credentials for (AUTH-08).
 *
 * Deliberately not the whole `auth_provider` enum: that enum says what the
 * *schema* can store, and this says what a player can click today. An instance
 * with no Discord credentials must not render a Discord button that 503s.
 */
export const SignInProvider = z.enum(['google', 'discord', 'twitch']);
export type SignInProvider = z.infer<typeof SignInProvider>;

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
  /**
   * A sign-in arrived for an account that is not the one already signed in, and
   * the identity belongs to nobody yet.
   *
   * Separate from `identity_already_linked` because the advice differs: there is
   * no other account to be told about, and what happened is that a *new* one
   * would have been created and switched to. AUTH-04 originally allowed that on
   * the grounds that refusing it would stop anyone making a second account
   * without signing out. The first real use of Discord sign-in hit it and read
   * as "my airline is gone", which is a far worse outcome than the inconvenience
   * that reasoning was protecting.
   */
  'already_signed_in',
  /**
   * A *link* callback came back with no session behind it (AUTH-09).
   *
   * Connecting a provider is an act by an account, so the session is not
   * incidental to it — it is the whole authority for the operation. If it went
   * away between the redirect out and the callback back, the honest answer is
   * to refuse and say so. Quietly falling back to signing in would hand the
   * player a *different* account than the one they were connecting to, which is
   * the shape of the mistake AUTH-04 exists to prevent.
   */
  'link_requires_session',
]);
export type AuthFailureCode = z.infer<typeof AuthFailureCode>;

/**
 * What each failure says to a person (LANDING-04).
 *
 * Here rather than in the client because there are now **two** surfaces that
 * have to explain a refused sign-in, and they cannot share a component. The
 * React login wall renders it from `useAuthError`; the public landing page is a
 * static document with no JavaScript in its funnel, so the *server* writes the
 * message into the HTML before sending it. Two copies of this table would drift,
 * and the drift would be invisible — each surface looks right on its own.
 *
 * Typed as a total map, so adding a code above without a message here is a
 * compile error rather than a player seeing a raw slug.
 */
export const AUTH_FAILURE_MESSAGES: Record<AuthFailureCode, string> = {
  registration_closed: 'Tailfin is not open for new accounts yet.',
  state_mismatch: 'That sign-in attempt expired. Please try again.',
  // Provider-neutral since AUTH-08: the same code arrives from Google and
  // Discord, and the redirect carries no provider, deliberately — naming one
  // would mean trusting a query parameter to say who refused.
  provider_error: 'The sign-in was not completed.',
  exchange_failed: 'Sign-in could not be completed. Please try again.',
  // Specific about the situation, silent about the other account (AUTH-04).
  // "Please try again" would be actively wrong: repeating the attempt produces
  // the same refusal, and the two things that do work are named instead.
  identity_already_linked:
    'That account is already connected to a different Tailfin account. ' +
    'Sign out first, or connect it from your account settings.',
  // Says what did *not* happen, because the fear is that it did: the session is
  // untouched and no second account was created.
  already_signed_in:
    'You are already signed in, and that account is not connected to this one. ' +
    'You are still signed in as before — sign out first to use it as a separate ' +
    'account, or connect it from your account settings.',
  // The link flow's own refusal. Says what to do rather than what broke: the
  // session went away mid-flow, so the connect has to start again from a page
  // they are signed in on.
  link_requires_session:
    'Your session ended before that account could be connected. ' +
    'Nothing was changed — sign in and try connecting it again.',
};

/**
 * A failure code from a query string, as words.
 *
 * Takes `string` rather than `AuthFailureCode` on purpose: the only source of
 * these is `?auth_error=`, which anybody can type. Anything unrecognised falls
 * back to a fixed sentence, so **no caller ever renders text it was handed** —
 * which is what keeps this safe to write straight into a server-rendered
 * document.
 */
export function authFailureMessage(code: string): string {
  return code in AUTH_FAILURE_MESSAGES
    ? AUTH_FAILURE_MESSAGES[code as AuthFailureCode]
    : 'Sign-in failed. Please try again.';
}

/**
 * What the sign-in card says, depending on whether this server will create an
 * account (LANDING-04).
 *
 * `ALLOW_REGISTRATION` is a per-box `.env` value, so the answer differs between
 * dev and production and can change without a deploy. Shipping the open promise
 * against a server that refuses accounts would make the front door's last
 * sentence a lie and the visitor's next experience a refusal.
 *
 * Shared for the same reason as the failure messages: the login wall and the
 * landing page must not disagree about whether this instance is taking new
 * players.
 */
export const REGISTRATION_COPY = {
  open: {
    title: 'Start your airline',
    note: 'Free to play · New accounts are created automatically.',
  },
  closed: {
    title: 'Sign in to Tailfin',
    note: 'Tailfin is not open for new accounts yet — sign-in is limited to existing players.',
  },
} as const;

/**
 * One of a player's ways into their own account (AUTH-09).
 *
 * Shown only to the owner. `email` is here because it is what tells two
 * identities of the same provider apart on the account page — it is still never
 * how an identity is *found* (ADR-0004), and `identity-email.test.ts` holds that
 * line in the server's source rather than in a comment.
 */
export const SignInMethod = z.object({
  id: Uuid,
  provider: SignInProvider,
  email: z.string().nullable(),
  linkedAt: Timestamp,
  /**
   * When it last completed an authentication, or **null for never**.
   *
   * Null is not "at the epoch" and not "unknown": an identity linked and not yet
   * signed in with has honestly never been used, and the account page should be
   * able to say exactly that.
   */
  lastUsedAt: Timestamp.nullable(),
});
export type SignInMethod = z.infer<typeof SignInMethod>;

export const SignInMethodsResponse = z.object({
  methods: z.array(SignInMethod),
  /**
   * Whether removing one would leave the account with no way in.
   *
   * Server-decided rather than inferred from `methods.length`, so the client
   * cannot disagree with the rule the server will actually enforce — and so the
   * definition of a *usable* method (AUTH-03) can change in one place.
   */
  canDisconnect: z.boolean(),
});
export type SignInMethodsResponse = z.infer<typeof SignInMethodsResponse>;

export const DisconnectMethodResponse = z.object({
  disconnected: z.literal(true),
  provider: SignInProvider,
});
export type DisconnectMethodResponse = z.infer<typeof DisconnectMethodResponse>;
