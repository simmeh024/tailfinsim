-- tailfin:migration-strategy expand
-- New social_media_reputation_grant table for the social media specialist
-- (M5-04 follow-up). Purely additive: the previous release neither reads nor
-- writes it, and the monthly reputation drip that does is the worker's, which
-- ships with this table. No backfill — an absent marker means the month has
-- not been granted yet, which is exactly the fresh state.
CREATE TABLE "social_media_reputation_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"period" text NOT NULL,
	"amount" numeric(3, 2) NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_media_reputation_grant" ADD CONSTRAINT "social_media_reputation_grant_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_media_reputation_grant" ADD CONSTRAINT "social_media_reputation_grant_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "social_media_reputation_grant_airline_period_key" ON "social_media_reputation_grant" USING btree ("airline_id","period");