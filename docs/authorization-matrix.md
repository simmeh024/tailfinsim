# Authorization matrix

This document is the design expectation for every HTTP boundary Tailfin serves today. It is
not generated from the guards in the implementation: that would only prove the code agrees
with itself. When a route and this matrix disagree, the disagreement is a bug or an explicit
open question, not a reason to copy the current behaviour into this file without review.

The matrix was audited against `packages/server/src/app.ts` and every `routes.ts` registered
from it, plus the worker-only routes in `packages/server/src/engine/health.ts`.
The status and concealment rules are owned by
[ADR-0020](adr/0020-http-authorization-and-concealment.md); this document applies them to the
current route inventory.

## Identities and results

- **Guest** has no valid Tailfin session.
- **Player** has a valid session but no admin grant and, where a target is player-owned, does
  not own that target.
- **Owner** is the signed-in player whose selected airline owns the target. Ownership is
  resolved from the session and `x-tailfin-world-id`; a player endpoint never trusts an
  airline id supplied by the client.
- **Admin** has the current all-or-nothing `admin_grant`. On player endpoints, the column
  assumes the admin does not also own the target: an admin grant is not an ownership bypass.
- **Allow** means the authorization boundary lets the request reach the handler. Validation,
  lifecycle and other business rules may still produce a non-2xx response.

`requireAuth` returns 401 to a guest. `requireAdmin` returns 401 to a guest and 403 to a
signed-in non-admin. The airline guards compose `requireAuth` with session-derived ownership:
`requireAirline` requires an owned airline, `requireActiveAirline` additionally refuses a
restricted or ceased airline, and `requireOperatingAirline` refuses a ceased airline while
allowing an existing operation to continue when restricted.

## Response policy

| Situation                                                   | Status | Contract                                                                         |
| ----------------------------------------------------------- | -----: | -------------------------------------------------------------------------------- |
| No valid session on a protected route                       |    401 | Missing, expired, revoked and invalid credentials are indistinguishable.         |
| Valid session lacks a disclosed route permission            |    403 | Currently the admin grant; the guard runs before target lookup.                  |
| Path id does not resolve in the actor's permitted namespace |    404 | Malformed, missing and cross-owner private ids receive the endpoint's same body. |
| Invalid request shape, syntax, body or query value          |    400 | The request itself needs correction.                                             |
| Valid request conflicts with persisted state                |    409 | Retrying after state changes may succeed.                                        |
| Valid request is refused by a domain rule                   |    422 | The response names the rule and recovery information.                            |

A **private resource** is a target whose existence, ownership or membership is not intended
for every signed-in player. It is selected with an owner-scoped query, never fetched globally
and compared after the fact. A cross-owner id and a nonexistent id therefore execute the same
lookup and return the same status, code and message. Current airline routes are private.

A **public projection** is a deliberately limited view whose existence and fields are safe for
its declared audience independent of ownership. It must be marked public in this matrix and
carry disclosure tests; a public view never grants mutation rights over its backing private
row. `/api/version` is public today. Future public airline profiles or rankings must establish
their projection explicitly rather than weakening the private-resource rule.

Admin detail routes are permission-protected rather than player-owner-scoped. Guests and
non-admins stop at 401/403 before lookup; an admitted admin can receive an entity-specific 404
because that grant already authorizes the operational visibility.

Automatic `HEAD` variants inherit the corresponding `GET` expectation and are not repeated.
The static client and SPA fallback are recorded separately because they are not explicit API
route registrations. Unknown `/api/*` paths return a public 404 rather than the SPA.

## Web/API routes

