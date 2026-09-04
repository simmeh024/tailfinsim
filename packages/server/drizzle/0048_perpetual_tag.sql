-- tailfin:migration-strategy expand
-- Airport slots (M7-05, §"Slots"). Additive: a new `slot_holding` table of an
-- airline's held departure bands at coordinated airports. Nothing existing reads
-- or writes it, so the previous release keeps working against the result; the
-- schedule authoring path begins consulting it in the same deploy. See ADR-0025.
CREATE TABLE "slot_holding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"airport_icao" text NOT NULL,
	"band" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_holding_world_airline_airport_band_key" UNIQUE("world_id","airline_id","airport_icao","band"),
	CONSTRAINT "slot_holding_band_range" CHECK ("slot_holding"."band" >= 0 AND "slot_holding"."band" <= 23)
);
--> statement-breakpoint
ALTER TABLE "slot_holding" ADD CONSTRAINT "slot_holding_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holding" ADD CONSTRAINT "slot_holding_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holding" ADD CONSTRAINT "slot_holding_airport_icao_airport_icao_code_fk" FOREIGN KEY ("airport_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slot_holding_world_airport_band_idx" ON "slot_holding" USING btree ("world_id","airport_icao","band");--> statement-breakpoint
CREATE INDEX "slot_holding_world_airline_idx" ON "slot_holding" USING btree ("world_id","airline_id");