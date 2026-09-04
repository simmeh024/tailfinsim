# ADR-0026: A span inside the world is measured on the world's clock

- **Status:** Accepted
- **Date:** 2026-09-04
- **Scope:** TIME-01 (#935). Amends design doc §7.2 and supersedes the wall-clock half of
  [ADR-0019](0019-web-worker-boundary.md) §4.

## Context

A Tailfin world runs its own calendar: `gameTime = epoch + speed × (realNow − launchDate)`, and
almost everything a player can observe is dated in it. Era gating, a cash movement's
`occurred_at`, the used market's generation and expiry, a maintenance check's downtime, a crew
conversion, a duty period and its rest, a morale review, a ground contract's term, schedule
materialisation and every `world_event.fire_at` are all game instants. The consequence a player
feels is uniform: a world at 4× does all of it twice as fast in real time as one at 2×.

Factory aircraft delivery was the single exception. §7.2 described a new order's delivery slot as
_"weeks out (real time)"_, so `aircraft_order.ordered_at`, `delivery_at` and `delivered_at` were
wall-clock instants, the Worker's delivery sweep compared `delivery_at` against `Date.now()`, and
`airframe.delivered_at` had to be pushed through `gameTime()` in `fleet.ts` before the fleet page
could compare it with anything else it showed. The exception was load-bearing enough to be written
down in four places and defended in about eight source comments.

Two things were wrong with it.

**It was visible, and it was two calendars at once.** FLEET-MARKET rendered
`10 real weeks · est. 8 Nov 2026` and an _Accepted_ date taken from the wall clock, on a page whose
header carries the world clock reading a different year. Nothing told the player which of the two
dates the aeroplane would arrive on, and there is no reading of the interface under which both are
the world they are playing in.

**It did not scale with speed.** World speed is the one dial §22.2 gives an operator, and its
meaning is "everything inside this world happens this much faster". An aircraft order that ignored
it meant a 4× world reached its second aeroplane at the same real moment a 1× world did, while
reaching every other milestone twice as fast — so the faster world was, specifically and only, worse
at buying aircraft.

The original reasoning was not silly. A factory slot is a real-world industrial commitment, and
keeping it in wall-clock weeks gave a fixed real-time cost to the largest purchase in the game. But
that is a balance argument (how long should an aircraft take?) dressed as a time-domain one (which
clock is the span on?), and it was answered in the wrong place: lead weeks are authored per type and
per option, so the balance question already has a dial that does not require a second clock.

## Decision

**An aircraft order's clock is the world's clock.** `base_lead_time_weeks + option_lead_time_weeks`
are weeks of the world's calendar.

- `aircraft_order.ordered_at`, `delivery_at` and `delivered_at` are game instants. So are
  `airframe.delivered_at` and `used_aircraft_listing.sold_at`, the last of which had a listing
  appearing and expiring on the world's calendar but being sold on the wall clock.
- The quote's `quotedAt` and `estimatedDeliveryAt` are game instants, so the client may subtract
  them. Previously one was real and the other real-plus-real-weeks; they agreed, and they agreed
  with nothing else on the page.
- `deliverDueAircraftOrders` takes a required `gameNow` and compares `delivery_at` against it. The
  parameter's `= new Date()` default is **removed**, not retargeted: a default that reads the wall
  clock would be a silent cross-domain comparison, and no type would catch it.
- `fleet.ts` subtracts `airframe.delivered_at` from `gameNow` directly. The `gameTime()` call is
  deleted rather than left harmless, because a conversion applied to something already converted is
  the kind of line that survives a decade.

**Delivery stays a scanned column, not a queued event.** ADR-0019 §4 justified the real
`delivery_at` as a deliberate extension of the database-as-channel; now that the instant is game
time it _could_ be a `world_event.fire_at`, and it is deliberately not. The order row already holds
the commitment, its `(world_id, status, delivery_at)` due index, and the immutability trigger that
admits only `pending → delivered`. A queued event would put the same promise in a second place, need
its own handler in the SCALE-06 preflight registry, and gain nothing: the sweep is one indexed read
per world per tick.

**Existing rows are converted, not reinterpreted.** Migration `0050` rewrites the five columns
through each world's own clock, so a pending order arrives at the real instant it was already
promised. For those legacy rows only, `delivery_at − ordered_at` is the game span that the same real
wait now buys and no longer equals the stored lead weeks. That is a legacy arithmetic artefact and
is documented as one; the lead weeks are the immutable commercial fact the order was priced under
and are not rewritten to make the subtraction tidy.

## Consequences

**A world at 4× buys aircraft twice as fast in real time as one at 2×.** That is the point, and it
is also a balance change: on the flagship world's 2× clock the authored four-week base is now two
real weeks. Retuning that is an author-time change to `aircraft_type.base_delivery_lead_weeks` in a
new catalogue version, which is where a "how long should this take" question belongs.

**The migration's window is honest but not risk-free.** It is an expand migration — no schema
changes, so the previous release keeps serving — but a previous-release _Worker_ would compare the
converted instants against the wall clock. On a world whose calendar has not yet caught up with
reality, converted instants sit in the past, and that Worker would deliver pending orders early.
Production has no Worker at all (OPS-12) and serves the holding page, and the dev Worker's own deploy
refuses to run while a migration is pending, so the window is the gap between the web node's deploy
and the worker node's. Deploy web, then worker.

**One fewer thing to know.** "Which clock is this on?" now has one answer inside a world and one
outside it. The real-time instants that remain are the ones that are genuinely not in a world:
sessions and their expiry, admin audit stamps, `airframe.created_at`, ops heartbeats and build
metadata, the engine's own tick interval and health lateness, and M8-02's FX refresh — an exchange
rate is a real-world quantity and stays global and real, deliberately.

**What this does not change.** Money is still USD integer minor units; the economy is still a
pinned `EconomyConfig` row; the catalogue's era dates were always game time; and the Worker is still
the only process that materialises a delivery (ADR-0019's ownership rule is untouched — only its
choice of clock is).
