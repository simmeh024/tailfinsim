-- tailfin:migration-strategy expand
-- The aircraft acquisition clock becomes game time (TIME-01, ADR-0026).
--
-- Data only: no table, column, type, index or constraint changes, so the
-- previous release runs against the result unchanged. What changes is the
-- *domain* of five existing timestamptz columns -- from wall clock to the owning
-- world's own calendar -- which no DDL can express and only this comment and the
-- ADR record.
--
-- Each value is pushed through its world's clock, `epoch + speed x (t - launch_date)`,
-- the same arithmetic `gameTime()` performs in @tailfin/sim. So a pending factory
-- order still arrives at the real instant it was promised: only the calendar it
-- is expressed in moves. The conversion is monotonic (speed_multiplier > 0 is a
-- world check constraint), so `aircraft_order_delivery_not_before_order` and the
-- listing's `built_at <= available_at` both survive it.
--
-- speed_multiplier is numeric and `interval * numeric` is not a Postgres
-- operator; the double-precision cast is required, not decorative.
--
-- One consequence, for converted rows only: `delivery_at - ordered_at` is now the
-- game span that the same real wait buys, so it no longer equals
-- `base_lead_time_weeks + option_lead_time_weeks`. Those weeks are the immutable
-- commercial fact the order was priced under and are deliberately left alone.
--
-- The honest risk. A *previous-release* Worker would compare these converted
-- instants against the wall clock, and on a world whose calendar has not yet
-- caught up with reality they sit in the past -- so it would deliver pending
-- orders early. Production has no Worker (OPS-12) and the worker node's own
-- deploy refuses to run with a migration pending, so the window is the gap
-- between deploying web and deploying the worker. Deploy web, then the worker.

-- `aircraft_order_delivery_only` admits only status/delivered_at changes, so the
-- guard comes off for exactly this correction and goes straight back on. Same
-- shape as migration 0028's one-row lease correction.
DROP TRIGGER aircraft_order_delivery_only ON aircraft_order;--> statement-breakpoint
UPDATE aircraft_order AS o
SET ordered_at = w.epoch + (o.ordered_at - w.launch_date) * w.speed_multiplier::double precision,
    delivery_at = w.epoch + (o.delivery_at - w.launch_date) * w.speed_multiplier::double precision,
    delivered_at = CASE
      WHEN o.delivered_at IS NULL THEN NULL
      ELSE w.epoch + (o.delivered_at - w.launch_date) * w.speed_multiplier::double precision
    END
FROM world AS w
WHERE w.id = o.world_id;--> statement-breakpoint
CREATE TRIGGER aircraft_order_delivery_only
  BEFORE UPDATE ON aircraft_order
  FOR EACH ROW EXECUTE FUNCTION aircraft_order_delivery_only();--> statement-breakpoint

-- The airframe's own arrival date, carried from the order. `built_at` beside it
-- was already game time, and `created_at` is the row's wall-clock audit stamp and
-- is deliberately not touched.
UPDATE airframe AS f
SET delivered_at = w.epoch + (f.delivered_at - w.launch_date) * w.speed_multiplier::double precision
FROM world AS w
WHERE w.id = f.world_id;--> statement-breakpoint

-- A listing that appeared and expires on the world's calendar was being sold on
-- the wall clock. `available_at` is left alone: M4-05's generator has always
-- written the world's `gameNow` into it, and the only rows that could have taken
-- its `now()` default are hand-written ones.
UPDATE used_aircraft_listing AS l
SET sold_at = w.epoch + (l.sold_at - w.launch_date) * w.speed_multiplier::double precision
FROM world AS w
WHERE w.id = l.world_id
  AND l.sold_at IS NOT NULL;
