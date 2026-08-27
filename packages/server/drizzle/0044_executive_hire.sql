-- tailfin:migration-strategy expand
-- New executive_hire table for the C-Suite roster (§9.1 follow-up, Phase 2).
-- Purely additive: the previous release neither reads nor writes it, and no row
-- means an airline employs no executives, the correct default for everyone. No
-- backfill.
CREATE TABLE "executive_hire" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"candidate_id" text NOT NULL,
	"candidate_name" text NOT NULL,
	"monthly_salary_minor" bigint NOT NULL,
	"hired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "executive_hire" ADD CONSTRAINT "executive_hire_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executive_hire" ADD CONSTRAINT "executive_hire_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "executive_hire_airline_candidate_key" ON "executive_hire" USING btree ("airline_id","candidate_id");