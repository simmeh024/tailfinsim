-- tailfin:migration-strategy expand
-- A new table that no previous release reads or writes. Nothing existing changes
-- shape, no constraint tightens, and `world.economy_config_version` keeps its
-- meaning — the preceding build resolves it against a code constant and carries
-- on, so it is unaffected by the table being empty, populated, or absent.
--
-- Deliberately no foreign key from `world.economy_config_version` to this table.
-- Adding one would require seeding a v1 row here, which means writing every
-- balance number into SQL — the duplication the table exists to remove. The seed
-- runs at startup from `ECONOMY_CONFIG_V1` instead.

CREATE TABLE "economy_config" (
	"version" text PRIMARY KEY NOT NULL,
	"payload" text NOT NULL,
	"checksum" text NOT NULL,
	"parent_version" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_player_id" uuid,
	"created_by_label" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "economy_config_created_at_idx" ON "economy_config" USING btree ("created_at");
--> statement-breakpoint
-- A config version is immutable, and this is what makes that true.
--
-- Three things rest on it. `flight_result` stores the version it settled under,
-- so a payload that could change under it would make an old settlement
-- inexplicable (invariant 4). The in-process cache in `economy/loader.ts` is
-- keyed by version and needs no cross-process invalidation, because a version
-- cannot come to mean something else. And §22.3's rollback is re-pinning a
-- version that still exists rather than editing one back.
--
-- A convention would fail on the day somebody wanted a number quietly changed.
-- A trigger refuses regardless of who is asking — the ORM, a migration, or a
-- psql session — and removing it is a conspicuous act. Retuning is `INSERT`.
--
-- The TRUNCATE trigger is not redundant: TRUNCATE bypasses row-level triggers
-- entirely, so without a statement-level one the whole table could be emptied in
-- a single statement while both row triggers watched.
CREATE OR REPLACE FUNCTION economy_config_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'economy_config is immutable; % is not permitted. Insert a new version instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER economy_config_no_update
  BEFORE UPDATE ON economy_config
  FOR EACH ROW EXECUTE FUNCTION economy_config_is_immutable();
--> statement-breakpoint
CREATE TRIGGER economy_config_no_delete
  BEFORE DELETE ON economy_config
  FOR EACH ROW EXECUTE FUNCTION economy_config_is_immutable();
--> statement-breakpoint
CREATE TRIGGER economy_config_no_truncate
  BEFORE TRUNCATE ON economy_config
  FOR EACH STATEMENT EXECUTE FUNCTION economy_config_is_immutable();
