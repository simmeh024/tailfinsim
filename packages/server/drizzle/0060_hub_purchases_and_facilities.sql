-- tailfin:migration-strategy expand
-- Hub purchases and facilities (M7-04, App. B.5). Additive throughout, so the
-- previous release keeps working against the result:
--
--   * Five new enum values, used only by the code shipping with them.
--   * A new hub_facility table the previous release neither reads nor writes —
--     no row means no facility, the correct state for every existing hub.
--   * Three NULLABLE columns on airline_hub. Nullable is load-bearing rather
--     than lazy: the previous release's founding path inserts an airline_hub row
--     without them, so a NOT NULL here would break founding on the build that is
--     still serving while this migration runs. NULL reads as "granted before
--     M7-04" — the hub is priced at its airport's current tier and billed from
--     created_at. No backfill, for the same reason the columns are nullable:
--     a backfilled tier would be indistinguishable from a pinned one.
CREATE TYPE "public"."hub_facility_kind" AS ENUM('training_academy', 'maintenance_line', 'heavy_check', 'lounge', 'self_handling');--> statement-breakpoint
CREATE TYPE "public"."hub_tier" AS ENUM('small', 'medium', 'large', 'flagship');--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'hub_purchase' BEFORE 'ground_contract_penalty';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'hub_facility_opening' BEFORE 'ground_contract_penalty';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'hub_upkeep' BEFORE 'ground_contract_penalty';--> statement-breakpoint
ALTER TYPE "public"."ledger_category" ADD VALUE 'hub_purchase' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."ledger_category" ADD VALUE 'hub_facility' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "hub_facility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hub_id" uuid NOT NULL,
	"kind" "hub_facility_kind" NOT NULL,
	"opening_cost_minor" bigint NOT NULL,
	"annual_fee_minor" bigint NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_facility_hub_id_kind_key" UNIQUE("hub_id","kind")
);
--> statement-breakpoint
ALTER TABLE "airline_hub" ADD COLUMN "tier" "hub_tier";--> statement-breakpoint
ALTER TABLE "airline_hub" ADD COLUMN "purchase_cost_minor" bigint;--> statement-breakpoint
ALTER TABLE "airline_hub" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hub_facility" ADD CONSTRAINT "hub_facility_hub_id_airline_hub_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."airline_hub"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_facility_hub_id_idx" ON "hub_facility" USING btree ("hub_id");