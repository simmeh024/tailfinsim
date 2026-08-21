-- tailfin:migration-strategy expand
-- The preceding release ignores the lifecycle columns and transition table.
-- Its inserts receive the active default, and the replacement unique indexes
-- keep the old constraint names and reject the same live-code collisions. The
-- whole replacement is atomic, so no release observes an unenforced namespace.
CREATE TYPE "public"."airline_status" AS ENUM('active', 'restricted', 'ceased');--> statement-breakpoint
CREATE TABLE "airline_status_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"airline_id" uuid NOT NULL,
	"from_status" "airline_status" NOT NULL,
	"to_status" "airline_status" NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airline_status_transition_changes_status" CHECK ("airline_status_transition"."from_status" <> "airline_status_transition"."to_status"),
	CONSTRAINT "airline_status_transition_reason_not_blank" CHECK (char_length("airline_status_transition"."reason") > 0 AND "airline_status_transition"."reason" = btrim("airline_status_transition"."reason"))
);
--> statement-breakpoint
ALTER TABLE "airline" DROP CONSTRAINT "airline_world_id_iata_code_key";--> statement-breakpoint
ALTER TABLE "airline" DROP CONSTRAINT "airline_world_id_icao_code_key";--> statement-breakpoint
ALTER TABLE "airline" ADD COLUMN "status" "airline_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "airline" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "airline" ADD COLUMN "ceased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "airline_status_transition" ADD CONSTRAINT "airline_status_transition_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airline_status_transition_airline_id_occurred_at_idx" ON "airline_status_transition" USING btree ("airline_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "airline_world_id_iata_code_key" ON "airline" USING btree ("world_id","iata_code") WHERE "airline"."status" <> 'ceased';--> statement-breakpoint
CREATE UNIQUE INDEX "airline_world_id_icao_code_key" ON "airline" USING btree ("world_id","icao_code") WHERE "airline"."status" <> 'ceased';--> statement-breakpoint
ALTER TABLE "airline" ADD CONSTRAINT "airline_ceased_at_matches_status" CHECK (("airline"."status" = 'ceased' AND "airline"."ceased_at" IS NOT NULL)
          OR ("airline"."status" <> 'ceased' AND "airline"."ceased_at" IS NULL));
