-- tailfin:migration-strategy expand
-- The airline brand logo (§15/§16). Additive: a nullable jsonb `logo` on airline
-- (null = no logo yet, the client shows a default), and before/after logo columns
-- on the identity-change event. The "changes something" check is relaxed to a
-- superset — a logo-only change now counts — so every row the previous release
-- writes still satisfies it and it keeps working against this schema. No backfill.
ALTER TABLE "airline_identity_change" DROP CONSTRAINT "airline_identity_change_changes_something";--> statement-breakpoint
ALTER TABLE "airline" ADD COLUMN "logo" jsonb;--> statement-breakpoint
ALTER TABLE "airline_identity_change" ADD COLUMN "before_logo" jsonb;--> statement-breakpoint
ALTER TABLE "airline_identity_change" ADD COLUMN "after_logo" jsonb;--> statement-breakpoint
ALTER TABLE "airline_identity_change" ADD CONSTRAINT "airline_identity_change_changes_something" CHECK ("airline_identity_change"."before_name" <> "airline_identity_change"."after_name"
          OR "airline_identity_change"."before_callsign" <> "airline_identity_change"."after_callsign"
          OR "airline_identity_change"."before_base_country" <> "airline_identity_change"."after_base_country"
          OR "airline_identity_change"."before_logo" IS DISTINCT FROM "airline_identity_change"."after_logo");