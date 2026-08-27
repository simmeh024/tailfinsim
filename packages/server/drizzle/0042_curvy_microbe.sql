-- tailfin:migration-strategy expand
-- New executive_floor table for the executive floor (§9.1 follow-up). Purely
-- additive: the previous release neither reads nor writes it, and no row means
-- the floor is closed, which is the correct default for every existing airline.
-- No backfill.
CREATE TABLE "executive_floor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"offices_unlocked" integer DEFAULT 0 NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "executive_floor" ADD CONSTRAINT "executive_floor_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executive_floor" ADD CONSTRAINT "executive_floor_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "executive_floor_airline_key" ON "executive_floor" USING btree ("airline_id");