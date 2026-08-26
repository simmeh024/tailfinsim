-- tailfin:migration-strategy expand
-- Adds the office_expansion cash cause and table. Purely additive: the previous
-- release never writes neutral seats or reads this table, so it keeps working.
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'office_expansion' BEFORE 'admin_adjustment';--> statement-breakpoint
CREATE TABLE "office_expansion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"neutral_seats" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "office_expansion" ADD CONSTRAINT "office_expansion_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_expansion" ADD CONSTRAINT "office_expansion_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "office_expansion_airline_key" ON "office_expansion" USING btree ("airline_id");