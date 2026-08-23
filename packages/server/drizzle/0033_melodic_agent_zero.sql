-- tailfin:migration-strategy expand
--
-- M5-02, crew duty state. One new table, two new enums, two new nullable
-- columns on flight and two defaulted columns on crew_pool. Every new check
-- holds for the rows already there, because both crew_pool columns default to
-- 0. The previous release does not know any of it exists and never writes to
-- it, so it keeps serving unchanged against the result.

CREATE TYPE "public"."crew_duty_status" AS ENUM('open', 'resting', 'closed');--> statement-breakpoint
CREATE TYPE "public"."flight_disruption_cause" AS ENUM('weather_origin', 'weather_destination', 'atc_flow', 'technical', 'crew_timeout', 'ground_vendor', 'airport_closure');--> statement-breakpoint
CREATE TABLE "crew_duty_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"airframe_id" uuid NOT NULL,
	"crew_base_id" uuid NOT NULL,
	"family" text NOT NULL,
	"heads" integer NOT NULL,
	"complement" text DEFAULT '[]' NOT NULL,
	"from_reserve" boolean DEFAULT false NOT NULL,
	"status" "crew_duty_status" DEFAULT 'open' NOT NULL,
	"report_at" timestamp with time zone NOT NULL,
	"off_duty_at" timestamp with time zone,
	"rest_until" timestamp with time zone,
	"sectors" integer DEFAULT 0 NOT NULL,
	"block_minutes" integer DEFAULT 0 NOT NULL,
	"last_arrival_at" timestamp with time zone,
	"location_icao" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_duty_period_heads_positive" CHECK ("crew_duty_period"."heads" > 0),
	CONSTRAINT "crew_duty_period_sectors_nonneg" CHECK ("crew_duty_period"."sectors" >= 0),
	CONSTRAINT "crew_duty_period_block_nonneg" CHECK ("crew_duty_period"."block_minutes" >= 0),
	CONSTRAINT "crew_duty_period_off_duty_after_report" CHECK ("crew_duty_period"."off_duty_at" IS NULL OR "crew_duty_period"."off_duty_at" >= "crew_duty_period"."report_at")
);
--> statement-breakpoint
ALTER TABLE "crew_pool" ADD COLUMN "on_duty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crew_pool" ADD COLUMN "reserve" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "flight" ADD COLUMN "disruption_cause" "flight_disruption_cause";--> statement-breakpoint
ALTER TABLE "flight" ADD COLUMN "crew_duty_period_id" uuid;--> statement-breakpoint
ALTER TABLE "crew_duty_period" ADD CONSTRAINT "crew_duty_period_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_duty_period" ADD CONSTRAINT "crew_duty_period_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_duty_period" ADD CONSTRAINT "crew_duty_period_crew_base_id_crew_base_id_fk" FOREIGN KEY ("crew_base_id") REFERENCES "public"."crew_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_duty_period" ADD CONSTRAINT "crew_duty_period_location_icao_airport_icao_code_fk" FOREIGN KEY ("location_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crew_duty_period_open_airframe_key" ON "crew_duty_period" USING btree ("airframe_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "crew_duty_period_airline_idx" ON "crew_duty_period" USING btree ("airline_id","report_at");--> statement-breakpoint
CREATE INDEX "crew_duty_period_resting_idx" ON "crew_duty_period" USING btree ("status","rest_until");--> statement-breakpoint
CREATE INDEX "crew_duty_period_world_idx" ON "crew_duty_period" USING btree ("world_id");--> statement-breakpoint
ALTER TABLE "crew_pool" ADD CONSTRAINT "crew_pool_on_duty_within_headcount" CHECK ("crew_pool"."on_duty" >= 0 AND "crew_pool"."unavailable" + "crew_pool"."on_duty" <= "crew_pool"."headcount");--> statement-breakpoint
ALTER TABLE "crew_pool" ADD CONSTRAINT "crew_pool_reserve_within_headcount" CHECK ("crew_pool"."reserve" >= 0 AND "crew_pool"."reserve" <= "crew_pool"."headcount");