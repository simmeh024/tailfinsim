# Aircraft acquisition (M4-04)

Tailfin has three server-owned acquisition paths behind
`POST /api/fleet/acquisitions`:

| Path     |              Cash due on acceptance | Availability                                    | Delivery                                  |
| -------- | ----------------------------------: | ----------------------------------------------- | ----------------------------------------- |
| Lease    | two monthly payments as the deposit | orderable and used-only types with a lease term | immediate                                 |
| Buy used |          the listing's asking price | one locked, available server listing            | immediate at the listing's airport        |
| Buy new  |     list price plus factory options | types currently orderable in the world's era    | base lead plus option weeks, in real time |

Every request carries a UUID `requestId`. It becomes the `aircraft_order.id` and the AIR-06
cash-movement reference, so retrying a timed-out request returns the first order and cannot
charge or deliver twice. The authenticated session and active-world header determine the
airline; the body never accepts an airline or world id. Restricted and ceased airlines may
read `GET /api/fleet/orders` but cannot create another commitment.

## Stored facts

`aircraft_order` is the immutable commercial/build snapshot: acquisition kind, pinned
catalogue version, designation, canonical option ids, cached effective spec, amount charged,
lease rate, base/option lead, delivery airport and the real order/delivery instants.

`airframe` is the physical aircraft created from that snapshot. It carries registration,
options, cabin and livery ids, effective spec, hours, cycles, ownership, prior-owner history
and the airport where it entered the world. Later position remains derived from completed
flights; delivery is merely the starting point for that fold.

`used_aircraft_listing` is server-authored. M4-04 locks and consumes a row but does not let a
client submit its age, price or configuration. This is the acceptance guarantee that a used
aircraft arrives with the prior owner's configuration intact. M4-05 owns generation,
depreciation, refresh and withdrawal of those listings.

The order, explaining cash movement, used-listing claim and any immediate airframe are one
database transaction. An acquisition that would leave the airline below zero rolls back all
of them.

## The two time domains

Era eligibility and the cash movement's `occurred_at` use the world's game clock. Factory
lead time does not: §7.2 says weeks of **real time**, so `aircraft_order.delivery_at` is a
wall-clock instant unaffected by world speed.

Only the Worker sweeps due new orders. It claims one pending order at a time with
`FOR UPDATE SKIP LOCKED`, updates it to delivered and inserts its airframe in the same
transaction. `airframe.source_order_id` is unique, so a rolling handover between two Workers
cannot deliver the same aircraft twice. Production still has no Worker; pending production
orders therefore cannot be enabled until OPS-12 supplies one.

## Authored v1 terms

The design gives one concrete lease term: Appendix B.4's ATR 72 deposit is $170k for two
months, so v1 stores $85k/month. Other v1 lease rates remain the documented commercial
approximation. The design specifies weeks but no per-type standard factory schedule, so v1
authors a four-week base on the pinned aircraft type; each factory option's already-versioned
lead weeks are added to it.

M4-04 stores the lease's full monthly rate on the order from day one and charges the defined
deposit. It does not invent a billing cadence the design has not chosen: recurring lease
settlement needs the M8 accounting/calendar decision before it can create authoritative
ledger periods. Until that lands, the monthly obligation is visible and durable but is not
yet periodically debited.

## Deliberate milestone boundaries

- M4-05: rolling used inventory, depreciation, unusual-configuration discounts and removal.
- M4-06: maintenance programmes and their effects.
- M4-07: the player fleet/order list and airframe detail UI.
- Peer-to-peer used-aircraft trading remains Post-MVP/out of scope.
