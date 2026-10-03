-- tailfin:migration-strategy expand
-- Training Captains (M9-04, §10.2). Purely additive: one new
-- `cash_movement_cause` value, two new `crew_member` columns and three CHECKs
-- that every existing row already satisfies. The previous release keeps working
-- against the result: its naming sweep inserts members without naming either
-- column and gets `training_captain_since` NULL and `training_captain_changes` 0
-- — a line pilot, which is exactly what every member was before this — and
-- nothing it does to a member (crediting XP, spending a point) touches either.
--
-- The three constraints hold on every row this migration finds, because every
-- row is (NULL, 0): the parity check reads "no designation, even count", and the
-- rank check only constrains a row that holds the designation. So adding them
-- validates rather than fails, without a NOT VALID.
--
-- The enum value is added and **not used** in this migration. ADR-0016 applies
-- every pending migration in one transaction, and PostgreSQL refuses a new enum
-- value used in the transaction that added it (`unsafe use of new value ... of
-- enum type cash_movement_cause`). Nothing here names it; the first request
-- that converts a Training Captain does.
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'training_captain' BEFORE 'admin_adjustment';--> statement-breakpoint
ALTER TABLE "crew_member" ADD COLUMN "training_captain_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crew_member" ADD COLUMN "training_captain_changes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_training_captain_changes_nonneg" CHECK ("crew_member"."training_captain_changes" >= 0);--> statement-breakpoint
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_training_captain_parity" CHECK (("crew_member"."training_captain_since" IS NOT NULL) = ("crew_member"."training_captain_changes" % 2 = 1));--> statement-breakpoint
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_training_captain_rank" CHECK ("crew_member"."training_captain_since" IS NULL OR "crew_member"."rank" IN ('captain', 'training_captain'));