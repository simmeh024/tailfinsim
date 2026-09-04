-- tailfin:migration-strategy expand
-- A flight remembers what its departure turn's handling cost (BUG-02, M5-06).
--
-- One nullable column. Additive, so the previous release runs against the result
-- unchanged: it never writes the column and never selects it by name.
--
-- **Null means the flight departed before the snapshot existed**, not that it was
-- handled at the standard rate. Deliberately not backfilled: there is no honest
-- value to backfill *with*. The arrangement a flight departed under is not
-- recoverable after the fact — `ground_contract` keeps a `status` and a term, not
-- a history of which grade was active at an instant — and writing 1.0 everywhere
-- would silently restate every in-flight aeroplane as standard-handled. The
-- settlement resolves a null the way it resolved every flight before this
-- column: live, at arrival.
--
-- The population that can carry a null is bounded and drains on its own: only
-- flights already airborne when this deploys, which settle within a game day.

ALTER TABLE "flight" ADD COLUMN "handling_price_factor" double precision;