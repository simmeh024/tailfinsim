# ADR-0025: No CSRF token, and the four facts that replace it

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** @simmeh024
- **Constrains:** every cookie attribute, every state-changing route's HTTP method, any future CORS
  configuration, and any proposal to serve the API from a second origin

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

`SameSite=Lax` does not protect top-level `GET`. Two registered `GET` routes do change state, and
both are the sign-in flow rather than the game:

| route                           | what it changes                                | what protects it instead                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/google`          | writes the signed `tailfin_oauth` state cookie | writes only; forging it grants nothing                                                                                                                                                         |
| `GET /api/auth/google/callback` | creates a session                              | the OAuth `state` parameter must match the signed `tailfin_oauth` cookie, which is the standard login-CSRF control; `session-cookie.test.ts` proves a callback with no state cookie is refused |

They are exceptions with their own control, listed by name in `security/csrf.test.ts` so that a
third one cannot join them silently. **Every other `GET` route must change nothing.**

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
4. **A state-changing `GET`** that is not one of the two sign-in exceptions above.
5. **A second authentication mechanism** that is not a cookie but is still ambient (a persistent
   `Authorization` header held by the browser, say).

### Relationship to other work

- **SEC-HARD-08 (CORS)** owns fact 2 going forward. The two decisions must stay consistent: if
  CORS is ever configured, it must be an allowlist of exact origins, and this ADR must be
  amended in the same change.
- **ADR-0012** records the threat; this is the control that answers it.
- **ADR-0003** chose the single-origin deployment that fact 3 depends on.

## Threat-model mapping (ADR-0012)

- **Asset:** the integrity of player, economy and destructive admin actions.
- **Attacker / failure mode:** a malicious third-party page inducing an authenticated browser to
  send a state-changing request.
- **Control:** architectural — `SameSite=Lax` + same-origin + no CORS + no state-changing `GET`.
- **Residual risk:** a future change that removes one of the four without noticing. The tests
  named above are the mitigation, and are the reason this ADR is worth more than its prose.
