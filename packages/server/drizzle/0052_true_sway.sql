-- tailfin:migration-strategy expand
-- Ground handling gets its money and its alternative (M5-06, §9.3).
--
-- Additive only: three new `cash_movement_cause` values, one new column on
-- `ground_contract`, and one new table. The previous release runs against the
-- result unchanged -- it never writes the new causes, reads `ground_contract`
-- by name rather than `select *`, and has never heard of `ground_self_handling`.
--
-- The new enum values are added and **not used** in this migration. That matters
-- under ADR-0016, which runs the whole batch in one transaction: PostgreSQL
-- refuses to *use* a value an `ALTER TYPE ... ADD VALUE` introduced in the same
-- transaction ("unsafe use of new value"), and a data statement naming one here
-- would fail the deploy while passing against a database that already had them.
--
-- ## Why `ground_self_handling` is its own table
--
-- A line an airline handles itself has **no vendor grade**, so putting one in
-- `ground_contract` would mean either a null in a column the previous release
-- reads as non-null -- breaking its `/api/ground/:icao` response for exactly the
-- airlines that had adopted the feature -- or storing a grade that is a lie. A
-- table the previous release has never heard of breaks nothing at all.
--
-- The cross-table rule (a vendor and your own people may not both work one line)
-- cannot be a constraint, so both writers take
-- `pg_advisory_xact_lock(hashtext(world:icao:line))` and close the other kind
-- inside it. `ground/contracts.test.ts` is what proves that, not this file.
--
-- ## `term_start` is deliberately not backfilled
--
-- It is game time and `signed_at` is wall clock, which is why a second column was
-- needed rather than reusing the first: pro-rating a penalty across a term needs
-- both ends on the same clock, and mixing them made a 90-day term look decades
-- long. A contract signed before this release has no `volume_commitment` and no
-- `penalty_minor` either, so inventing a start for it would change nothing except
-- to imply an agreement nobody made. Null therefore means *signed before terms
-- were priced*: such a row still lapses at its `term_end`, and costs nothing to
-- leave and nothing at expiry, which is the truthful answer.

ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'ground_contract_penalty' BEFORE 'admin_adjustment';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'ground_volume_shortfall' BEFORE 'admin_adjustment';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'ground_self_handling_payroll' BEFORE 'admin_adjustment';--> statement-breakpoint
CREATE TABLE "ground_self_handling" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"airport_icao" text NOT NULL,
	"service_line" text NOT NULL,
	"headcount" integer NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ground_self_handling_headcount_positive" CHECK ("ground_self_handling"."headcount" > 0)
);
--> statement-breakpoint
ALTER TABLE "ground_contract" ADD COLUMN "term_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ground_self_handling" ADD CONSTRAINT "ground_self_handling_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ground_self_handling" ADD CONSTRAINT "ground_self_handling_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ground_self_handling_active_line_key" ON "ground_self_handling" USING btree ("airline_id","airport_icao","service_line") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "ground_self_handling_payroll_idx" ON "ground_self_handling" USING btree ("world_id","status");