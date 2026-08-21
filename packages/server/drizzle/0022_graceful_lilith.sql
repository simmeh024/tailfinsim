-- tailfin:migration-strategy expand
-- A new table and a new enum that nothing before this release reads or writes.
-- The preceding build ignores both entirely: no existing column changes shape,
-- no constraint tightens, and a node that never writes a heartbeat simply does
-- not appear in the console. Rolling back leaves the rows in place, unread.
CREATE TYPE "public"."node_role" AS ENUM('web', 'worker');--> statement-breakpoint
CREATE TABLE "node_heartbeat" (
	"node" text PRIMARY KEY NOT NULL,
	"role" "node_role" NOT NULL,
	"environment" text NOT NULL,
	"build" integer NOT NULL,
	"commit" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uptime_seconds" integer NOT NULL,
	"load" text NOT NULL,
	"engine" text,
	CONSTRAINT "node_heartbeat_uptime_nonnegative" CHECK ("node_heartbeat"."uptime_seconds" >= 0),
	CONSTRAINT "node_heartbeat_build_nonnegative" CHECK ("node_heartbeat"."build" >= 0),
	CONSTRAINT "node_heartbeat_engine_matches_role" CHECK (("node_heartbeat"."role" = 'worker' AND "node_heartbeat"."engine" IS NOT NULL)
          OR ("node_heartbeat"."role" = 'web' AND "node_heartbeat"."engine" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "node_heartbeat_last_seen_at_idx" ON "node_heartbeat" USING btree ("last_seen_at");