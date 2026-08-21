# ADR-0010: Resolve the player airline once from an explicit active world

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** @simmeh024
- **Constrains:** AIR-05 and every player-facing, world-scoped endpoint

## Context

The first network handlers established the right ownership principle — **resolve, never
verify** — but implemented it independently. `network/routes.ts` joined through the player
for reads and fare changes, while `network/open-route.ts` ran a separate `LIMIT 1` airline
query. Their no-airline results also disagreed: an empty list, a route 404, or a domain
refusal depending on which handler ran.

That duplication is an authorization hazard. An endpoint accepting an `airlineId` and then
checking it is one omitted comparison away from operating on a competitor. Repeating the
resolution query in every handler still leaves several subtly different definitions of
“mine”.

Multi-world makes an implicit definition wrong. The schema deliberately permits one player
to own an airline in each world, and design document §22.2 requires parallel worlds. SQL
`LIMIT 1` without an active-world rule therefore chooses an arbitrary airline rather than
the player's intended one.

## Decision

### One request boundary resolves ownership

`registerPlayerAirlineContext` provides a Fastify `requireAirline` guard. It first applies
the existing session requirement, then resolves `{ id, worldId, status }` from `airline.player_id`
and the active world and stores that result on the request.

Guarded handlers receive no client-supplied airline id. They constrain every route query by
the resolved airline id, and services such as `openRoute` receive that resolved context
rather than resolving ownership again. A missing route and another airline's route keep the
same 404 response, so the endpoint is not an id-existence oracle.

### Active-world selection is explicit when it matters

The request header `x-tailfin-world-id` selects the world. Selection follows these rules:

| Request/player state                                | Result                              |
| --------------------------------------------------- | ----------------------------------- |
| Valid header and an owned airline in that world     | Resolve that airline                |
| Valid header but no owned airline in that world     | `409 airline_required`              |
| No header and exactly one airline across all worlds | Resolve the only unambiguous choice |
| No header and no airline                            | `409 airline_required`              |
| No header and airlines in several worlds            | `409 active_world_required`         |
| Malformed or repeated header                        | `400 invalid_active_world`          |
| No valid session                                    | The existing `401 unauthorized`     |

There is deliberately no “newest airline” fallback. Creation time is not player intent and
would silently switch an established player to another world after founding a second
airline. The single-airline fallback keeps today's one-world client working; a future world
picker must send the header once more than one choice exists.

The active world is request-scoped, not stored on the player or session. That avoids stale
server-side preference state and lets two tabs operate in different worlds. World lifecycle
permission — for example, archived worlds being read-only — remains a separate rule from
ownership resolution; selecting a world does not grant an operation the right to mutate it.

### Airline absence is an expected state with one response

A signed-in player without an airline in the selected world is normal: they may not have
founded one yet, or a world reset may have removed it while preserving the account. Every
guarded endpoint therefore returns the same machine-readable
`409 airline_required` response. `409` says the request conflicts with the player's current
world state; signing in again will not help, while founding an airline will.

The shared `PlayerAirlineContextError` schema owns the stable context codes. Human messages
may improve without requiring clients to match prose.

AIR-08's private `GET /api/airlines/me` is the deliberate discovery exception: it uses the
same authentication and active-world selection, but returns a successful nullable airline
instead of `airline_required` when none exists. That lets the client decide between founding
and managing without turning an expected onboarding state into an error.

AIR-09 layers lifecycle permission onto the same resolution rather than creating another
ownership query: `requireAirline` allows historical reads, `requireOperatingAirline` allows
active and restricted existing operations, and `requireActiveAirline` admits only active
airlines for new commitments. Restricted and ceased refusals use the stable
`airline_restricted` and `airline_ceased` codes recorded by ADR-0018.

## Consequences

### What this makes easier

- A handler cannot forget an ownership comparison because it never receives an arbitrary
  airline id to compare.
- New player-airline endpoints get authentication, world selection and absence semantics by
  applying one guard.
- Multi-world behavior is deterministic and visible instead of depending on row order.
- Ownership-isolation tests can exercise the HTTP boundary and prove a competitor's route is
  indistinguishable from a missing route.

### What this makes harder

- Multi-world clients must carry the active-world header on every guarded request.
- A signed-in player with several airlines cannot use an older client that has no world
  picker; the server refuses rather than guessing.
- `requireAirline` performs one ownership query per guarded request. It avoids a wider query
  and is preferable to trusting cache state that can outlive a reset.

## Alternatives considered

| Option                                               | Why not                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Accept `airlineId` and compare ownership             | One forgotten or inconsistent comparison exposes another airline's rows.                                                          |
| Resolve independently in every handler               | Recreates the inconsistency and no-airline drift AIR-05 exists to remove.                                                         |
| Always choose the newest airline                     | Creation recency is not intent and silently changes the active world after later founding.                                        |
| Persist one active world on the player               | Two tabs cannot operate independently, and reset/deletion leaves preference state to reconcile.                                   |
| Put `worldId` in every request body                  | GET has no body, and repeating body parsing gives every handler another chance to implement it.                                   |
| Return an empty success for every no-airline request | Mutations and operational reads would lose their stable prerequisite refusal; only AIR-08's typed discovery response is nullable. |

## Revisit when

- the player-facing world picker is built, to make the header explicit in the client API
  helper rather than relying on the single-airline fallback; or
- public archived-world browsing needs a context distinct from the player's operational
  airline.
