CREATE TABLE "flight_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"flight_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"revenue_minor" bigint NOT NULL,
	"cost_minor" bigint NOT NULL,
	"net_minor" bigint NOT NULL,
	"seats" integer NOT NULL,
	"passengers" integer NOT NULL,
	"cargo_kg" integer DEFAULT 0 NOT NULL,
	"block_seconds" integer NOT NULL,
	"arrival_delay_minutes" integer DEFAULT 0 NOT NULL,
	"breakdown" text NOT NULL,
	"settlement_version" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flight_result_flight_id_unique" UNIQUE("flight_id"),
	CONSTRAINT "flight_result_net_reconciles" CHECK ("flight_result"."net_minor" = "flight_result"."revenue_minor" - "flight_result"."cost_minor"),
	CONSTRAINT "flight_result_seats_nonneg" CHECK ("flight_result"."seats" >= 0),
	CONSTRAINT "flight_result_passengers_fit" CHECK ("flight_result"."passengers" >= 0 AND "flight_result"."passengers" <= "flight_result"."seats"),
	CONSTRAINT "flight_result_cargo_nonneg" CHECK ("flight_result"."cargo_kg" >= 0),
	CONSTRAINT "flight_result_block_positive" CHECK ("flight_result"."block_seconds" > 0)
);
--> statement-breakpoint
ALTER TABLE "flight_result" ADD CONSTRAINT "flight_result_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_result" ADD CONSTRAINT "flight_result_flight_id_flight_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flight"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_result" ADD CONSTRAINT "flight_result_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flight_result_airline_id_settled_at_idx" ON "flight_result" USING btree ("airline_id","settled_at");--> statement-breakpoint
CREATE INDEX "flight_result_world_id_settled_at_idx" ON "flight_result" USING btree ("world_id","settled_at");