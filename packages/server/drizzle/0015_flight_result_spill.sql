ALTER TABLE "flight_result" ADD COLUMN "spilled_passengers" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "flight_result" ADD CONSTRAINT "flight_result_spill_needs_a_full_aircraft" CHECK ("flight_result"."spilled_passengers" >= 0
          AND ("flight_result"."spilled_passengers" = 0 OR "flight_result"."passengers" = "flight_result"."seats"));