-- tailfin:migration-strategy expand
-- Named crew and their skill trees (M9-03, §10.2). Purely additive: one new
-- table, `crew_member`. Nothing existing changes, so the previous release keeps
-- working against the result and simply never reads it.
--
-- The table is empty on arrival and stays empty until the worker's naming sweep
-- finds a pool whose XP per head has crossed §10.2's threshold. There is
-- deliberately **no backfill**: a pool's XP belongs to everyone who has ever
-- been in it, and minting a named individual to own it retroactively would put
-- a person's name on a career they did not have.
--
-- No enum values are added, so this cannot hit the `unsafe use of new value`
-- trap that has bitten this repository twice.
CREATE TABLE "crew_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"crew_base_id" uuid NOT NULL,
	"family" text NOT NULL,
	"rank" "crew_rank" NOT NULL,
	"name" text NOT NULL,
	"ordinal" integer NOT NULL,
	"xp" bigint DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"skill_points" text DEFAULT '{}' NOT NULL,
	"career_block_minutes" integer DEFAULT 0 NOT NULL,
	"career_sectors" integer DEFAULT 0 NOT NULL,
	"career_incidents" integer DEFAULT 0 NOT NULL,
	"career_families" text DEFAULT '[]' NOT NULL,
	"named_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crew_member_base_ordinal_key" UNIQUE("crew_base_id","ordinal"),
	CONSTRAINT "crew_member_level_positive" CHECK ("crew_member"."level" >= 1),
	CONSTRAINT "crew_member_xp_nonneg" CHECK ("crew_member"."xp" >= 0),
	CONSTRAINT "crew_member_ordinal_nonneg" CHECK ("crew_member"."ordinal" >= 0),
	CONSTRAINT "crew_member_career_nonneg" CHECK ("crew_member"."career_block_minutes" >= 0 AND "crew_member"."career_sectors" >= 0 AND "crew_member"."career_incidents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_crew_base_id_crew_base_id_fk" FOREIGN KEY ("crew_base_id") REFERENCES "public"."crew_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_member_airline_idx" ON "crew_member" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "crew_member_pool_idx" ON "crew_member" USING btree ("crew_base_id","family","rank");