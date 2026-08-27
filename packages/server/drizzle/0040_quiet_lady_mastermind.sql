-- tailfin:migration-strategy expand
-- New ground_contract table for M5-06. Purely additive: the previous release
-- neither reads nor writes it, so it keeps working against the result.
CREATE TABLE "ground_contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"airport_icao" text NOT NULL,
	"service_line" text NOT NULL,
	"grade" text NOT NULL,
	"status" text NOT NULL,
	"term_end" timestamp with time zone,
	"volume_commitment" integer,
	"penalty_minor" bigint,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ground_contract" ADD CONSTRAINT "ground_contract_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ground_contract" ADD CONSTRAINT "ground_contract_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ground_contract_active_line_key" ON "ground_contract" USING btree ("airline_id","airport_icao","service_line") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "ground_contract_capacity_idx" ON "ground_contract" USING btree ("world_id","airport_icao","service_line","grade","status");