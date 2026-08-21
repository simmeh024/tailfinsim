# ADR-0018: Retain ceased airlines and release codes from the live namespace

- **Status:** Accepted
- **Date:** 2026-08-21
- **Deciders:** @simmeh024
- **Constrains:** AIR-09, M8-07, M11-08, M13-09, M4 fleet writes, statistics and leaderboards

## Context

An airline is currently indistinguishable from a live operating business. That cannot
express a recoverable restriction, a player who has left, or a business that has ceased
while its flights and financial history remain part of the persistent world. Deleting the
row would contradict sections 22.2 and 22.10: schedules, flights, results, cash movements
and public history resolve through its stable UUID.

IATA and ICAO designators are also scarce per world. ADR-0009 allocated them for an
airline's lifetime but deliberately left release to AIR-09. Releasing a designator by
erasing it from the old row would make the historical identity less legible. Never
releasing it would eventually exhaust the small IATA namespace.

The lifecycle must leave clear integration points for M8-07's recoverable administration,
M4's aircraft inventory, M11-08's deletion/support controls, statistics, and M13-09's full
GDPR request workflow without inventing those systems here.

## Decision

### Three states, one stable airline

Every airline starts `active` and retains the same UUID for its whole recorded life.
`airline.status_changed_at` stores real time for support and `ceased_at` is present only in
the terminal state. Each actual change also appends an `airline_status_transition` with
the before/after states, a non-blank reason, game-time `occurred_at`, and real-time
`recorded_at`.

| State        | Meaning                                    | Historical reads | Existing operations | New routes/aircraft | Rebrand | Live statistics/cap |
| ------------ | ------------------------------------------ | ---------------- | ------------------- | ------------------- | ------- | ------------------- |
| `active`     | Ordinary operating airline                 | yes              | yes                 | yes                 | yes     | included            |
| `restricted` | Recoverable control state                  | yes              | yes                 | no                  | no      | included            |
| `ceased`     | Terminal, retained read-only world history | yes              | no                  | no                  | no      | excluded            |

The allowed graph is `active → restricted`, `restricted → active`, and either live state
to `ceased`. Cessation is terminal. Reactivating it could conflict immediately with a
successor that has claimed its released designator; a later return therefore requires a
new airline rather than rewriting the ceased record.

`restricted` is deliberately narrow. Existing routes may be priced and already committed
operations continue, but the airline cannot open a route, acquire aircraft, or pay for a
rebrand. M8-07 owns the triggers and the later administration/disposal ladder; AIR-09 owns
only the reusable state and permission boundary.

### Instructions stop; materialised history survives

Transitioning to `ceased` deactivates the airline's routes and repeating schedules in the
same transaction. It does not delete either, does not delete already materialised flights,
and does not block those flights from reaching their final state and settlement. Flights,
flight results, cash movements, identity changes, lifecycle transitions and admin audit
entries remain readable through the stable airline UUID.

There is no airframe table yet. M4 integrations must apply the same rule: restricted
airlines cannot acquire another aircraft; ceased airlines cannot command or acquire one;
and cessation does not silently destroy an aircraft's historical record. M8-07 owns any
forced sale, repossession or administration transfer rather than AIR-09 fabricating it.

World reset remains different. ADR-0005 erases the world's timeline and therefore deletes
airlines and their dependent operational rows. Ordinary cessation preserves that timeline
and therefore preserves the airline row.

### Codes are unique among live airlines

The ceased row keeps its IATA and ICAO fields exactly as used during its life. The per-world
unique indexes apply only where `status <> 'ceased'`. On the transaction that commits
cessation, both designators become immediately available to a new active airline; there is
no cooldown or separate reservation record.

This is unambiguous because operational and historical records use the airline UUID, never
the code as a foreign key. A search result may show two airlines that used `TF` at different
times, but every flight still joins to exactly one of them. Code availability, alternatives
and founding player-cap counts consider `active` and `restricted` airlines only. Ownership
membership remains across all states, so a non-anonymized owner cannot silently found a
second airline in the same world after ceasing the first.

The migration replaces the old unique constraints atomically with partial unique indexes
using the same names. The preceding release remains compatible: its new rows receive the
`active` default and encounter the same named conflict, while its advisory checker is only
more conservative about codes that have just been released.

### One status-aware ownership boundary

ADR-0010's request context now resolves `{ id, worldId, status }` once. Three guards express
the permission rather than duplicating status checks in handlers:

- `requireAirline` permits every status for historical reads;
- `requireOperatingAirline` permits `active` and `restricted`; and
- `requireActiveAirline` permits only `active` for new commitments.

State refusals are stable `409 airline_restricted` and `409 airline_ceased` responses.
Services that make authoritative commitments also re-read a locked airline where needed so
the request guard is not the only protection against a concurrent transition.

### Anonymise the person; retain the airline

AIR-09 supplies the transactional domain primitive that M13-09's full request workflow will
invoke. It locks the player, ceases every live airline they own, removes external identities,
sessions and admin authority, replaces the display name/avatar with a neutral pseudonymous
record, and sets `player.anonymized_at`. The player UUID remains only as the required owner
anchor for retained airline history. Pre-existing audit entries keep their denormalized
historical actor label; M13-09 owns retention/legal policy for the complete GDPR flow.

The operation is tested through PostgreSQL with an identity, session, grant, route,
schedule, flight, result and audit entry. After anonymisation, no sign-in authority remains,
the airline and history still join, instructions are inactive, and a different player can
found a new airline using the released codes.

### Statistics use one live predicate

The server exports `LIVE_AIRLINE_STATUSES` and `liveAirlineWhere()`. World-cap accounting
uses that predicate now; later public profiles, statistics and leaderboards must use it
instead of treating every retained airline row as a current competitor. Restricted remains
live because it is recoverable and its existing operation still competes. Ceased is omitted
from live rankings but remains eligible for explicit historical/all-time views.

## Consequences

### What this makes easier

- Administration can restrict and recover an airline without replacing it.
- A player can leave without erasing the world's operational and financial history.
- Scarce designators can be reused without making historical joins ambiguous.
- Reads, existing operations and new commitments have named, reusable permission guards.
- World caps and future leaderboards have one explicit definition of live.
- The full GDPR workflow has a tested identity-removal/history-retention primitive.

### What this makes harder

- Code alone is no longer a globally unique historical identifier; consumers must use the
  airline UUID and may need time context when displaying reused codes.
- Cessation updates routes and schedules as well as the airline and transition event.
- A ceased airline cannot be reactivated; returning requires a new record and identity.
- Retaining a pseudonymous player anchor means M13-09 must still define legal retention,
  exports, request authorization and audit-label policy.

## Alternatives considered

| Option                                       | Why not                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Delete an airline when it stops              | Erases or cascades world history that sections 22.2 and 22.10 require to survive.                |
| Null the ceased airline's codes              | Makes its historical identity less legible and weakens support/audit views.                      |
| Never release codes                          | Eventually exhausts the IATA namespace and turns abandoned airlines into permanent reservations. |
| Allow `ceased → active`                      | A successor may already own the released code, so revival cannot preserve both identities.       |
| Exclude restricted airlines from all stats   | They still operate existing commitments and remain recoverable competitors.                      |
| Make bankruptcy the lifecycle implementation | M8-07 owns financial triggers, disposals and recovery mechanics; AIR-09 only defines the states. |

## Revisit when

- M8-07 implements restriction, administration, forced disposal and recovery triggers;
- M4 adds airframes and acquisition/command permission checks;
- M13-09 completes GDPR request authorization, export and retention policy; or
- historical profile/search design needs explicit code-use date ranges.
