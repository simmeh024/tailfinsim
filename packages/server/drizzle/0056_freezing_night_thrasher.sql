-- tailfin:migration-strategy expand
-- Loans and credit standing (M8-06, §13).
--
-- Two new tables and two new enum values. Additive throughout, so the previous
-- release runs against the result unchanged: it knows neither table, and an enum
-- gaining a value breaks nothing that does not write it.
--
-- No data migration accompanies the new enum values, deliberately. CLAUDE.md
-- records that trap twice over: ADR-0016 applies every pending migration in one
-- transaction, so a data statement naming a value the same transaction just
-- added is refused on a virgin database ("unsafe use of new value ... of enum
-- type cash_movement_cause") while passing locally, where the value committed
-- months ago. Nothing here writes `loan_draw` or `debt_draw`; the first of each
-- is written by a player drawing a loan, long after this has committed.
--
-- `loan.secured_airframe_id` carries no foreign key on purpose — an airframe can
-- leave the fleet, and a loan is a financial record that must outlive the asset
-- it was written against.

ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'loan_draw';--> statement-breakpoint
ALTER TYPE "public"."ledger_category" ADD VALUE 'debt_draw' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "credit_standing" (
	"airline_id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"tier" text DEFAULT 'startup' NOT NULL,
	"good_reviews" integer DEFAULT 0 NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_standing_good_reviews_nonnegative" CHECK ("credit_standing"."good_reviews" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"instrument" text NOT NULL,
	"principal_minor" bigint NOT NULL,
	"outstanding_minor" bigint NOT NULL,
	"annual_rate_bps" integer NOT NULL,
	"term_months" integer NOT NULL,
	"tier_at_draw" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"secured_airframe_id" uuid,
	"drawn_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_principal_positive" CHECK ("loan"."principal_minor" > 0),
	CONSTRAINT "loan_outstanding_nonnegative" CHECK ("loan"."outstanding_minor" >= 0),
	CONSTRAINT "loan_term_positive" CHECK ("loan"."term_months" > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_standing" ADD CONSTRAINT "credit_standing_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_standing" ADD CONSTRAINT "credit_standing_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan" ADD CONSTRAINT "loan_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_standing_world_id_idx" ON "credit_standing" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "loan_airline_id_idx" ON "loan" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "loan_world_id_idx" ON "loan" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "loan_airline_status_idx" ON "loan" USING btree ("airline_id","status");