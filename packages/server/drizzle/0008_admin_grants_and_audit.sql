CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_player_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"before" text,
	"after" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "admin_grant" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"granted_by_player_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_grant" ADD CONSTRAINT "admin_grant_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_grant" ADD CONSTRAINT "admin_grant_granted_by_player_id_player_id_fk" FOREIGN KEY ("granted_by_player_id") REFERENCES "public"."player"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_at_idx" ON "admin_audit" USING btree ("at");--> statement-breakpoint
-- The audit log is append-only, and this is what makes that true.
--
-- "No UPDATE or DELETE path in the application" is a convention, and a
-- convention is what fails on the day it matters — the day somebody wants a row
-- gone. A trigger refuses regardless of who is asking: the ORM, a migration, or
-- a psql session. Removing it means dropping a trigger, which is a conspicuous
-- act rather than a quiet one.
--
-- The TRUNCATE trigger is not redundant. TRUNCATE bypasses row-level triggers
-- entirely, so without a statement-level one the whole log could be emptied in a
-- single statement while both row triggers watched.
CREATE OR REPLACE FUNCTION admin_audit_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER admin_audit_no_update
  BEFORE UPDATE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION admin_audit_is_append_only();
--> statement-breakpoint
CREATE TRIGGER admin_audit_no_delete
  BEFORE DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION admin_audit_is_append_only();
--> statement-breakpoint
CREATE TRIGGER admin_audit_no_truncate
  BEFORE TRUNCATE ON admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_is_append_only();
