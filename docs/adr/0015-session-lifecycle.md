# ADR-0015: Session lifetime, rotation and revocation

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Tailfin maintainers

## Context

Tailfin already issued 256-bit opaque session tokens, stored only their SHA-256 hashes,
enforced absolute expiry in the lookup query and deleted the current row on logout. Those
properties do not answer the authority-change cases in
[SEC-HARD-06](https://github.com/simmeh024/tailfinsim/issues/254): a cookie minted before
admin elevation could become privileged without changing, a stolen cookie had no immediate
revoke-all path, and player and admin sessions shared one 30-day lifetime.

Tailfin is a persistent world rather than a short transaction: an ordinary player reasonably
returns over weeks. Admin access is different. It changes worlds and operational state, so a
copied privileged cookie should not remain useful for a month. The system also needs an
incident-response path whose success and record cannot come apart.

## Decision

The session cookie remains an `httpOnly`, `SameSite=Lax` opaque token. It is `Secure` whenever
the public origin is HTTPS, and a production-labelled process refuses to boot when
`PUBLIC_ORIGIN` is not HTTPS. Tokens are never stored or audited; only their hashes exist in
Postgres.

Player sessions default to 720 hours (30 days). This favours a daily or weekly persistent-world
visit without making the browser perform OAuth each time. The longer lifetime is acceptable
because a player or administrator can revoke every session immediately and ordinary logout
deletes the current row server-side.

Admin sessions default to 12 hours: one operator workday. `ADMIN_SESSION_TTL_HOURS` must be
strictly shorter than `SESSION_TTL_HOURS`, and OAuth chooses the lifetime from the player's
admin grant when it issues the session.

Every successful OAuth callback atomically deletes any session token presented by that browser
and inserts a fresh session. A pre-login identifier therefore cannot survive authentication,
and issuance failure rolls both operations back.

A real admin grant or revocation deletes **all** sessions for the target in the same transaction
as the grant change and its append-only audit row. The player signs in again and receives a
token with the authority and lifetime that apply after the change. Idempotent grant/revoke
requests do not rotate because they changed no authority.

Two explicit revocation paths use the same transactional service:

- `POST /api/auth/logout-all` lets a signed-in player end every device session.
- `POST /api/admin/players/:playerId/sessions/revoke` gives an administrator the incident-response
  control from the player detail page.

The audit action is `sessions.revoked`. It records actor, subject, request id, success and count,
never a token or token hash. Logout of only the current browser remains idempotent and unaudited.

Expiry is a correctness condition in every session lookup, not a cleanup job. The unused
`sweepExpiredSessions` function is removed rather than leaving a dead mechanism that looks
scheduled. Expired rows may remain as harmless metadata until a retention policy is deliberately
introduced; they cannot authenticate.

## Consequences

### What this makes easier

- Privilege changes take effect for every existing cookie at the database commit boundary.
- A player or operator can respond immediately to a lost device or suspected cookie theft.
- Admin-cookie exposure is bounded to one shift even when nobody notices it first.
- Tests prove fixation resistance, expiry, logout replay rejection, grant/revoke rotation,
  revoke-all and insecure-production boot rather than relying on configuration assumptions.

### What this makes harder

- Granting or revoking admin signs the target out on every device, including the device used
  immediately before the change.
- Administrators must authenticate at least once per 12-hour window.
- Expired rows are not physically purged until a separate retention policy is justified.

## Alternatives considered

| Option                                      | Why not                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Keep the 30-day token through admin grant   | A token issued under player authority would silently acquire privilege and any copied value would do so too. |
| Give admins the same 30-day lifetime        | Operator convenience does not justify a month-long privileged bearer token.                                  |
| Revoke only the browser making the request  | A lost-device or stolen-cookie response must invalidate copies the current browser cannot see.               |
| Delete sessions, then write an audit record | A crash between statements could perform an unrecorded incident-response action.                             |
| Schedule the unused sweep as correctness    | Lookup already rejects expiry; scheduling dead cleanup would add operational state without a retention rule. |

## Revisit when

- Tailfin adds step-up authentication, multiple identity providers or scoped operator roles.
- Session/device metadata is rich enough to support selective device revocation safely.
- A data-retention policy defines when expired-session metadata must be purged.
