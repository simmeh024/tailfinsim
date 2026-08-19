CREATE TYPE "public"."flight_kind" AS ENUM('scheduled', 'ferry');--> statement-breakpoint
ALTER TABLE "flight" ADD COLUMN "kind" "flight_kind" DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "flight_result" ADD COLUMN "kind" "flight_kind" DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "flight_result" ADD CONSTRAINT "flight_result_ferry_earns_nothing" CHECK ("flight_result"."kind" <> 'ferry' OR ("flight_result"."revenue_minor" = 0 AND "flight_result"."passengers" = 0));