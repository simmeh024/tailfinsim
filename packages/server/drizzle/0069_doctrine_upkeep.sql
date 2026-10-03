-- tailfin:migration-strategy expand
-- §10.4's doctrine upkeep (M9-06). Purely additive: one new
-- `cash_movement_cause` value and three new `research_project` columns, each
-- with a default the previous release never has to write. That release starts
-- projects without naming any of them and gets `funded = true`,
-- `funding_changed_at = NULL` and a full-strength `1000` — a doctrine funded
-- since it completed, which is exactly what every completed node was before
-- this migration — so it keeps working against the result, and a rollback to
-- it reads every doctrine at full strength, as it always did.
--
-- No backfill, deliberately: NULL `funding_changed_at` is read as "changed at
-- `completes_at`", which is the correct history for a node nobody has touched.
-- The CHECK holds on every existing row, because every row is 1000.
--
-- The enum value is added and **not used** here. ADR-0016 applies every pending
-- migration in one transaction, and PostgreSQL refuses a new enum value used in
-- the transaction that added it (`unsafe use of new value ... of enum type
-- cash_movement_cause`). The first month's upkeep the worker bills names it.
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'research_upkeep' BEFORE 'admin_adjustment';--> statement-breakpoint
ALTER TABLE "research_project" ADD COLUMN "funded" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "research_project" ADD COLUMN "funding_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "research_project" ADD COLUMN "strength_at_change_permille" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "research_project" ADD CONSTRAINT "research_project_strength_range" CHECK ("research_project"."strength_at_change_permille" >= 0 AND "research_project"."strength_at_change_permille" <= 1000);