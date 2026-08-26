-- tailfin:migration-strategy expand
-- Two new tables for the automation ladder (ADR-0023). Purely additive: the
-- previous release neither reads nor writes them, so it keeps working.
CREATE TABLE "automation_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"system" text NOT NULL,
	"mode" text NOT NULL,
	"policy" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"system" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"detail" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "automation_setting" ADD CONSTRAINT "automation_setting_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_setting" ADD CONSTRAINT "automation_setting_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_task" ADD CONSTRAINT "operations_task_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations_task" ADD CONSTRAINT "operations_task_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_setting_airline_system_key" ON "automation_setting" USING btree ("airline_id","system");--> statement-breakpoint
CREATE UNIQUE INDEX "operations_task_open_subject_key" ON "operations_task" USING btree ("airline_id","system","subject_id") WHERE resolved_at is null;