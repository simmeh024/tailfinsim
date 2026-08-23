-- tailfin:migration-strategy expand
-- Crew: bases, pools by rank and family, and type conversions (M5-01, section 9.2).
--
-- Additive throughout. Three new enums, three new cash_movement_cause values and
-- three new tables. Nothing existing changes type, loses a default or gains a
-- NOT NULL, so the previous release keeps working against the result -- it simply
-- never reads any of it.
--
-- Rolling-compatible in both directions:
--
--   * old code, new schema: the crew tables are empty and unreferenced; no query
--     the previous build issues mentions them.
--   * new code, old schema: refused by the deploy's migration preflight before
--     the service restarts, which is the point of running it first.
--
-- The three ADD VALUE statements are safe inside the migration's transaction on
-- PostgreSQL 12+ because nothing here *uses* the new labels -- the same shape
-- 0030 used for 'maintenance_check'. A row citing them can only be written by the
-- build that comes with them.
--
-- crew_pool carries its own arithmetic in check constraints rather than trusting
-- the writer: headcount cannot go negative, and unavailable can never exceed it.
-- A pool with more people in a classroom than on strength is not a state any
-- caller should be able to reach, and a bug that produced it would otherwise show
-- up much later as crew who cannot be rostered and cannot be found.

CREATE TYPE "public"."crew_base_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."crew_conversion_status" AS ENUM('in_training', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."crew_rank" AS ENUM('cadet', 'first_officer', 'senior_first_officer', 'captain', 'training_captain', 'cabin_crew', 'senior_cabin_crew', 'purser', 'cabin_service_manager');--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'crew_base_opening' BEFORE 'flight_settlement';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'crew_hiring' BEFORE 'flight_settlement';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'crew_conversion' BEFORE 'flight_settlement';--> statement-breakpoint
CREATE TABLE "crew_base" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"airport_icao" text NOT NULL,
	"status" "crew_base_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_base_airline_airport_key" UNIQUE("airline_id","airport_icao")
);
--> statement-breakpoint
CREATE TABLE "crew_conversion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew_base_id" uuid NOT NULL,
	"from_family" text NOT NULL,
	"to_family" text NOT NULL,
	"rank" "crew_rank" NOT NULL,
	"heads" integer NOT NULL,
	"status" "crew_conversion_status" DEFAULT 'in_training' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completes_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_conversion_heads_positive" CHECK ("crew_conversion"."heads" > 0),
	CONSTRAINT "crew_conversion_families_differ" CHECK ("crew_conversion"."from_family" <> "crew_conversion"."to_family"),
	CONSTRAINT "crew_conversion_completes_after_start" CHECK ("crew_conversion"."completes_at" > "crew_conversion"."started_at")
);
--> statement-breakpoint
CREATE TABLE "crew_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew_base_id" uuid NOT NULL,
	"family" text NOT NULL,
	"rank" "crew_rank" NOT NULL,
	"headcount" integer DEFAULT 0 NOT NULL,
	"unavailable" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_pool_base_family_rank_key" UNIQUE("crew_base_id","family","rank"),
	CONSTRAINT "crew_pool_headcount_nonneg" CHECK ("crew_pool"."headcount" >= 0),
	CONSTRAINT "crew_pool_unavailable_within_headcount" CHECK ("crew_pool"."unavailable" >= 0 AND "crew_pool"."unavailable" <= "crew_pool"."headcount")
);
--> statement-breakpoint
ALTER TABLE "crew_base" ADD CONSTRAINT "crew_base_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_base" ADD CONSTRAINT "crew_base_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_base" ADD CONSTRAINT "crew_base_airport_icao_airport_icao_code_fk" FOREIGN KEY ("airport_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_conversion" ADD CONSTRAINT "crew_conversion_crew_base_id_crew_base_id_fk" FOREIGN KEY ("crew_base_id") REFERENCES "public"."crew_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_pool" ADD CONSTRAINT "crew_pool_crew_base_id_crew_base_id_fk" FOREIGN KEY ("crew_base_id") REFERENCES "public"."crew_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_base_airline_idx" ON "crew_base" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "crew_base_world_idx" ON "crew_base" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "crew_conversion_base_idx" ON "crew_conversion" USING btree ("crew_base_id");--> statement-breakpoint
CREATE INDEX "crew_conversion_due_idx" ON "crew_conversion" USING btree ("status","completes_at");--> statement-breakpoint
CREATE INDEX "crew_pool_base_idx" ON "crew_pool" USING btree ("crew_base_id");