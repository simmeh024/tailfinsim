CREATE TYPE "public"."world_event_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."world_event_type" AS ENUM('FLIGHT_DEPART', 'FLIGHT_ARRIVE', 'TURNAROUND_COMPLETE');--> statement-breakpoint
CREATE TABLE "world_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"type" "world_event_type" NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"payload" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "world_event_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "world_event_world_id_idempotency_key" UNIQUE("world_id","idempotency_key"),
	CONSTRAINT "world_event_attempts_nonneg" CHECK ("world_event"."attempts" >= 0),
	CONSTRAINT "world_event_processed_when_finished" CHECK (("world_event"."status" = 'pending') = ("world_event"."processed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "world_event" ADD CONSTRAINT "world_event_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "world_event_due_idx" ON "world_event" USING btree ("world_id","status","fire_at");