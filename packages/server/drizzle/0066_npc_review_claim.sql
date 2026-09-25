-- tailfin:migration-strategy expand
-- The NPC review's claim (M3-12 fix). Purely additive: one new table,
-- `npc_review_claim`, that nothing existing reads or writes. The previous
-- release keeps working against the result and simply never touches it.
--
-- The table is empty on arrival. The first worker carrying this release writes
-- one row per world on each review day it runs, keyed by the world's
-- `launch_date`, so a world reset (ADR-0005) starts a fresh key space rather
-- than needing the table cleared. No data migration: a review that already ran
-- on today's review day, before this deploy, is not recorded, so a world may be
-- reviewed once more today — the old code had been reviewing it every tick.
CREATE TABLE "npc_review_claim" (
	"world_id" uuid NOT NULL,
	"launch_date" timestamp with time zone NOT NULL,
	"game_day" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npc_review_claim_world_id_launch_date_game_day_pk" PRIMARY KEY("world_id","launch_date","game_day")
);
--> statement-breakpoint
ALTER TABLE "npc_review_claim" ADD CONSTRAINT "npc_review_claim_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;
