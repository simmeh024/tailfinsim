-- tailfin:migration-strategy expand
-- Administrator roles (M11-01, §22.1). Additive: a new `admin_role` type and a
-- `role` column on `admin_grant`, defaulted to `super_admin` so every grant that
-- exists keeps the unrestricted access it already had. The previous release does
-- not read the column and keeps working; the new one begins enforcing
-- capabilities in the same deploy. Narrowing a grant is a deliberate act
-- (`admin-cli grant --role …`), never a side effect of this migration.
CREATE TYPE "public"."admin_role" AS ENUM('support', 'game_master', 'economist', 'world_admin', 'super_admin');--> statement-breakpoint
ALTER TABLE "admin_grant" ADD COLUMN "role" "admin_role" DEFAULT 'super_admin' NOT NULL;