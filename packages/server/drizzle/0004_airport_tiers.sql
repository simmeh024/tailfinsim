CREATE TYPE "public"."airport_tier" AS ENUM('flagship', 'large', 'medium', 'small', 'regional');--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "tier" "airport_tier";--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "slot_level" integer;--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "tier_basis" text;--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "airport_tier_idx" ON "airport" USING btree ("tier");--> statement-breakpoint
ALTER TABLE "airport" ADD CONSTRAINT "airport_tier_needs_service" CHECK ("airport"."tier" IS NULL OR "airport"."scheduled_service");--> statement-breakpoint
ALTER TABLE "airport" ADD CONSTRAINT "airport_slot_level_range" CHECK ("airport"."slot_level" IS NULL OR ("airport"."slot_level" >= 1 AND "airport"."slot_level" <= 3));