-- tailfin:migration-strategy expand
--
-- M8-07 (#79): §13.4's interest accrual and §13.5's default ladder.
--
-- Additive throughout. Every column is nullable or defaulted, and the previous
-- release keeps working against the result: it writes no `loan_interest`
-- movement, leaves `arrears_minor` at 0 and `default_stage` at 'none', and never
-- reads `repossessed_at` — so a world served by the old build behaves exactly as
-- it does today while this schema is in place.
--
-- The two nullable timestamps mean **never**, not the epoch:
-- `loan.interest_accrued_through_at` null is a loan no sweep has reached (read
-- as `drawn_at`, or the first tick would bill decades of interest), and
-- `airframe.repossessed_at` null is an aeroplane the airline still has.

ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'loan_interest';--> statement-breakpoint
ALTER TABLE "airframe" ADD COLUMN "repossessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_standing" ADD COLUMN "default_stage" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_standing" ADD COLUMN "stage_entered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_standing" ADD COLUMN "cure_by_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "interest_accrued_through_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loan" ADD COLUMN "arrears_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_arrears_nonnegative" CHECK ("loan"."arrears_minor" >= 0);