-- tailfin:migration-strategy expand
-- One new table. No previous release reads or writes it, nothing existing
-- changes shape, and no constraint tightens on any column that already exists.
-- `world.aircraft_catalogue_version` keeps its meaning: the preceding build
-- never resolved it against anything, so it is unaffected by this table being
-- empty, populated or absent. Rolling back leaves the rows in place, unread.

CREATE TABLE "aircraft_type" (
	"catalogue_version" text NOT NULL,
	"designation" text NOT NULL,
	"family" text NOT NULL,
	"manufacturer" text NOT NULL,
	"class" text NOT NULL,
	"maintenance_profile" text NOT NULL,
	"base_spec" text NOT NULL,
	"era_dates" text NOT NULL,
	"first_flight" timestamp with time zone,
	"entry_into_service" timestamp with time zone,
	"production_end" timestamp with time zone,
	"out_of_service" timestamp with time zone,
	"list_price_minor" bigint,
	"monthly_lease_rate_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_label" text NOT NULL,
	CONSTRAINT "aircraft_type_catalogue_version_designation_pk" PRIMARY KEY("catalogue_version","designation"),
	CONSTRAINT "aircraft_type_era_dates_ordered" CHECK (("aircraft_type"."first_flight" IS NULL OR "aircraft_type"."entry_into_service" IS NULL
           OR "aircraft_type"."first_flight" <= "aircraft_type"."entry_into_service")
          AND ("aircraft_type"."entry_into_service" IS NULL OR "aircraft_type"."production_end" IS NULL
           OR "aircraft_type"."entry_into_service" <= "aircraft_type"."production_end")
          AND ("aircraft_type"."production_end" IS NULL OR "aircraft_type"."out_of_service" IS NULL
           OR "aircraft_type"."production_end" <= "aircraft_type"."out_of_service")),
	CONSTRAINT "aircraft_type_prices_nonnegative" CHECK (("aircraft_type"."list_price_minor" IS NULL OR "aircraft_type"."list_price_minor" >= 0)
          AND ("aircraft_type"."monthly_lease_rate_minor" IS NULL OR "aircraft_type"."monthly_lease_rate_minor" >= 0))
);
--> statement-breakpoint
CREATE INDEX "aircraft_type_version_eis_idx" ON "aircraft_type" USING btree ("catalogue_version","entry_into_service");
--> statement-breakpoint
-- A catalogue version is immutable, and this is what makes that true.
--
-- A world flying a type has that type's performance baked into every
-- flight_result it has ever settled — block time, fuel burn, landing fees. A
-- specification that could change underneath those would make an old flight
-- inexplicable, which is CONTRIBUTING invariant 4 failing quietly and months
-- later. Retuning an aircraft is a *new catalogue version*, and moving a world
-- to it is a deliberate act.
--
-- Same idiom as admin_audit and economy_config, and for the same reason: a
-- convention fails on the day somebody wants a number quietly changed, and a
-- trigger refuses regardless of who is asking.
--
-- The TRUNCATE trigger is not redundant: TRUNCATE bypasses row-level triggers
-- entirely, so without a statement-level one the whole catalogue could be
-- emptied in a single statement while both row triggers watched.
CREATE OR REPLACE FUNCTION aircraft_type_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'aircraft_type is immutable; % is not permitted. Publish a new catalogue version instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER aircraft_type_no_update
  BEFORE UPDATE ON aircraft_type
  FOR EACH ROW EXECUTE FUNCTION aircraft_type_is_immutable();
--> statement-breakpoint
CREATE TRIGGER aircraft_type_no_delete
  BEFORE DELETE ON aircraft_type
  FOR EACH ROW EXECUTE FUNCTION aircraft_type_is_immutable();
--> statement-breakpoint
CREATE TRIGGER aircraft_type_no_truncate
  BEFORE TRUNCATE ON aircraft_type
  FOR EACH STATEMENT EXECUTE FUNCTION aircraft_type_is_immutable();
