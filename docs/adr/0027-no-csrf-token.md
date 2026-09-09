# ADR-0027: No CSRF token, and the four facts that replace it

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** @simmeh024
- **Constrains:** every cookie attribute, every state-changing route's HTTP method, any future CORS
  configuration, and any proposal to serve the API from a second origin
- **Renumbered:** filed as ADR-0025, which
  [ADR-0025 (Airport slots)](0025-airport-slots.md) already held — accepted 2026-09-04, a day
  earlier. Two accepted ADRs shared a number, and `CLAUDE.md` cited "ADR-0025" for both, meaning
  different things in each place. This one moved because it collided, and because the slot ADR is
  cited inside `drizzle/0048_perpetual_tag.sql`: drizzle sha256-hashes a migration's **whole file
  content**, so editing even a comment there would make the migrator treat an applied migration as
  new and try to `CREATE TABLE "slot_holding"` again. Nothing outside this repository referenced
  0025-as-CSRF, so no external link breaks.

## Context

Tailfin authenticates with a cookie. That is the precondition for cross-site request forgery: a
third-party page can cause a signed-in player's browser to issue an authenticated
state-changing request, and if nothing distinguishes a request the player meant from one another
site provoked, the attacker acts as the player.

The stake is not theoretical. `POST /api/admin/worlds/:worldId/reset` destroys every airline in a
world and rewinds its clock, and ADR-0005 is explicit that there is no undo. It is the worst
outcome reachable through the HTTP surface. "Probably fine" is not the standard for it.

The architecture already prevents the attack — but nothing said so, and nothing tested it. That
is the actual problem this ADR solves. A protection nobody has written down is a protection
somebody removes in a refactor, in good faith, on a Tuesday, and the removal looks like a
tidy-up in the diff.

## Decision

**Do not add a CSRF token or CSRF middleware.** Instead, treat four existing properties as the
control, state that they are load-bearing **together**, and test each one.

### The four facts

**1. Session cookies are `SameSite=Lax`.** `auth/routes.ts` sets `sameSite: 'lax'` alongside
`httpOnly` and `secure` (the latter whenever `PUBLIC_ORIGIN` is https). Lax withholds the cookie
on a cross-site `POST`, `PUT`, `PATCH` and `DELETE` — which is where the danger is. It is Lax
rather than Strict for a stated reason: the OAuth callback is a cross-site top-level navigation
back from Google, and Strict would withhold the cookie on arrival.

**2. There is no CORS configuration anywhere.** `@fastify/cors` is not installed, no handler
writes an `Access-Control-*` header, and `deploy/Caddyfile` adds none at the edge. So a
cross-origin `fetch` cannot read a response, and anything that is not a _simple_ request never
gets past preflight, because no `OPTIONS` route exists to answer it.

**3. One origin.** `deploy/Caddyfile` proxies `/` and `/api` to the same upstream, per host. The
comment there records this as a decision rather than an accident: _"Everything is one origin on
purpose: same-origin means M0-11's session cookies work with SameSite=Lax and no CORS."_

**4. Every state-changing route is `POST`, `PUT`, `PATCH` or `DELETE`.** Which is what makes
fact 1 sufficient — see the soft spot below.

### Why "together" is the whole point

Each fact is worthless alone and none is a fallback for another.

- Drop fact 1 and a cross-site form `POST` carries the session.
- Drop fact 2 — by installing `@fastify/cors` with a permissive origin, the way it is usually
  installed — and a cross-origin `fetch` with `credentials: 'include'` becomes readable, and
  preflight starts succeeding for requests `SameSite=Lax` was the only thing stopping.
- Drop fact 3 and facts 1 and 2 both stop being free: a separate API origin makes every browser
  call cross-site, which forces CORS _and_ `SameSite=None`, removing both defences at once.
- Drop fact 4 — expose one mutation as `GET` — and it is reachable from any page on the internet
  with the session cookie attached, because Lax **does** send the cookie on a top-level
  cross-site `GET`.

### The soft spot, named

`SameSite=Lax` does not protect top-level `GET`. **Nine** registered `GET` routes do change
state, and all nine are the identity flow rather than the game — three per sign-in provider,
which is the shape to hold onto, because it is what makes the list grow predictably:

