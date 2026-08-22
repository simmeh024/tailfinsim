# ADR-0011: Every airline cash change is an immutable, reconciling movement

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** @simmeh024
- **Constrains:** AIR-06, M8-01, M8-07, M8-08 and every future game-balance mutation

## Context

`airline.cash_minor` is the current game balance, but before AIR-06 it had no authoritative
history. Founding assigned opening cash on insert and flight settlement updated the balance
directly. `flight_result` explains what one flight earned and cost, but no durable row tied
that cause to the cash changing. A support question such as “why is my balance lower?” was
therefore unanswerable from the balance itself.

Design document §14.1 says every figure drills down to its cause. M8-01 will build the
itemised P&L — categories, counterparties and route/aircraft/hub dimensions — but it needs a
narrower invariant underneath: every balance movement exists exactly once and reconciles to
the materialised current balance.

Real commerce money is outside this decision. ADR-0006 requires a different table, type and
helper for Stripe and poster orders; in-game cash is a game score even if both are expressed
in integer minor units.

## Decision

### `cash_movement` is the balance history

Every movement stores:

| Field                 | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `airline_id`          | The game airline whose balance moved                                     |
| `amount_minor`        | Signed delta in integer minor units                                      |
| `cause`               | Stable cause family, initially founding, settlement or migration opening |
| `reference`           | Stable identity of that cause, such as the flight UUID                   |
| `balance_after_minor` | The resulting materialised balance                                       |
| `occurred_at`         | Game time for simulation causes; founding time for the opening grant     |
| `recorded_at`         | Real database time, so delayed processing remains diagnosable            |

`amount_minor`, `balance_after_minor` and `airline.cash_minor` are constrained to
JavaScript's safe-integer range. Drizzle reads all three in number mode, so admitting a
larger PostgreSQL `bigint` would make an apparently exact reconciliation lossy at the server
boundary.

Rows are append-only. An attempted update is refused by the database; a correction is a new
compensating movement with its own cause and reference. Deleting an airline deliberately
cascades its movements, matching world reset semantics in ADR-0005. Ordinary cessation
retains the airline and ledger as read-only history (ADR-0018). Deleting an isolated
movement while its airline survives fails reconciliation.

### One transaction service changes the balance

`moveAirlineCash` is the only application code that writes `cash_minor`. Its caller supplies
the transaction containing the cause. The service:

1. locks the airline row `FOR UPDATE`, serialising different movements for one balance;
2. finds or inserts the unique logical cause;
3. computes and records the resulting safe-integer balance;
4. updates the materialised airline balance; and
5. returns whether the movement was applied or was an identical replay.

It does not open its own transaction. Founding, event handling and future finance commands
must own the wider transaction so their domain row and cash movement cannot commit apart.
A replay using the same cause and reference but different airline, amount or occurrence time
is treated as ledger corruption and fails rather than silently accepting whichever arrived
first.

### Constraints, not timing, provide idempotency and reconciliation

`(cause, reference)` is unique across the movement table. For flight settlement the
reference is the globally unique flight id, so sequential replay and concurrent delivery
cannot pay it twice. The application lookup provides the clean “already applied” result;
`ON CONFLICT` closes the race and the unique constraint remains the authority.

Deferred PostgreSQL constraint triggers compare `airline.cash_minor` with
`sum(cash_movement.amount_minor)` at transaction commit. Deferral matters: the movement and
balance are separate statements inside one transaction and neither write order should
create a false intermediate failure. A direct balance update without a movement, or a
movement without its balance update, cannot commit.

`balance_after_minor` is retained even though the amount fold is sufficient to reconstruct
cash. It makes each step independently checkable and pinpoints the first drifting movement
instead of reporting only that the final total is wrong.

### Existing and new causes

- **Airline founding** inserts the airline at zero and posts its versioned opening grant as
  `airline_founding`, referenced by the new airline id, before the founder hub transaction
  commits.
- **Player rebrand** records the identity change and posts its configured price as
  `airline_rebrand`, referenced by that event id, before the new identity becomes visible
  (ADR-0017).
- **Flight settlement** writes `flight_result` and posts its net as `flight_settlement`,
  referenced by the flight id, before marking the flight arrived.
- **Migration** cannot reconstruct causes that predate the ledger honestly. Each existing
  airline receives one `migration_opening_balance` movement equal to its balance at migration
  time. This makes the fold exact from deployment onward without pretending historic flights
  were individually captured.

The cause enum expands only when a real balance-changing domain lands. AIR-06 does not invent
the category, counterparty and dimensional fields owned by M8-01.

## Consequences

### What this makes easier

- A current balance always has a complete causal path from the AIR-06 migration onward.
- Founding and flight settlement cannot commit their domain result without the matching cash
  movement.
- Retried causes are idempotent by a named database constraint rather than an application
  race check.
- M8-01 can build statements from an already-reconciling source instead of repairing an
  unexplained balance first.
- Support can distinguish game occurrence time from delayed real processing time.
- AIR-10 exposes that history from the admin console beside airline identity, standing and
  current or historical routes. The projection is paginated and read-only; it does not add a
  cash-adjustment cause or a direct balance edit. A future correction remains a new,
  explicitly named compensating movement through this decision's transaction boundary.

### What this makes harder

- Every new game-cash cause needs an explicit enum addition and must supply a stable
  idempotency reference and occurrence time.
- Movements for one airline serialize on its row. That is deliberate correctness pressure;
  the lock is short and airline balances do not need high-frequency parallel writes.
- Historical activity before the migration is one opening snapshot, not an itemised ledger.

## Alternatives considered

| Option                                          | Why not                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Keep only `flight_result` as the explanation    | Founding and future loans, leases or interest have no flight, and no constraint connects result to cash.  |
| Store deltas without the resulting balance      | The final fold can drift without showing which movement first disagreed with the materialised balance.    |
| Check for a cause before inserting              | Two workers can both pass the check; the unique constraint must decide.                                   |
| Give each subsystem permission to update cash   | The fifth path will omit a field or transaction boundary and make the ledger stop reconciling.            |
| Build M8-01's full double-entry P&L now         | Categories and dimensions are a larger accounting model explicitly outside AIR-06.                        |
| Reconstruct historic movements from result rows | Opening cash and any uncaptured update remain unknown; fabricated history is worse than a named snapshot. |
| Reuse this table/helper for Stripe transactions | Violates ADR-0006 and mixes a game score with regulated real money.                                       |

## Revisit when

- M8-01 introduces transaction/category/counterparty and dimensional P&L rows;
- M8-02 resolves the game's accounting and display currency; or
- write volume demonstrates that the per-airline row lock is material rather than merely
  measurable.
