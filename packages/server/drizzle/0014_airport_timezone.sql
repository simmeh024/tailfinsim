ALTER TABLE "airport" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "utc_offset_minutes" integer;--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "timezone_basis" text;