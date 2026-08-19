CREATE TABLE "demand_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"origin_icao" text NOT NULL,
	"destination_icao" text NOT NULL,
	"distance_nm" integer NOT NULL,
	"daily_passengers" numeric(12, 2) NOT NULL,
	"business_share" numeric(5, 4) NOT NULL,
	"leisure_share" numeric(5, 4) NOT NULL,
	"vfr_share" numeric(5, 4) NOT NULL,
	"basis" text NOT NULL,
	"gravity_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demand_pool_world_id_pair_key" UNIQUE("world_id","origin_icao","destination_icao"),
	CONSTRAINT "demand_pool_canonical_order" CHECK ("demand_pool"."origin_icao" < "demand_pool"."destination_icao"),
	CONSTRAINT "demand_pool_distance_positive" CHECK ("demand_pool"."distance_nm" > 0),
	CONSTRAINT "demand_pool_passengers_nonneg" CHECK ("demand_pool"."daily_passengers" >= 0),
	CONSTRAINT "demand_pool_shares_sum_to_one" CHECK (abs(("demand_pool"."business_share" + "demand_pool"."leisure_share" + "demand_pool"."vfr_share") - 1) < 0.001)
);
--> statement-breakpoint
ALTER TABLE "demand_pool" ADD CONSTRAINT "demand_pool_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_pool" ADD CONSTRAINT "demand_pool_origin_icao_airport_icao_code_fk" FOREIGN KEY ("origin_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_pool" ADD CONSTRAINT "demand_pool_destination_icao_airport_icao_code_fk" FOREIGN KEY ("destination_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demand_pool_world_id_daily_passengers_idx" ON "demand_pool" USING btree ("world_id","daily_passengers");--> statement-breakpoint
CREATE INDEX "demand_pool_world_id_origin_idx" ON "demand_pool" USING btree ("world_id","origin_icao");--> statement-breakpoint
CREATE INDEX "demand_pool_world_id_destination_idx" ON "demand_pool" USING btree ("world_id","destination_icao");