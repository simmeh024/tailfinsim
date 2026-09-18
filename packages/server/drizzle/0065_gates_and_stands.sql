-- tailfin:migration-strategy expand
-- Gates and stands (M7-06, App. B.6). Additive throughout, so the previous
-- release keeps working against the result:
--
--   * Two new enum types, used only by the code shipping with them.
--   * One new cash_movement_cause and one new ledger_category. The previous
--     release never writes either and its exhaustive switches never see one,
--     because no row carrying them can exist until this release runs.
--   * A new gate_holding table the previous release neither reads nor writes.
--     No row means no lease, which is the correct state for every airline that
--     has been playing without stands — they keep flying, paying the walk-up
--     turn fee this release introduces, which is what they were effectively
--     doing for free before it.
--
-- Nothing is backfilled and nothing is made NOT NULL on an existing table, so
-- there is no rollback problem: the previous release is compatible with the
-- schema this produces, and ADR-0016's deploy deliberately leaves it serving
-- when a migration fails.
--
-- The exclusivity index is PARTIAL on purpose — see `gateHolding` in schema.ts.
-- It stops two exclusive leases racing onto one stand; the wider rule (an
-- exclusive lease over a stand somebody already holds) is two rows and belongs
-- in the handler, which is where it is.
CREATE TYPE "public"."gate_contract" AS ENUM('common_use', 'preferential', 'exclusive');--> statement-breakpoint
CREATE TYPE "public"."stand_kind" AS ENUM('contact_gate', 'remote_stand', 'overnight_parking', 'cargo_stand', 'maintenance_stand');--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'gate_lease';--> statement-breakpoint
ALTER TYPE "public"."ledger_category" ADD VALUE 'gate_lease' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "gate_holding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"airport_icao" text NOT NULL,
	"position" text NOT NULL,
	"kind" "stand_kind" NOT NULL,
	"contract" "gate_contract" NOT NULL,
	"annual_fee_minor" bigint NOT NULL,
	"leased_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_holding_world_airport_position_airline_key" UNIQUE("world_id","airport_icao","position","airline_id"),
	CONSTRAINT "gate_holding_contract_is_a_lease" CHECK ("gate_holding"."contract" <> 'common_use')
);
--> statement-breakpoint
ALTER TABLE "gate_holding" ADD CONSTRAINT "gate_holding_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_holding" ADD CONSTRAINT "gate_holding_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_holding" ADD CONSTRAINT "gate_holding_airport_icao_airport_icao_code_fk" FOREIGN KEY ("airport_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gate_holding_world_airport_idx" ON "gate_holding" USING btree ("world_id","airport_icao");--> statement-breakpoint
CREATE INDEX "gate_holding_world_airline_idx" ON "gate_holding" USING btree ("world_id","airline_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_holding_one_exclusive_per_stand_idx" ON "gate_holding" USING btree ("world_id","airport_icao","position") WHERE "gate_holding"."contract" = 'exclusive';