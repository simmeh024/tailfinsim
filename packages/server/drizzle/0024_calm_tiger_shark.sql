-- tailfin:migration-strategy expand
-- Four additions and one relaxation, none of which the previous release can
-- trip over.
--
-- `airline.player_id` DROP NOT NULL *widens* what the column accepts. The
-- preceding build never writes a null there, and every query it runs against
-- airlines either filters by a specific player id or counts rows — neither of
-- which a null row can break. Re-tightening it would be the contract half, and
-- nothing here needs that.
--
-- `airline.kind` arrives with a default of 'player', which is what every
-- existing row is, so the old build keeps inserting valid rows without knowing
-- the column exists. `airline.archetype` and `route.npc_loss_reviews` are
-- nullable or defaulted for the same reason.
--
-- `airline_kind_matches_operator` is satisfied by every row that already exists
-- and by every row the old build can still write: player id present, kind
-- defaulted to 'player', archetype null.
--
-- One behavioural note that is not a compatibility problem but is worth
-- recording: `founding-options.ts` counts a world's airlines to enforce
-- `player_cap`, and NPC rows would be counted by a build that does not know to
-- exclude them. That build cannot see NPC rows, because only the release that
-- introduces them can create them.

CREATE TYPE "public"."airline_kind" AS ENUM('player', 'npc');--> statement-breakpoint
CREATE TYPE "public"."npc_archetype" AS ENUM('flag', 'lcc', 'regional', 'charter');--> statement-breakpoint
CREATE TYPE "public"."npc_decision_kind" AS ENUM('route_opened', 'route_closed', 'fare_changed', 'entry_declined');--> statement-breakpoint
CREATE TABLE "npc_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "npc_decision_kind" NOT NULL,
	"origin_icao" text,
	"destination_icao" text,
	"basis" text NOT NULL,
	"reason" text NOT NULL,
	"economy_config_version" text NOT NULL,
	CONSTRAINT "npc_decision_route_pair_complete" CHECK (("npc_decision"."origin_icao" IS NULL AND "npc_decision"."destination_icao" IS NULL)
          OR ("npc_decision"."origin_icao" IS NOT NULL AND "npc_decision"."destination_icao" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "airline" ALTER COLUMN "player_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "airline" ADD COLUMN "kind" "airline_kind" DEFAULT 'player' NOT NULL;--> statement-breakpoint
ALTER TABLE "airline" ADD COLUMN "archetype" "npc_archetype";--> statement-breakpoint
ALTER TABLE "route" ADD COLUMN "npc_loss_reviews" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "npc_decision" ADD CONSTRAINT "npc_decision_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_decision" ADD CONSTRAINT "npc_decision_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "npc_decision_world_id_decided_at_idx" ON "npc_decision" USING btree ("world_id","decided_at");--> statement-breakpoint
CREATE INDEX "npc_decision_airline_id_idx" ON "npc_decision" USING btree ("airline_id");--> statement-breakpoint
ALTER TABLE "airline" ADD CONSTRAINT "airline_kind_matches_operator" CHECK (("airline"."kind" = 'player' AND "airline"."player_id" IS NOT NULL AND "airline"."archetype" IS NULL)
          OR ("airline"."kind" = 'npc' AND "airline"."player_id" IS NULL AND "airline"."archetype" IS NOT NULL));