# Aircraft acquisition (M4-04)

Tailfin has three server-owned acquisition paths behind
`POST /api/fleet/acquisitions`:

| Path     |              Cash due on acceptance | Availability                                    | Delivery                                 |
| -------- | ----------------------------------: | ----------------------------------------------- | ---------------------------------------- |
| Lease    | two monthly payments as the deposit | orderable and used-only types with a lease term | immediate                                |
| Buy used |          the listing's asking price | one locked, available server listing            | immediate at the listing's airport       |
| Buy new  |     list price plus factory options | types currently orderable in the world's era    | base lead plus option weeks of game time |

Every request carries a UUID `requestId`. It becomes the `aircraft_order.id` and the AIR-06
cash-movement reference, so retrying a timed-out request returns the first order and cannot
charge or deliver twice. The authenticated session and active-world header determine the
airline; the body never accepts an airline or world id. Restricted and ceased airlines may
read `GET /api/fleet/orders` but cannot create another commitment.

`POST /api/fleet/acquisition-quotes` is the non-mutating configurator contract for new and
lease paths. It accepts only the acquisition kind, type designation and canonical option ids.
The quote and mutation call the same internal resolver for era eligibility, commercial terms,
option validation, effective specification, charge and lead time; the UI never receives a
formula to reproduce. Quote cash and delivery are informational snapshots. The mutation
reloads and locks the airline and independently validates funds before writing.

## Stored facts

`aircraft_order` is the immutable commercial/build snapshot: acquisition kind, pinned
catalogue version, designation, canonical option ids, cached effective spec, amount charged,
lease rate, base/option lead, delivery airport and the game-time order/delivery instants.

`airframe` is the physical aircraft created from that snapshot. It carries registration,
options, cabin and livery ids, effective spec, hours, cycles, ownership, prior-owner history
and the airport where it entered the world. Later position remains derived from completed
flights; delivery is merely the starting point for that fold.

`used_aircraft_listing` is server-authored. M4-04 locks and consumes a row but does not let a
client submit its age, price or configuration. This is the acceptance guarantee that a used
aircraft arrives with the prior owner's configuration intact. Generation, depreciation,
refresh and withdrawal are M4-05's, and are documented in
[`used-aircraft-market.md`](used-aircraft-market.md).

M4-05 adds `built_at` to the listing, and it travels with `hours` and `cycles` through the
order onto the airframe — so a bought used aircraft keeps its age as well as its build.
`built_at` is null for a lease and for a factory order, both of which have no previous
owner's build date to inherit.

The order, explaining cash movement, used-listing claim and any immediate airframe are one
database transaction. An acquisition that would leave the airline below zero rolls back all
of them.

## One time domain

Every instant on an order is the world's own calendar: era eligibility, the cash movement's
`occurred_at`, `ordered_at`, `delivery_at`, `delivered_at`, the airframe's `delivered_at` and a
claimed listing's `sold_at`. A lead time is **game** weeks, so a world at 4× builds the same
aeroplane in half the real time of a world at 2×.

This was not always so. §7.2 called a delivery slot _"weeks out (real time)"_, and until TIME-01
`delivery_at` was a wall-clock instant unaffected by world speed — the one span inside a world
that ignored the dial §22.2 exists to turn, and the reason FLEET-MARKET could print
`10 real weeks · est. 8 Nov 2026` beside a world clock reading a different year.
[ADR-0026](adr/0026-in-world-spans-are-game-time.md) records the reversal, the migration that
converted the existing rows, and the one legacy artefact it leaves: for a converted row,
`delivery_at - ordered_at` is the game span the same real wait now buys and no longer equals
`base_lead_time_weeks + option_lead_time_weeks`.

The quote is the same domain throughout — `quotedAt` and `estimatedDeliveryAt` are both game
instants, so a client may subtract them. It must not add `totalLeadTimeWeeks` to its own
`Date.now()`.

Only the Worker sweeps due new orders. It claims one pending order at a time with
`FOR UPDATE SKIP LOCKED`, updates it to delivered and inserts its airframe in the same
transaction. `airframe.source_order_id` is unique, so a rolling handover between two Workers
cannot deliver the same aircraft twice. `deliverDueAircraftOrders` takes a required `gameNow`
with no default: the `new Date()` it used to default to would now be a silent cross-domain
comparison that no type would catch. Production still has no Worker; pending production orders
therefore cannot be enabled until OPS-12 supplies one. The dev Worker performs this sweep before
draining that world's game-time events and exposes cumulative `aircraftDeliveries` and
`aircraftDeliveryErrors` counters in its loopback health snapshot.

## Authored v1 terms

The design gives one concrete lease term: Appendix B.4's ATR 72 deposit is $170k for two
months, so v1 stores $85k/month. Other v1 lease rates remain the documented commercial
approximation. The design specifies weeks but no per-type standard factory schedule, so v1
authors a four-week base on the pinned aircraft type; each factory option's already-versioned
lead weeks are added to it. Those weeks are game weeks since TIME-01, which on the flagship
world's 2× clock is two real weeks for the base — a balance consequence, and one that belongs to
`aircraft_type.base_delivery_lead_weeks` in a new catalogue version rather than to a second clock.

M4-04 stored the lease's full monthly rate on the order from day one and charged the defined
deposit, and nothing charged the rate for months — so a leased aeroplane cost its deposit and
then nothing, and leasing beat buying at every fleet size. **OTHER-01 charges it.**

### Lease rent (OTHER-01)

`runLeaseRentals` (`server/src/aircraft/lease-rentals.ts`) bills every leased airframe its
`monthly_lease_rate_minor` for each game month it is held, in arrears at the first tick of the
next month, **prorated by the game time held** — an aeroplane delivered on the 28th pays three
days of its first month, and one repossessed (§13.5) stops paying at repossession. One
`aircraft_lease_rental` movement per airline per month, idempotent by
`aircraft_lease_rental:<airlineId>:<YYYY-MM>`, with a ledger line per airframe under
`lease_finance` — the category M8-01 declared and nothing had written to — so the P&L shows rent
as its own financing line, outside EBITDA. Owned and financed airframes are never billed.

**Month to month, with no term and no return.** §24 names _"lessor counterparties, lease terms
and return conditions"_ as a gap the design doc does not specify, and MARKET-05 (#1103) owns the
lessor model; rolling month to month is the reading that invents nothing, and the one the
stored data already describes (`aircraft_order` records a rate and no term).

**A worker story.** Production has no worker, so there a lease is still free after its deposit —
a dominant strategy rather than a degraded mechanic. `leaseRentalsBilled`, `leaseRentalMinor`
and `leaseErrors` are the counters. The cash runway projects the rent through the same
function the sweep bills with ([`cash-runway.md`](cash-runway.md)).

## Deliberate milestone boundaries

- M4-05: rolling used inventory, depreciation, unusual-configuration discounts and removal.
- M4-06: maintenance programmes and their effects.
- M4-07: the player fleet list and airframe detail UI, including the effective-spec
  decomposition — see [`fleet-management.md`](fleet-management.md). FLEET-MARKET now renders
  pending factory commitments from `GET /api/fleet/orders` above the catalogue.
- Peer-to-peer used-aircraft trading remains Post-MVP/out of scope.
