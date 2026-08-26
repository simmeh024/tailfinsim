-- tailfin:migration-strategy expand
--
-- M5-04, office hires. One new cash-movement cause (`office_salary`) and one new
-- table (`office_hire`). Both additive: the previous release neither reads the
-- table nor emits the cause, so it keeps working against this schema unchanged.
--
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'office_salary' BEFORE 'admin_adjustment';--> statement-breakpoint
CREATE TABLE "office_hire" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"role" text NOT NULL,
	"candidate_id" text NOT NULL,
	"candidate_name" text NOT NULL,
	"monthly_salary_minor" bigint NOT NULL,
	"hired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "office_hire" ADD CONSTRAINT "office_hire_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_hire" ADD CONSTRAINT "office_hire_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "office_hire_airline_role_key" ON "office_hire" USING btree ("airline_id","role");