| route                            | what it changes                                | what protects it instead                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/google`           | writes the signed `tailfin_oauth` state cookie | writes only; forging it grants nothing                                                                                                                                                         |
| `GET /api/auth/google/callback`  | creates a session                              | the OAuth `state` parameter must match the signed `tailfin_oauth` cookie, which is the standard login-CSRF control; `session-cookie.test.ts` proves a callback with no state cookie is refused |
| `GET /api/auth/google/connect`   | writes that cookie with intent `link`          | carries `requireAuth`, and the callback demands the **same player** the cookie was minted for — so a forged start achieves at most sending the victim to a consent screen (AUTH-09)            |
| `GET /api/auth/discord`          | writes the signed `tailfin_oauth` state cookie | as the Google pair; forging it starts a sign-in the attacker cannot finish                                                                                                                     |
| `GET /api/auth/discord/callback` | creates a session                              | the same `state`/cookie control, and the cookie names the provider it was minted for, so a state issued for Google is refused here rather than spending the credential (AUTH-08)               |
| `GET /api/auth/discord/connect`  | writes that cookie with intent `link`          | as the Google connect route                                                                                                                                                                    |
| `GET /api/auth/twitch`           | writes the signed `tailfin_oauth` state cookie | as the Google pair. **No PKCE** — Twitch does not offer it for the authorization-code grant, so the signed provider-bound state cookie and the confidential-client exchange carry the flow     |
| `GET /api/auth/twitch/callback`  | creates a session                              | the same `state`/cookie control and the same provider binding                                                                                                                                  |
| `GET /api/auth/twitch/connect`   | writes that cookie with intent `link`          | as the Google connect route                                                                                                                                                                    |

They are exceptions with their own control, listed by name in `security/csrf.test.ts` so that a
tenth cannot join them silently. **Every other `GET` route must change nothing.**

**This table said "two" and listed four until 2026-09-09**, which is worth recording rather than
quietly correcting. The `/connect` routes arrived with AUTH-09 and the Twitch pair with AUTH-08;
`csrf.test.ts` gained all five, with a written justification for each, and this ADR gained none.
So the mechanism worked exactly as designed — nothing joined the allowlist silently — while the
document explaining the mechanism drifted to under half the surface it claims to enumerate. The
lesson is not "update the ADR too": it is that **a prose list beside an executable one is a
second source of truth**, and the one that cannot fail the build is the one that rots. If this
happens a third time, the fix is to generate this table from the allowlist rather than to write
it out again.

### Why not a token anyway

A token would add a value to mint, a value to store, a value to send, a rotation story, a failure
mode when it expires mid-session, and a test surface — to defend against something four existing
properties already prevent. The honest answer to _"why is this here?"_ would be _"because it is
common"_, and a control nobody can justify is a control nobody maintains correctly.

That reasoning is contingent on the four facts, not on CSRF tokens being bad. If a revisit
trigger fires, this decision is wrong and should be reversed rather than defended.

## Consequences

### What is now tested

`packages/server/src/security/csrf.test.ts` fails if any fact changes:

- the session cookie's `Set-Cookie` carries `SameSite=Lax` (or Strict), `HttpOnly` and `Path=/`,
  asserted on a real sign-in rather than on the options object, and `Secure` under an https origin;
- every registered `GET` route is declared either read-only or a named exception;
- no response carries `Access-Control-Allow-Origin` — including when the request supplies an
  `Origin` header — and no `OPTIONS` route is registered;
- a cross-origin `POST` to an admin route without the cookie is refused **401**, while the same
  request _with_ the cookie reaches validation. That delta is the proof: the server cannot tell a
  cross-site request from a same-site one, so the cookie attribute is doing the work, and that is
  precisely why fact 1 must not be relaxed.

`deploy/verify-security-headers.mjs` asserts the edge adds no `Access-Control-*` header either,
against a real Caddy running the committed Caddyfile.

`authorization-inventory.test.ts` already covers the other half of fact 4 from before this ADR: a
route moved from `POST` to `GET` leaves a matrix row with no route and a route with no row, and
fails both directions.

### Revisit triggers

Any one of these makes this ADR wrong. Reopen it; do not work around it.

1. **A separate API origin** — `api.tailfinsim.com`, a CDN in front of `/api`, anything that ends
   fact 3.
2. **A mobile or third-party client that needs CORS**, or any `@fastify/cors` registration.
3. **`SameSite=None` for any reason**, including an embed, a payment return, or a third-party
   iframe.
4. **A state-changing `GET`** that is not one of the identity exceptions above. Another sign-in
   provider is not this: it adds three routes of a shape already argued for, and `csrf.test.ts`
   is where it must say so. A state-changing `GET` anywhere in the _game_ is.
5. **A second authentication mechanism** that is not a cookie but is still ambient (a persistent
   `Authorization` header held by the browser, say).

### Relationship to other work

- **SEC-HARD-08 (CORS)** owns fact 2 going forward, and has since built the guard rather than
  leaving it to review. `packages/server/src/security/cors.ts` holds an exact-match allowlist
  of what each environment could ever have a reason to trust — production its own origin and
  nothing else — and `CORS_ALLOWED_ORIGINS` is validated against it at boot. Every value is
  refused today, because nothing would consume it; a wildcard, a localhost entry on production
  and a lookalike domain each get their own message. `security/cors.test.ts` additionally
  fails if `@fastify/cors` enters any manifest or the lockfile, which is the one-line change
  that would otherwise make all of this irrelevant. If CORS is ever configured, that allowlist
  is the only sanctioned way to build the list, and this ADR must be amended in the same
  change.
- **ADR-0012** records the threat; this is the control that answers it.
- **ADR-0003** chose the single-origin deployment that fact 3 depends on.

## Threat-model mapping (ADR-0012)

- **Asset:** the integrity of player, economy and destructive admin actions.
- **Attacker / failure mode:** a malicious third-party page inducing an authenticated browser to
  send a state-changing request.
- **Control:** architectural — `SameSite=Lax` + same-origin + no CORS + no state-changing `GET`.
- **Residual risk:** a future change that removes one of the four without noticing. The tests
  named above are the mitigation, and are the reason this ADR is worth more than its prose.
