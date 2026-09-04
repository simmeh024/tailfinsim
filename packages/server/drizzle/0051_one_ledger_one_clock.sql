-- tailfin:migration-strategy expand
-- The AIR-06 ledger becomes one calendar (TIME-02, ADR-0026).
--
-- Data only: no table, column, type, index or constraint changes, so the previous
-- release runs against the result unchanged. What changes is the *domain* of
-- `occurred_at` on six causes -- from wall clock to the owning world's own
-- calendar -- plus the two `hired_at` columns whose salaries are per game month.
--
-- TIME-01 (0050) did the fleet. This is the ledger, and it is the same defect:
-- flight settlement, maintenance, crew payroll, duty, the rebrand and (since
-- 0050) aircraft acquisition all dated their movements on the world's clock,
-- while founding, the executive floor and its offices, headquarters expansion,
-- operator adjustments and 0019's opening-balance backfill used `now()`. One
-- sorted account, two calendars: an office expansion and the flight that paid
-- for it could appear in either order, and a date-ranged ledger query returned a
-- set that depended on which kind of row it caught.
--
-- Each value is pushed through its world's clock, `epoch + speed x (t - launch_date)`,
-- the same arithmetic `gameTime()` performs in @tailfin/sim -- so a row keeps the
-- instant it recorded and only the calendar it is expressed in moves. The
-- conversion is monotonic (`world_speed_multiplier_positive`), so relative order
-- within each converted set is preserved. `interval * numeric` is not a Postgres
-- operator; the double-precision cast is required, not decorative.
--
-- Both tables are immutable by trigger, so the guards come off for exactly this
-- correction and go straight back on -- the shape migrations 0028 and 0050 use.
-- The DEFERRABLE reconciliation triggers are deliberately left in place: they sum
-- `amount_minor`, which nothing here touches, so they re-verify at commit and are
-- the check that this migration did not move money. Nothing below alters an
-- amount, a balance, a cause or a reference.
--
-- Two things this does not do. It leaves `recorded_at` alone on both tables --
-- that is the row's wall-clock audit stamp and is the only real instant left
-- here. And for a legacy NPC founding row it converts the recorded instant rather
-- than moving it to the world's epoch, which is what `npc:seed` writes from now
-- on: converting is faithful to what happened, and rewriting history to match new
-- code would be the wrong way round.

DROP TRIGGER "cash_movement_immutable" ON "cash_movement";--> statement-breakpoint
DROP TRIGGER "ledger_entry_immutable" ON "ledger_entry";--> statement-breakpoint

UPDATE "cash_movement" AS m
SET "occurred_at" =
  w."epoch" + (m."occurred_at" - w."launch_date") * w."speed_multiplier"::double precision
FROM "airline" AS a, "world" AS w
WHERE a."id" = m."airline_id"
  AND w."id" = a."world_id"
  AND m."cause" IN (
    'airline_founding',
    'executive_floor',
    'executive_office',
    'office_expansion',
    'admin_adjustment',
    'migration_opening_balance'
  );--> statement-breakpoint

-- The ledger lines of those same movements, joined through the movement rather
-- than re-deciding which causes qualify. `ledger_entry` carries its own
-- `world_id`, so the clock comes from the row and not from a second join.
UPDATE "ledger_entry" AS l
SET "occurred_at" =
  w."epoch" + (l."occurred_at" - w."launch_date") * w."speed_multiplier"::double precision
FROM "cash_movement" AS m, "world" AS w
WHERE m."id" = l."cash_movement_id"
  AND w."id" = l."world_id"
  AND m."cause" IN (
    'airline_founding',
    'executive_floor',
    'executive_office',
    'office_expansion',
    'admin_adjustment',
    'migration_opening_balance'
  );--> statement-breakpoint

CREATE TRIGGER "cash_movement_immutable"
BEFORE UPDATE ON "cash_movement"
FOR EACH ROW EXECUTE FUNCTION "refuse_cash_movement_update"();--> statement-breakpoint
CREATE TRIGGER "ledger_entry_immutable"
BEFORE UPDATE ON "ledger_entry"
FOR EACH ROW EXECUTE FUNCTION "refuse_ledger_entry_update"();--> statement-breakpoint

-- Both hire tables: the salary snapshotted next to these dates is per *game*
-- month, so the date has to be on the same calendar as the month it is billed in.
UPDATE "office_hire" AS h
SET "hired_at" =
  w."epoch" + (h."hired_at" - w."launch_date") * w."speed_multiplier"::double precision
FROM "world" AS w
WHERE w."id" = h."world_id";--> statement-breakpoint
UPDATE "executive_hire" AS h
SET "hired_at" =
  w."epoch" + (h."hired_at" - w."launch_date") * w."speed_multiplier"::double precision
FROM "world" AS w
WHERE w."id" = h."world_id";
