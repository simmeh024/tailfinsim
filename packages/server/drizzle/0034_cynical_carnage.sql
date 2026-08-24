-- tailfin:migration-strategy expand
--
-- M5-02. Three new cash_movement_cause values: crew payroll, the crew base
-- monthly overhead, and the hotels and deadhead seats a rotation that ends
-- away from base owes.
--
-- Additive and nothing else. No table, column, index or default changes, so the
-- previous release keeps reading and writing every cause it already knew; it
-- simply never writes these three.

ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'crew_payroll' BEFORE 'admin_adjustment';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'crew_base_overhead' BEFORE 'admin_adjustment';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'crew_positioning' BEFORE 'admin_adjustment';