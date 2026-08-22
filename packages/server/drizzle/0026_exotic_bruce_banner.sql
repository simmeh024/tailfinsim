-- tailfin:migration-strategy expand
-- A fourth event status, and a check constraint rewritten to admit it.
--
-- The previous release keeps working untouched. Its claim predicate is
-- `status = 'pending'`, so an `unsupported` row is simply invisible to it — not
-- claimed, not failed, not counted in queue depth. It never writes the new
-- value, so it cannot violate anything, and every row it can still write
-- satisfies the new constraint exactly as it satisfied the old one.
--
-- ## Why the constraint never names the value being added
--
-- Postgres refuses to *use* an enum value in the transaction that added it, and
-- `deploy.sh` batches the whole pending migration set into a single transaction
-- (ADR-0016). A constraint written as `status <> 'unsupported'` — or anything
-- else mentioning it — would fail the deploy at the migration step.
--
-- So the rule is expressed in terms of the two *terminal* statuses, which
-- already exist: `processed_at` is set exactly when the event is done or
-- failed. That admits `unsupported` with a null `processed_at` without the
-- constraint ever having to hear about it, and it is also the more honest
-- statement of the rule — the column means "when something finished this",
-- and nothing has finished an unsupported event.
--
-- The old constraint `(status = 'pending') = (processed_at IS NULL)` stays
-- equally strict about `done` and `failed`; the replacement only widens the
-- null side.

ALTER TYPE "public"."world_event_status" ADD VALUE IF NOT EXISTS 'unsupported';--> statement-breakpoint
ALTER TABLE "world_event" DROP CONSTRAINT "world_event_processed_when_finished";--> statement-breakpoint
ALTER TABLE "world_event" ADD CONSTRAINT "world_event_processed_when_finished" CHECK (("world_event"."status" IN ('done', 'failed')) = ("world_event"."processed_at" IS NOT NULL));