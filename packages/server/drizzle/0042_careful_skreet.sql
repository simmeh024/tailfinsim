-- tailfin:migration-strategy expand
-- M8-01: immutable dimensional ledger lines behind the AIR-06 cash projection.

CREATE TYPE "public"."ledger_category" AS ENUM('opening_balance', 'equity', 'ticket', 'ancillary', 'cargo', 'charter', 'acmi', 'fuel', 'lease_finance', 'crew', 'office_salary', 'maintenance', 'airport_slot', 'atc', 'ground_handling', 'marketing', 'repaint_retrofit', 'interest', 'aircraft_purchase', 'asset_deposit', 'other');--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"cash_movement_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"category" "ledger_category" NOT NULL,
	"counterparty" text DEFAULT 'system' NOT NULL,
	"flight_id" uuid,
	"route_id" uuid,
	"aircraft_id" uuid,
	"hub_id" uuid,
	"cabin_class" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_movement_line_key" UNIQUE("cash_movement_id","line_number"),
	CONSTRAINT "ledger_entry_amount_safe_integer" CHECK ("ledger_entry"."amount_minor" >= -9007199254740991 AND "ledger_entry"."amount_minor" <= 9007199254740991),
	CONSTRAINT "ledger_entry_line_number_positive" CHECK ("ledger_entry"."line_number" > 0),
	CONSTRAINT "ledger_entry_counterparty_not_blank" CHECK (char_length("ledger_entry"."counterparty") > 0 AND "ledger_entry"."counterparty" = btrim("ledger_entry"."counterparty")),
	CONSTRAINT "ledger_entry_cabin_class_valid" CHECK ("ledger_entry"."cabin_class" IS NULL OR "ledger_entry"."cabin_class" IN ('economy', 'premium_economy', 'business', 'first'))
);
--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_cash_movement_id_cash_movement_id_fk" FOREIGN KEY ("cash_movement_id") REFERENCES "public"."cash_movement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entry_airline_occurred_at_idx" ON "ledger_entry" USING btree ("airline_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_entry_airline_category_occurred_at_idx" ON "ledger_entry" USING btree ("airline_id","category","occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_entry_route_occurred_at_idx" ON "ledger_entry" USING btree ("airline_id","route_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_entry_aircraft_occurred_at_idx" ON "ledger_entry" USING btree ("airline_id","aircraft_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_entry_hub_occurred_at_idx" ON "ledger_entry" USING btree ("airline_id","hub_id","occurred_at");
--> statement-breakpoint

-- Existing AIR-06 movements are preserved as one honest line each. Historic
-- line-level details cannot be reconstructed without inventing past facts.
INSERT INTO "ledger_entry" (
  "world_id", "airline_id", "cash_movement_id", "line_number", "amount_minor",
  "category", "counterparty", "occurred_at"
)
SELECT
  a."world_id", cm."airline_id", cm."id", 1, cm."amount_minor",
  CASE cm."cause"::text
    WHEN 'airline_founding' THEN 'equity'::"ledger_category"
    WHEN 'airline_rebrand' THEN 'repaint_retrofit'::"ledger_category"
    WHEN 'aircraft_lease_deposit' THEN 'asset_deposit'::"ledger_category"
    WHEN 'aircraft_used_purchase' THEN 'aircraft_purchase'::"ledger_category"
    WHEN 'aircraft_new_purchase' THEN 'aircraft_purchase'::"ledger_category"
    WHEN 'maintenance_check' THEN 'maintenance'::"ledger_category"
    WHEN 'crew_base_opening' THEN 'crew'::"ledger_category"
    WHEN 'crew_hiring' THEN 'crew'::"ledger_category"
    WHEN 'crew_conversion' THEN 'crew'::"ledger_category"
    WHEN 'crew_payroll' THEN 'crew'::"ledger_category"
    WHEN 'crew_base_overhead' THEN 'crew'::"ledger_category"
    WHEN 'crew_positioning' THEN 'crew'::"ledger_category"
    WHEN 'office_salary' THEN 'office_salary'::"ledger_category"
    WHEN 'office_expansion' THEN 'other'::"ledger_category"
    WHEN 'disruption_cost' THEN 'other'::"ledger_category"
    WHEN 'admin_adjustment' THEN 'equity'::"ledger_category"
    WHEN 'flight_settlement' THEN 'other'::"ledger_category"
    WHEN 'migration_opening_balance' THEN 'opening_balance'::"ledger_category"
  END,
  'system', cm."occurred_at"
FROM "cash_movement" cm
JOIN "airline" a ON a."id" = cm."airline_id";--> statement-breakpoint

CREATE FUNCTION "enforce_airline_ledger_reconciliation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_airline_id uuid;
  stored_balance bigint;
  ledger_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'airline' THEN
    target_airline_id := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_airline_id := OLD."airline_id";
  ELSE
    target_airline_id := NEW."airline_id";
  END IF;

  SELECT "cash_minor" INTO stored_balance FROM "airline" WHERE "id" = target_airline_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum("amount_minor"), 0) INTO ledger_total
  FROM "ledger_entry" WHERE "airline_id" = target_airline_id;

  IF stored_balance::numeric <> ledger_total THEN
    RAISE EXCEPTION 'Airline % cash % does not equal ledger total %',
      target_airline_id, stored_balance, ledger_total
      USING ERRCODE = '23514', CONSTRAINT = 'airline_ledger_reconciles';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "airline_ledger_reconciles"
AFTER INSERT OR UPDATE ON "airline"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "enforce_airline_ledger_reconciliation"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "cash_movement_ledger_reconciles"
AFTER INSERT OR DELETE ON "cash_movement"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "enforce_airline_ledger_reconciliation"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "ledger_entry_reconciles"
AFTER INSERT OR UPDATE OR DELETE ON "ledger_entry"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION "enforce_airline_ledger_reconciliation"();--> statement-breakpoint

CREATE FUNCTION "refuse_ledger_entry_update"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'ledger_entry_immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ledger_entry_immutable"
BEFORE UPDATE ON "ledger_entry"
FOR EACH ROW EXECUTE FUNCTION "refuse_ledger_entry_update"();
