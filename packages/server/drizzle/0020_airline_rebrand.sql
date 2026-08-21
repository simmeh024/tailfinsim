-- tailfin:migration-strategy expand
-- The preceding release ignores the new enum value and table, so it remains
-- able to serve throughout the atomic deploy batch.
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'airline_rebrand' BEFORE 'flight_settlement';--> statement-breakpoint
CREATE TABLE "airline_identity_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"airline_id" uuid NOT NULL,
	"before_name" text NOT NULL,
	"after_name" text NOT NULL,
	"before_callsign" text NOT NULL,
	"after_callsign" text NOT NULL,
	"before_base_country" text NOT NULL,
	"after_base_country" text NOT NULL,
	"cost_minor" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airline_identity_change_cost_positive" CHECK ("airline_identity_change"."cost_minor" > 0),
	CONSTRAINT "airline_identity_change_changes_something" CHECK ("airline_identity_change"."before_name" <> "airline_identity_change"."after_name"
          OR "airline_identity_change"."before_callsign" <> "airline_identity_change"."after_callsign"
          OR "airline_identity_change"."before_base_country" <> "airline_identity_change"."after_base_country")
);
--> statement-breakpoint
ALTER TABLE "airline_identity_change" ADD CONSTRAINT "airline_identity_change_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airline_identity_change_airline_id_occurred_at_idx" ON "airline_identity_change" USING btree ("airline_id","occurred_at");
