-- tailfin:migration-strategy expand
-- Self-handling payroll becomes an accrual (BUG-03, M5-06).
--
-- One nullable column. Additive, so the previous release runs against the result
-- unchanged: it neither writes it nor selects it by name, and its monthly sweep
-- keeps working (badly, which is the defect this closes).
--
-- **Null means never settled**, and the accrual then starts at `opened_at`.
-- Deliberately not backfilled to `now()` or to the epoch: the first would forgive
-- everything an existing operation has already earned, and the second would bill
-- it for every day of the world before it existed. `opened_at` is the only
-- instant that is true, and it is already on the row — so the fallback is the
-- correct answer rather than a compromise, and no backfill is needed to get it.

ALTER TABLE "ground_self_handling" ADD COLUMN "billed_through_at" timestamp with time zone;