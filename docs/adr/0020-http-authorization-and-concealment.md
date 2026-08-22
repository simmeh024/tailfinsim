# ADR-0020: HTTP authorization and private-resource concealment

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** @simmeh024
- **Constrains:** every HTTP guard, identifier-bearing route, and player-owned resource

## Context

Tailfin had the right status codes in several individual handlers, but no single contract said
when to use 401, 403 or 404. That left a particularly important question to each feature:
should a signed-in player who supplies another airline's resource id learn that the resource
exists?

An inconsistent answer is worse than either deliberate answer. If one endpoint returns 403 for
a competitor's id while another returns 404, the first endpoint becomes an existence oracle
for the second. Differences in response bodies can leak the same fact even when the status
codes agree. Malformed UUIDs were another inconsistent edge: admin handlers parsed them and
returned 404, while player route handlers sent them to PostgreSQL's `uuid` comparison and
could turn a routine miss into a 500.

The client also needs to distinguish authentication from authorization. Sending a signed-in
player back through OAuth cannot grant an admin permission they do not hold; answering that
case with 401 creates a login loop rather than a remedy.

## Decision

### 1. Authentication and permission have different answers

- **401 Unauthorized** means the request has no valid Tailfin session. Missing, expired,
  revoked and unrecognised session credentials all get the same answer.
- **403 Forbidden** means a valid session was resolved but the actor lacks a permission that
  is safe to name, currently the admin grant. The guard runs before any resource lookup, so
  the response reveals no target existence or handler data.

Authentication is evaluated before permission, and permission before resource resolution. A
guest therefore never receives 403 from a guarded route, and a signed-in non-admin never
receives 401 merely because the admin gate refused them.

### 2. Private resources resolve inside the caller's namespace

A **private resource** is a response or mutation target whose existence, ownership or
membership is not intentionally visible to every signed-in player. Player airline routes are
private resources. Future schedules, aircraft, transactions and other airline-owned records
are private unless a separate public contract says otherwise.

Handlers resolve a private resource in one owner-scoped query. They do not fetch it globally
and compare the owner afterwards. These three cases return the endpoint's identical 404 body:

1. the path identifier is malformed and cannot name a row;
2. the identifier is well formed but no row exists;
3. a row exists outside the caller's ownership namespace, including another world or owner.

For the current route endpoints that body is exactly:

```json
{ "code": "not_found", "message": "No such route" }
```

The tradeoff is deliberate. Concealment makes support debugging less direct and prevents a
player client from distinguishing a stale id from a competitor's id. In return, no
player-facing endpoint becomes an object-existence oracle. Administrators diagnose the real
record through explicit, audited `/api/admin/*` surfaces rather than through an ownership
bypass on player routes.

Well-formed missing and cross-owner identifiers execute the same scoped query and receive the
same status, code and message. Malformed path identifiers are parsed before database access;
their syntax is client-supplied and not secret, and avoiding a database type error is more
important than manufacturing identical query time. Do not add different messages, headers or
error codes that recreate the existence side channel.

### 3. Public projections are explicit exceptions

A **public projection** is an intentionally designed view whose existence and returned fields
are safe for its declared audience independent of ownership. `/api/version` is a public
projection; future public airline profiles or rankings may be others. A database row does not
become public merely because some of its columns look harmless.

Every public projection must be named as public in `docs/authorization-matrix.md`, define its
allowed fields, and have disclosure tests. It may report real absence because existence is
part of its public contract. A public projection never authorizes mutation of the private row
behind it.

Admin resource details are permission-protected rather than player-owner-scoped. A non-admin
is stopped with 401 or 403 before lookup; an admitted admin can receive an entity-specific 404
because the grant already authorizes that operational visibility.

### 4. The remaining request statuses retain their meaning

- **400 Bad Request:** the request shape, syntax or submitted value is invalid. This applies
  to bodies and query values, not to a path identifier that purports to name a resource.
- **404 Not Found:** no resource is resolvable in the actor's permitted namespace, including a
  malformed resource path id.
- **409 Conflict:** the request is valid but conflicts with current persisted state, such as a
  stale expected version, a duplicate, or an unavailable lifecycle state.
- **422 Unprocessable Content:** the request is structurally valid and state-addressable, but
  a domain rule refuses the proposed operation, such as a fare below its calculated floor.

## Consequences

`requireAuth` and `requireAdmin` own 401/403. Player-owned handlers compose the session-derived
airline context and query with the resolved airline id. Identifier parsing happens before a
typed database predicate. Tests pin the exact 401 and 403 bodies, assert every current path
identifier returns 404 rather than 500 when malformed, and compare cross-owner, missing and
malformed route responses byte-for-byte across every current owned-route endpoint.

The policy deliberately does not promise that every 404 in the product has one universal
message. It promises that every observation which could distinguish ownership from absence is
identical **within the same endpoint contract**.

## Revisit when

Revisit the concealment choice only if Tailfin deliberately publishes resource existence, or
if support evidence shows the indistinguishable answer creates an operational cost greater
than the enumeration risk. That change requires a public projection with an explicit field
contract; it is not a reason to return 403 from one private handler.

## Alternatives considered

**403 for every cross-owner identifier.** Rejected because it confirms that the identifier
exists and is owned by somebody else. It also requires a global lookup followed by an owner
comparison, the code shape most likely to become a missing authorization check.

**404 for every permission failure.** Rejected because the existence of an admin route is not
the sensitive fact; its contents are. A signed-in non-admin benefits from the actionable 403,
while the guard still runs before the resource or handler is reached.

**400 for malformed UUID path segments.** Rejected because the segment is the requested
resource name. Whether it is malformed or simply absent changes nothing the client can act on,
and 404 keeps it aligned with resource resolution while preventing a database 500.
