ALTER TABLE "airport" ADD COLUMN "catchment_population" bigint;--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "wealth_index" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "tourism_index" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "business_index" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "catchment_basis" text;--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "catchment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "airport" ADD CONSTRAINT "airport_catchment_population_nonneg" CHECK ("airport"."catchment_population" IS NULL OR "airport"."catchment_population" >= 0);--> statement-breakpoint
ALTER TABLE "airport" ADD CONSTRAINT "airport_wealth_index_positive" CHECK ("airport"."wealth_index" IS NULL OR "airport"."wealth_index" > 0);--> statement-breakpoint
ALTER TABLE "airport" ADD CONSTRAINT "airport_tourism_index_positive" CHECK ("airport"."tourism_index" IS NULL OR "airport"."tourism_index" > 0);--> statement-breakpoint
ALTER TABLE "airport" ADD CONSTRAINT "airport_business_index_positive" CHECK ("airport"."business_index" IS NULL OR "airport"."business_index" > 0);