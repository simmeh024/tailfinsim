-- tailfin:migration-strategy expand
-- Two new cash_movement_cause values for the executive floor and office
-- unlocks. Purely additive enum values (ADD VALUE), used only by the new
-- code that ships with them; the previous release writes neither.
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'executive_floor' BEFORE 'admin_adjustment';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'executive_office' BEFORE 'admin_adjustment';