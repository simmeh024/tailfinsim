-- tailfin:migration-strategy expand
-- Maintenance: hours, cycles, A/C/D checks and grounding (M4-06, section 7.3).
--
-- Additive. One new enum, one new cash_movement_cause value, four new columns on
-- airframe (three nullable, one defaulted), one index and two checks. No existing
-- column changes type or loses a default.
--
-- Rolling-compatible in both directions:
--
--   * airframe.status has DEFAULT in_service, so the previous build INSERTs that
--     omit it stay valid while this one rolls out;
--   * maintenance_state is nullable and is read as "every tier last completed at
--     the hours this airframe has now". That reading is load-bearing, not a
--     convenience: treating a NULL as "last checked at hour zero" would make every
--     airframe delivered before this migration tens of thousands of hours overdue,
--     and the first worker tick after the deploy would ground an entire live fleet
--     for maintenance nobody had deferred. A fleet is not punished for a schema
--     change.
--
-- ADD VALUE on cash_movement_cause is why this is expand rather than merely
-- additive: the previous build has no maintenance_check case and never writes one,
-- and reading a cause it does not know cannot happen because it never queries for
-- one. The new value sits before flight_settlement so the enum stays in the order
-- a ledger reads.
--
-- The in_check constraint keeps a running check whole -- a tier and a finish time
-- together, or neither -- so the completion sweep can never meet a row it
-- recognises as running but cannot finish.
--
-- No trigger. An airframe is mutable by design: it accrues hours, enters and
-- leaves checks, and is grounded and released. It is not an immutable fact like an
-- aircraft_type or an economy_config row.

CREATE TYPE "public"."airframe_status" AS ENUM('in_service', 'in_check', 'grounded');--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'maintenance_check' BEFORE 'flight_settlement';--> statement-breakpoint
ALTER TABLE "airframe" ADD COLUMN "maintenance_state" text;--> statement-breakpoint
ALTER TABLE "airframe" ADD COLUMN "status" "airframe_status" DEFAULT 'in_service' NOT NULL;--> statement-breakpoint
ALTER TABLE "airframe" ADD COLUMN "check_tier" text;--> statement-breakpoint
ALTER TABLE "airframe" ADD COLUMN "check_completes_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "airframe_check_due_idx" ON "airframe" USING btree ("world_id","status","check_completes_at");--> statement-breakpoint
ALTER TABLE "airframe" ADD CONSTRAINT "airframe_check_tier_valid" CHECK ("airframe"."check_tier" IS NULL OR "airframe"."check_tier" IN ('a', 'c', 'd'));--> statement-breakpoint
ALTER TABLE "airframe" ADD CONSTRAINT "airframe_in_check_has_terms" CHECK (("airframe"."status" = 'in_check'
             AND "airframe"."check_tier" IS NOT NULL AND "airframe"."check_completes_at" IS NOT NULL)
          OR ("airframe"."status" <> 'in_check'
             AND "airframe"."check_tier" IS NULL AND "airframe"."check_completes_at" IS NULL));