The rows between the markers are the canonical registered-route inventory that the
route-enumeration tests owned by [SEC-04](https://github.com/simmeh024/tailfinsim/issues/215)
must compare with Fastify's route table. One method/path pair appears in each row.

<!-- AUTHORIZATION_MATRIX_START -->

| Route                                               | Mechanism                                                              | Guest | Player                               | Owner                                    | Admin                       |
| --------------------------------------------------- | ---------------------------------------------------------------------- | ----- | ------------------------------------ | ---------------------------------------- | --------------------------- |
| `GET /`                                             | Intentionally public surface                                           | Allow | Allow                                | Allow                                    | Allow                       |
| `GET /healthz`                                      | Intentionally public health probe                                      | Allow | Allow                                | Allow                                    | Allow                       |
| `GET /api/version`                                  | Intentionally public release identity                                  | Allow | Allow                                | Allow                                    | Allow                       |
| `GET /api/me`                                       | Public, session-adaptive response                                      | Allow | Allow                                | Allow                                    | Allow                       |
| `GET /api/auth/google`                              | OAuth initiation; signed state + PKCE                                  | Allow | Allow                                | Allow                                    | Allow                       |
| `GET /api/auth/google/callback`                     | OAuth callback; signed state + PKCE                                    | Allow | Allow                                | Allow                                    | Allow                       |
| `POST /api/auth/logout`                             | Intentionally public and idempotent; affects only the presented cookie | Allow | Allow                                | Allow                                    | Allow                       |
| `POST /api/auth/logout-all`                         | `requireAuth`; affects only the caller                                 | 401   | Allow                                | Allow                                    | Allow                       |
| `GET /api/admin/overview`                           | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/audit`                              | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/admins`                             | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/players`                            | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/players/:playerId`                  | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `POST /api/admin/players/:playerId/sessions/revoke` | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/airlines/:airlineId`                | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `PATCH /api/admin/airlines/:airlineId/identity`     | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/worlds/health`                      | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/system-health`                      | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/worlds`                             | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `POST /api/admin/worlds`                            | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `POST /api/admin/worlds/:worldId/speed`             | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `POST /api/admin/worlds/:worldId/status`            | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `POST /api/admin/worlds/:worldId/reset`             | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/economy-config`                     | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/economy-config/:version`            | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `POST /api/admin/economy-config`                    | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `POST /api/admin/worlds/:worldId/economy-config`    | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/admin/worlds/:worldId/npc`                | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `POST /api/admin/events/requeue`                    | `requireAdmin`                                                         | 401   | 403                                  | 403                                      | Allow                       |
| `GET /api/airlines/me`                              | `requireAuth`; session-derived identity                                | 401   | Allow                                | Allow                                    | Allow; no ownership bypass  |
| `PATCH /api/airlines/me`                            | `requireActiveAirline`                                                 | 401   | 409 without an owned airline         | Allow when active                        | Same as player/owner        |
| `GET /api/world/clock`                              | `requireAirline`                                                       | 401   | 409 without an owned airline         | Allow when active                        | Same as player/owner        |
| `GET /api/crew`                                     | `requireAirline`                                                       | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `POST /api/crew/bases`                              | `requireActiveAirline`; airline derived from session                   | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `POST /api/crew/hires`                              | `requireActiveAirline`; base scoped by resolved owner                  | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `POST /api/crew/conversions`                        | `requireActiveAirline`; base scoped by resolved owner                  | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `PUT /api/crew/reserves`                            | `requireActiveAirline`; base scoped by resolved owner                  | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `PUT /api/crew/policies`                            | `requireActiveAirline`; base scoped by resolved owner                  | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `GET /api/airlines/founding-options`                | `requireAuth`                                                          | 401   | Allow                                | Allow                                    | Allow                       |
| `GET /api/airlines/founding-airports`               | `requireAuth`                                                          | 401   | Allow                                | Allow                                    | Allow                       |
| `POST /api/airlines/code-availability`              | `requireAuth`                                                          | 401   | Allow                                | Allow                                    | Allow                       |
| `POST /api/airlines`                                | `requireAuth`; founding rules decide eligibility                       | 401   | Allow                                | Allow; may be refused as already founded | Allow; no bypass            |
| `GET /api/fleet/catalogue`                          | `requireAirline`                                                       | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `POST /api/fleet/acquisition-quotes`                | `requireAirline`; airline/world derived; server folds price and spec   | 401   | 409 without an owned airline         | Allow preview; active status checked     | Same as player/owner        |
| `GET /api/fleet/used-market`                        | `requireAirline`; world derived from session                           | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `GET /api/fleet/airframes`                          | `requireAirline`; airline derived from session                         | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `GET /api/fleet/airframes/:airframeId`              | `requireAirline`; query scoped by session-resolved owner               | 401   | 404, identical to an unknown id      | Allow                                    | Same as player/owner        |
| `GET /api/fleet/maintenance`                        | `requireAirline`; airline derived from session                         | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `POST /api/fleet/maintenance/checks`                | `requireActiveAirline`; airframe ownership resolved, never accepted    | 401   | 409 without an owned airline         | Allow only when active                   | Same as player/owner        |
| `GET /api/fleet/orders`                             | `requireAirline`; airline derived from session/world                   | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `POST /api/fleet/acquisitions`                      | `requireActiveAirline`; airline derived from session/world             | 401   | 409 without an owned airline         | Allow only when active                   | Same as player/owner        |
| `GET /api/routes`                                   | `requireAirline`                                                       | 401   | 409 without an owned airline         | Allow                                    | Same as player/owner        |
| `POST /api/routes`                                  | `requireActiveAirline`                                                 | 401   | 409 without an owned airline         | Allow when active                        | Same as player/owner        |
| `PUT /api/routes/:routeId/fares`                    | `requireOperatingAirline` + owner-scoped query                         | 401   | 409 without airline; 404 cross-owner | Allow unless ceased                      | 404 unless owner; no bypass |
| `GET /api/routes/:routeId/waterfall`                | `requireAirline` + owner-scoped query                                  | 401   | 409 without airline; 404 cross-owner | Allow                                    | 404 unless owner; no bypass |
| `POST /api/routes/:routeId/fares/preview`           | `requireOperatingAirline` + owner-scoped query                         | 401   | 409 without airline; 404 cross-owner | Allow unless ceased                      | 404 unless owner; no bypass |

<!-- AUTHORIZATION_MATRIX_END -->

## Static and fallback web surface

| Surface                                        | Mechanism                                                        | Expected result for every identity |
| ---------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| `GET /<client-route>` with `Accept: text/html` | SPA fallback, only when `WEB_SURFACE=app` and never under `/api` | Public HTML                        |
| `GET /<built-client-asset>`                    | `@fastify/static`, only when `WEB_SURFACE=app`                   | Public asset                       |
| Unknown `/api/*` or non-HTML path              | Narrow not-found handler                                         | Public 404 with no private data    |

## Worker-only routes

The worker binds to loopback on its own node and has no public vhost. These routes have no
application identity or session parser; the network boundary is their authorization. Every
guest/player/owner/admin outside that host is therefore unable to reach them. An on-host
operator can read them without an application credential.

| Route          | Mechanism                                   | Guest              | Player             | Owner              | Admin              |
| -------------- | ------------------------------------------- | ------------------ | ------------------ | ------------------ | ------------------ |
| `GET /healthz` | Loopback bind + host firewall; no app guard | Not edge-reachable | Not edge-reachable | Not edge-reachable | Not edge-reachable |
| `GET /queues`  | Loopback bind + host firewall; no app guard | Not edge-reachable | Not edge-reachable | Not edge-reachable | Not edge-reachable |

## Decisions and open questions

The three ambiguities recorded when SEC-01 was opened have changed as the product grew:

1. **`GET /api/version` remains intentionally public.** It reveals a build number, a short
   commit from a public repository and deployment timing. The operational value is greater
   than the disclosure; keep it public.
2. **`GET /api/me` remains intentionally public.** The login wall needs
   `registrationOpen`, and an anonymous response contains `player: null` and
   `isAdmin: false`; keep the adaptive public response.
3. **`requireAuth` is no longer unused.** Airline founding, own-airline discovery and global
   sign-out use it directly; the airline guards compose it. Do not remove or replace it with
   handler-local session checks.

Current open questions are:

1. **Worker diagnostics rely entirely on loopback.** That is a valid boundary while no
   public or private-network listener exists. Recommendation: keep the routes credentialless
   on loopback, but require a separate operator credential before any future network exposure.
2. **Admin authority is all-or-nothing.** The design document's `Support`, `GameMaster`,
   `Economist`, `WorldAdmin` and `SuperAdmin` roles do not exist yet. They remain future work
   owned by [M11-01](https://github.com/simmeh024/tailfinsim/issues/101); until then the matrix
   must not imply finer grants than `requireAdmin` can enforce.
3. **Admin is not an ownership bypass.** This prevents a broad operational grant from
   silently becoming permission to act as an airline. Recommendation: keep admin remediation
   on explicit `/api/admin/*` routes with audit requirements rather than weakening player
   ownership guards.

SEC-01 was written before the first player-owned endpoints existed, so its proposed empty
owner column is historical. M2/AIR-05 has since established session-derived airline ownership;
the owner rows above record the system that exists now rather than preserving that old gap.

## Maintenance rule

Add or change the matrix row in the same pull request as an HTTP route. The row states the
intended boundary first; tests then prove the registered route agrees.

This is now enforced, not merely asked for. `authorization-inventory.test.ts` (SEC-04)
enumerates the routes Fastify actually registered and fails if any lacks a row here, or if
any row here names a route that no longer exists — so a route added without a row, or a row
left behind by a renamed route, is a failing test rather than a reviewer's catch. It runs
without a database, on every pull request. `admin/authorization.test.ts` then proves the
running server answers 401 to a guest, 403 to a signed-in non-admin and lets the administrator
through, for every `/api/admin/*` route, and that a refused destructive request changed
nothing and wrote no audit row. Later ownership issues own the cross-owner cases.

The gate compares _routes_, not boundaries — it cannot read intent — so still fill each row's
guest/player/owner/admin columns from the design. Any new private identifier also needs
missing, malformed and cross-owner cases with the same observable 404 response.
