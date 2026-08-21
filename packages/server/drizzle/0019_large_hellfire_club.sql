CREATE TYPE "public"."cash_movement_cause" AS ENUM('airline_founding', 'flight_settlement', 'migration_opening_balance');--> statement-breakpoint
CREATE TABLE "cash_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"airline_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"cause" "cash_movement_cause" NOT NULL,
	"reference" text NOT NULL,
	"balance_after_minor" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movement_cause_reference_key" UNIQUE("cause","reference"),
	CONSTRAINT "cash_movement_amount_safe_integer" CHECK ("cash_movement"."amount_minor" >= -9007199254740991 AND "cash_movement"."amount_minor" <= 9007199254740991),
	CONSTRAINT "cash_movement_balance_safe_integer" CHECK ("cash_movement"."balance_after_minor" >= -9007199254740991 AND "cash_movement"."balance_after_minor" <= 9007199254740991),
	CONSTRAINT "cash_movement_reference_not_blank" CHECK (char_length("cash_movement"."reference") > 0 AND "cash_movement"."reference" = btrim("cash_movement"."reference"))
);
--> statement-breakpoint
ALTER TABLE "airline" DROP CONSTRAINT "airline_cash_finite";--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movement_airline_id_occurred_at_idx" ON "cash_movement" USING btree ("airline_id","occurred_at");--> statement-breakpoint
-- AIR-06 starts the explainable ledger without pretending historical flights can be
-- reconstructed. Each existing airline receives one honest opening snapshot at migration
-- time, so sum(movements) equals cash_minor from the first post-migration transaction.
INSERT INTO "cash_movement" (
	"airline_id",
	"amount_minor",
	"cause",
	"reference",
	"balance_after_minor",
	"occurred_at"
)
SELECT
	"id",
	"cash_minor",
	'migration_opening_balance',
	"id"::text,
	"cash_minor",
	now()
FROM "airline";--> statement-breakpoint
ALTER TABLE "airline" ADD CONSTRAINT "airline_cash_safe_integer" CHECK ("airline"."cash_minor" >= -9007199254740991 AND "airline"."cash_minor" <= 9007199254740991);--> statement-breakpoint
-- A deferred constraint checks the final transaction state, so the movement and materialised
-- balance may be written in either order but can never commit separately. It also makes a
-- direct cash_minor update or a deleted movement fail closed instead of creating silent drift.
CREATE FUNCTION "enforce_airline_cash_reconciliation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_airline_id uuid;
	stored_balance bigint;
	movement_total numeric;
BEGIN
	IF TG_TABLE_NAME = 'airline' THEN
		target_airline_id := NEW."id";
	ELSIF TG_OP = 'DELETE' THEN
		target_airline_id := OLD."airline_id";
	ELSE
		target_airline_id := NEW."airline_id";
	END IF;

	SELECT "cash_minor" INTO stored_balance
	FROM "airline"
	WHERE "id" = target_airline_id;

	-- Deleting an airline deliberately cascades its movements (world reset). There is no
	-- surviving balance to reconcile in that case.
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	SELECT coalesce(sum("amount_minor"), 0) INTO movement_total
	FROM "cash_movement"
	WHERE "airline_id" = target_airline_id;

	IF stored_balance::numeric <> movement_total THEN
		RAISE EXCEPTION 'Airline % cash % does not equal movement total %',
			target_airline_id, stored_balance, movement_total
			USING ERRCODE = '23514', CONSTRAINT = 'airline_cash_reconciles';
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "airline_cash_reconciles"
AFTER INSERT OR UPDATE ON "airline"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_airline_cash_reconciliation"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "cash_movement_reconciles"
AFTER INSERT OR DELETE ON "cash_movement"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_airline_cash_reconciliation"();--> statement-breakpoint
-- Corrections are compensating movements, never edits. Deletes remain possible only when the
-- owning airline is deleted; an isolated delete is rejected by the deferred reconciliation.
CREATE FUNCTION "refuse_cash_movement_update"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'cash movements are immutable'
		USING ERRCODE = '23514', CONSTRAINT = 'cash_movement_immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "cash_movement_immutable"
BEFORE UPDATE ON "cash_movement"
FOR EACH ROW EXECUTE FUNCTION "refuse_cash_movement_update"();
