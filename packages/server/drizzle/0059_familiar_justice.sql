-- tailfin:migration-strategy expand
-- Identity model for providers that are not Google (AUTH-01). Purely additive.
--
-- Three new `auth_provider` values and two new nullable-or-defaulted columns on
-- `player_identity`. The previous release neither writes the new values nor
-- reads the new columns, and every existing Google row keeps resolving through
-- the unchanged `(provider, subject)` unique key.
--
-- `ALTER TYPE ... ADD VALUE` inside the deploy's single migration transaction is
-- safe on PostgreSQL 12+ (16.15 in CI and on the box, checked): the restriction
-- is that a value added in a transaction cannot be *used* in that same
-- transaction, and nothing here writes a row with one.
--
-- **That restriction outlives this file.** ADR-0016 applies every *pending*
-- migration in one transaction, so on a virgin database — CI, and any new
-- environment — this `ADD VALUE` shares its transaction with every migration
-- that follows it, no matter how much later it was written. A later migration
-- that inserts or compares against `'discord'`, `'email'` or `'passkey'` as an
-- enum literal therefore passes locally, where only that one file is pending,
-- and fails on a fresh database with `unsafe use of new value`. Cast to text
-- and compare against a text literal instead. This has already bitten twice,
-- on `maintenance_check` and `executive_floor`.
--
-- `last_used_at` is deliberately nullable with no default: null means this
-- identity has never completed an authentication, which is the honest state for
-- one that was linked and not yet signed in with. A default would make every
-- identity claim it was used the instant it was created.
ALTER TYPE "public"."auth_provider" ADD VALUE 'discord';--> statement-breakpoint
ALTER TYPE "public"."auth_provider" ADD VALUE 'email';--> statement-breakpoint
ALTER TYPE "public"."auth_provider" ADD VALUE 'passkey';--> statement-breakpoint
ALTER TABLE "player_identity" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "player_identity" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;