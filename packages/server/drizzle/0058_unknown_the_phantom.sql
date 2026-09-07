-- tailfin:migration-strategy expand
--
-- M8-13 (#85): §14.5's alerts and §3.2's offline digest.
--
-- Two new tables and nothing else. The previous release writes to neither and
-- reads from neither, so a world served by the old build behaves exactly as it
-- does today while this schema is in place; the alerts and the digest simply do
-- not exist there.
--
-- `alert_open_subject_key` is the deduplication, and it is a **partial** unique
-- index over `subject_key` rather than over a nullable `subject_id`. A unique
-- index treats NULLs as distinct, so an airline-wide alert -- a cash runway, a
-- coverage ratio -- would stack a fresh row on every sweep behind an index that
-- looked like it prevented exactly that. Every rule supplies a `subject_key`,
-- so there is no null case to get wrong.
--
-- Every timestamp on both tables except `created_at` and `updated_at` is **game
-- time** (ADR-0026): what an alert is about is measured on the world's clock,
-- and a digest window that mixed the two calendars would select a set that
-- depended on which world speed the player left running. The three nullable
-- columns on `alert_state` mean **never**, not the epoch -- a null `swept_at` is
-- what lets an empty alert list say "nothing has run" rather than "nothing is
-- wrong".

CREATE TABLE "alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_label" text NOT NULL,
	"subject_key" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"screen" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_resolved_after_raised" CHECK ("alert"."resolved_at" IS NULL OR "alert"."resolved_at" >= "alert"."raised_at")
);
--> statement-breakpoint
CREATE TABLE "alert_state" (
	"airline_id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"swept_at" timestamp with time zone,
	"digest_covered_through_at" timestamp with time zone,
	"digest_read_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_state" ADD CONSTRAINT "alert_state_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_state" ADD CONSTRAINT "alert_state_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_open_subject_key" ON "alert" USING btree ("airline_id","kind","subject_key") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "alert_airline_open_idx" ON "alert" USING btree ("airline_id","resolved_at");--> statement-breakpoint
CREATE INDEX "alert_airline_raised_idx" ON "alert" USING btree ("airline_id","raised_at");--> statement-breakpoint
CREATE INDEX "alert_world_idx" ON "alert" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "alert_state_world_swept_idx" ON "alert_state" USING btree ("world_id","swept_at");
