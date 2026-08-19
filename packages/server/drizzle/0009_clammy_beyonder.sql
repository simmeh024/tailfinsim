CREATE TYPE "public"."flight_disruption" AS ENUM('delayed', 'cancelled', 'returned_to_stand', 'air_return', 'diverted');--> statement-breakpoint
CREATE TYPE "public"."flight_phase" AS ENUM('scheduled', 'boarding', 'pushback', 'taxi_out', 'departure', 'climb', 'cruise', 'descent', 'approach', 'landing', 'taxi_in', 'turnaround', 'idle');--> statement-breakpoint
CREATE TYPE "public"."repeat_kind" AS ENUM('daily', 'weekdays');--> statement-breakpoint
CREATE TABLE "flight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"schedule_id" uuid,
	"airframe_id" uuid NOT NULL,
	"origin_icao" text NOT NULL,
	"destination_icao" text NOT NULL,
	"diversion_icao" text,
	"phase" "flight_phase" DEFAULT 'scheduled' NOT NULL,
	"disruption" "flight_disruption",
	"scheduled_departure" timestamp with time zone NOT NULL,
	"actual_departure" timestamp with time zone,
	"estimated_arrival" timestamp with time zone NOT NULL,
	"actual_arrival" timestamp with time zone,
	"load" text DEFAULT '{}' NOT NULL,
	"cargo_kg" integer DEFAULT 0 NOT NULL,
	"materialisation_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flight_world_id_materialisation_key" UNIQUE("world_id","materialisation_key"),
	CONSTRAINT "flight_cargo_nonneg" CHECK ("flight"."cargo_kg" >= 0),
	CONSTRAINT "flight_arrives_after_departure" CHECK ("flight"."estimated_arrival" > "flight"."scheduled_departure"),
	CONSTRAINT "flight_not_circular" CHECK ("flight"."origin_icao" <> "flight"."destination_icao")
);
--> statement-breakpoint
CREATE TABLE "schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"airframe_id" uuid NOT NULL,
	"repeat_kind" "repeat_kind" NOT NULL,
	"repeat_days" integer[],
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_repeat_days_match_kind" CHECK (("schedule"."repeat_kind" = 'daily' AND "schedule"."repeat_days" IS NULL)
          OR ("schedule"."repeat_kind" = 'weekdays'
              AND coalesce(cardinality("schedule"."repeat_days"), 0) BETWEEN 1 AND 7
              AND "schedule"."repeat_days" <@ ARRAY[1,2,3,4,5,6,7]))
);
--> statement-breakpoint
CREATE TABLE "schedule_leg" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"leg_index" integer NOT NULL,
	"origin_icao" text NOT NULL,
	"destination_icao" text NOT NULL,
	"departure_minute" integer NOT NULL,
	"block_minutes" integer NOT NULL,
	"turnaround_minutes" integer NOT NULL,
	CONSTRAINT "schedule_leg_schedule_id_leg_index_key" UNIQUE("schedule_id","leg_index"),
	CONSTRAINT "schedule_leg_index_nonneg" CHECK ("schedule_leg"."leg_index" >= 0),
	CONSTRAINT "schedule_leg_departure_nonneg" CHECK ("schedule_leg"."departure_minute" >= 0),
	CONSTRAINT "schedule_leg_block_positive" CHECK ("schedule_leg"."block_minutes" > 0),
	CONSTRAINT "schedule_leg_turnaround_nonneg" CHECK ("schedule_leg"."turnaround_minutes" >= 0),
	CONSTRAINT "schedule_leg_not_circular" CHECK ("schedule_leg"."origin_icao" <> "schedule_leg"."destination_icao")
);
--> statement-breakpoint
ALTER TABLE "flight" ADD CONSTRAINT "flight_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight" ADD CONSTRAINT "flight_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight" ADD CONSTRAINT "flight_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight" ADD CONSTRAINT "flight_origin_icao_airport_icao_code_fk" FOREIGN KEY ("origin_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight" ADD CONSTRAINT "flight_destination_icao_airport_icao_code_fk" FOREIGN KEY ("destination_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight" ADD CONSTRAINT "flight_diversion_icao_airport_icao_code_fk" FOREIGN KEY ("diversion_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_leg" ADD CONSTRAINT "schedule_leg_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_leg" ADD CONSTRAINT "schedule_leg_origin_icao_airport_icao_code_fk" FOREIGN KEY ("origin_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_leg" ADD CONSTRAINT "schedule_leg_destination_icao_airport_icao_code_fk" FOREIGN KEY ("destination_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flight_world_id_scheduled_departure_idx" ON "flight" USING btree ("world_id","scheduled_departure");--> statement-breakpoint
CREATE INDEX "flight_schedule_id_idx" ON "flight" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "flight_airline_id_idx" ON "flight" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "schedule_world_id_idx" ON "schedule" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "schedule_airline_id_idx" ON "schedule" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "schedule_world_id_active_idx" ON "schedule" USING btree ("world_id","active");--> statement-breakpoint
CREATE INDEX "schedule_leg_schedule_id_idx" ON "schedule_leg" USING btree ("schedule_id");