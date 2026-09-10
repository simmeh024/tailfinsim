-- tailfin:migration-strategy expand
-- Crew XP and airport difficulty (M9-02, §10.2). Purely additive: three
-- nullable columns on `airport` and one defaulted column on `crew_pool`. The
-- previous release reads and writes none of them.
--
-- `airport.difficulty` is **nullable and means never rated**, not easy. Nothing
-- backfills it: `pnpm data:difficulty` writes it, and until that has run every
-- flight earns flat XP rather than XP against a guessed rating. A default of 0
-- here would have been indistinguishable from a rated-easy field, and would
-- also have been a balance literal in a migration.
--
-- `crew_pool.xp` defaults to 0, and 0 is the honest value for every existing
-- pool: no flight before this migration ever awarded any. Unlike the airport
-- column there is no third state to preserve.
--
-- No enum values are added, so this cannot hit the `unsafe use of new value`
-- trap that has bitten this repository twice.
ALTER TABLE "airport" ADD COLUMN "difficulty" double precision;--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "difficulty_basis" text;--> statement-breakpoint
ALTER TABLE "airport" ADD COLUMN "difficulty_rated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crew_pool" ADD COLUMN "xp" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "airport" ADD CONSTRAINT "airport_difficulty_range" CHECK ("airport"."difficulty" IS NULL OR ("airport"."difficulty" >= 0 AND "airport"."difficulty" <= 1));--> statement-breakpoint
ALTER TABLE "crew_pool" ADD CONSTRAINT "crew_pool_xp_nonneg" CHECK ("crew_pool"."xp" >= 0);