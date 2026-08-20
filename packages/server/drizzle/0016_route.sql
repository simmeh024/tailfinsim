CREATE TABLE "route" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"origin_icao" text NOT NULL,
	"destination_icao" text NOT NULL,
	"great_circle_nm" double precision NOT NULL,
	"fares" text DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_airline_pair_key" UNIQUE("airline_id","origin_icao","destination_icao"),
	CONSTRAINT "route_endpoints_differ" CHECK ("route"."origin_icao" <> "route"."destination_icao"),
	CONSTRAINT "route_distance_positive" CHECK ("route"."great_circle_nm" > 0)
);
--> statement-breakpoint
ALTER TABLE "route" ADD CONSTRAINT "route_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route" ADD CONSTRAINT "route_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route" ADD CONSTRAINT "route_origin_icao_airport_icao_code_fk" FOREIGN KEY ("origin_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route" ADD CONSTRAINT "route_destination_icao_airport_icao_code_fk" FOREIGN KEY ("destination_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_world_id_idx" ON "route" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "route_airline_id_idx" ON "route" USING btree ("airline_id");