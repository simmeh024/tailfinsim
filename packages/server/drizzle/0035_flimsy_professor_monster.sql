-- tailfin:migration-strategy expand
--
-- M5-03, crew morale. Two new enums, two policy columns on crew_base with
-- sensible defaults, two nullable morale columns, and a sick counter on
-- crew_pool defaulted to 0.
--
-- Every new check holds for the rows already there: sick defaults to 0, so the
-- committed-heads check is exactly the one that already passed. The previous
-- release does not know any of it exists and never writes it.
--
-- crew_base.morale is deliberately NULL rather than defaulted. Null means
-- never reviewed and reads as the economy config's startingMorale; a default
-- here would be a balance literal in a migration, unmovable by a retune.

CREATE TYPE "public"."hotel_tier" AS ENUM('budget', 'standard', 'premium');--> statement-breakpoint
CREATE TYPE "public"."pay_band" AS ENUM('lean', 'market', 'generous');--> statement-breakpoint
ALTER TABLE "crew_base" ADD COLUMN "pay_band" "pay_band" DEFAULT 'market' NOT NULL;--> statement-breakpoint
ALTER TABLE "crew_base" ADD COLUMN "hotel_tier" "hotel_tier" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "crew_base" ADD COLUMN "morale" double precision;--> statement-breakpoint
ALTER TABLE "crew_base" ADD COLUMN "morale_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crew_pool" ADD COLUMN "sick" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crew_pool" ADD COLUMN "sick_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "crew_pool_sick_idx" ON "crew_pool" USING btree ("sick_until");--> statement-breakpoint
ALTER TABLE "crew_pool" ADD CONSTRAINT "crew_pool_sick_within_headcount" CHECK ("crew_pool"."sick" >= 0 AND "crew_pool"."unavailable" + "crew_pool"."on_duty" + "crew_pool"."sick" <= "crew_pool"."headcount");