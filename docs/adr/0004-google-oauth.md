# ADR-0004: Google OAuth for player authentication

- **Status:** Accepted
- **Date:** 2026-08-17
- **Deciders:** @simmeh024
- **Implements:** M0-11

## Context

M0-11 requires session-based auth with httpOnly secure cookies and one provider to
start. The design doc assumes players are the general public (§16: "all players compete in
the same market", public airline profiles, leaderboards), so the provider has to be one
that ordinary people already have.

Three candidates were considered:

| Option           | Reach                                              | Setup cost                                                                      |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Google OAuth** | Very wide — most people have an account            | A Google Cloud project, an OAuth client, a consent screen                       |
| GitHub OAuth     | Developers only. Wrong audience for a public game. | Lowest                                                                          |
| Email magic-link | Universal                                          | Needs a sending provider (Resend/Postmark/SES) plus SPF, DKIM and DMARC records |

## Decision

**Google OAuth**, as the single provider for launch.

- Authorization code flow with PKCE, handled server-side.
- The session cookie is the only thing the browser holds: httpOnly, `Secure`,
  `SameSite=Lax`, no token in JavaScript reach. Same-origin (ADR-0003) is what makes
  `SameSite=Lax` sufficient without CORS.
- Sessions live in Postgres, not memory, so they survive a deploy — every deploy restarts
  the process (`deploy.sh`), so in-memory sessions would log everyone out on each release.
- Google's `sub` claim is the stable account key. **Not** the email address: people change
  those, and matching on email is how account-takeover bugs happen.
- Store `sub`, email, display name and avatar URL. Nothing else — we don't need it, and
  GDPR (M13-09) is easier the less there is.

### Registration stays closed until launch

`ALLOW_REGISTRATION` defaults to `false` (added in #130). A Google login for an unknown
`sub` is **rejected** while it is false, rather than silently creating an account. Having a
recognisable "Sign in with Google" button on a pre-launch site would otherwise be an open
door.

## Consequences

### What this makes easier

- No password storage, no reset flow, no credential-stuffing surface, no email
  deliverability work — a large amount of security-sensitive code we simply never write.
- No mail DNS. Email magic-link would have needed SPF/DKIM/DMARC on `tailfinsim.com`
  before anyone could log in.
- Verified email addresses arrive for free, which matters for the alert digests in §14.5.

### What this makes harder

- **Google becomes a hard dependency for logging in.** A Google outage locks every player
  out, and anyone who objects to using a Google account cannot play at all.
- Google requires a privacy policy URL and a consent screen before the client leaves
  testing mode, which pulls part of M13-10 (legal) earlier than planned.
- Adding a second provider later means the account model must already tolerate multiple
  identities per player. Modelled from the start: a `player` row with a separate
  `player_identity` table keyed on `(provider, subject)`, rather than a `google_id` column
  on `player`. One extra table now avoids a migration on live accounts later.

### What we accept

A single point of failure for login, in exchange for not writing authentication.

## Alternatives considered

| Option                       | Why not                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub OAuth                 | Restricts players to people with GitHub accounts. Fine for M0 testing, wrong for a public game.                                                           |
| Email magic-link             | Universal and provider-independent, but needs a mail sender, mail DNS, and deliverability care. Reconsider if Google dependence becomes a real complaint. |
| Passwords                    | Storage, resets, breach exposure, and stuffing defence — all for a worse experience.                                                                      |
| Multiple providers at launch | Reach is not the constraint at launch; shipping is. The `player_identity` table means this stays a small change.                                          |

## Revisit when

- Players ask for a non-Google option, or a region matters where Google sign-in is
  impractical.
- A Google outage causes real downtime, at which point magic-link becomes a second path
  rather than a replacement.

## What still needs doing outside the code

These are account actions, not code, and they block M0-11:

1. A Google Cloud project, OAuth 2.0 **Web application** client.
2. Authorised redirect URIs — production **and** dev, since dev is a separate origin:
   - `https://tailfinsim.com/api/auth/google/callback`
   - `https://dev.tailfinsim.com/api/auth/google/callback`
3. A consent screen with a privacy policy URL — needed before leaving testing mode, and
   testing mode caps you at 100 users.
4. Client ID and secret into each environment's `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`. Separate clients per environment would be cleaner still.
