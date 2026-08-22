-- tailfin:migration-strategy expand
-- Factory options, as two new tables (M4-03, App. C.3, C.6).
--
-- Purely additive: two tables that did not exist, no change to any existing
-- table, column or constraint. The previous release reads and writes neither,
-- so it keeps working untouched — it seeds and loads `aircraft_type` exactly as
-- before and simply offers no configurator.
--
-- ## Why the availability is a table and not a column on aircraft_type
--
-- C.6 puts `available_options[]` on the type, which reads like a column. It
-- cannot be one. `aircraft_type` rows are immutable by the triggers migration
-- 0025 installed, so a column added here could never be backfilled for the v1
-- rows already seeded into dev's database: every existing world would offer an
-- empty configurator for ever, and the only repair would be re-authoring
-- eighteen aircraft as a v2 that differed from v1 in nothing else.
--
-- `aircraft_type_option` has none of that problem. It is new, so there is
-- nothing to backfill, and the seed completes v1's availability on a database
-- that already holds v1's types — the same "a partially-present version is
-- completed rather than refused" behaviour `seedAircraftCatalogue` already
-- documents for the types themselves.
--
-- ## Immutable, like the types
--
-- An airframe ordered with three auxiliary tanks has that build's weight and
-- range folded into every flight_result it ever settled. A delta that could
-- change underneath it would make an old flight inexplicable, which is
-- invariant 4 failing silently months later. Retuning an option is a new
-- catalogue version, and moving a world to it is a deliberate act.

CREATE TABLE "aircraft_option" (
	"catalogue_version" text NOT NULL,
	"option_id" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"category" text NOT NULL,
	"spec_deltas" text NOT NULL,
	"price_minor" bigint NOT NULL,
	"lead_time_weeks" integer NOT NULL,
	"retrofittable" boolean NOT NULL,
	"requires_research" text NOT NULL,
	"conflicts_with" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_label" text NOT NULL,
	CONSTRAINT "aircraft_option_catalogue_version_option_id_pk" PRIMARY KEY("catalogue_version","option_id"),
	CONSTRAINT "aircraft_option_price_nonnegative" CHECK ("aircraft_option"."price_minor" >= 0),
	CONSTRAINT "aircraft_option_lead_time_nonnegative" CHECK ("aircraft_option"."lead_time_weeks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "aircraft_type_option" (
	"catalogue_version" text NOT NULL,
	"designation" text NOT NULL,
	"option_id" text NOT NULL,
	CONSTRAINT "aircraft_type_option_catalogue_version_designation_option_id_pk" PRIMARY KEY("catalogue_version","designation","option_id")
);
--> statement-breakpoint
CREATE INDEX "aircraft_type_option_type_idx" ON "aircraft_type_option" USING btree ("catalogue_version","designation");--> statement-breakpoint
-- The same guard migration 0025 put on aircraft_type, for the same reason.
CREATE OR REPLACE FUNCTION aircraft_option_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'aircraft_option is immutable; % is not permitted. Publish a new catalogue version instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER aircraft_option_no_update
  BEFORE UPDATE ON aircraft_option
  FOR EACH ROW EXECUTE FUNCTION aircraft_option_is_immutable();--> statement-breakpoint
CREATE TRIGGER aircraft_option_no_delete
  BEFORE DELETE ON aircraft_option
  FOR EACH ROW EXECUTE FUNCTION aircraft_option_is_immutable();--> statement-breakpoint
CREATE TRIGGER aircraft_option_no_truncate
  BEFORE TRUNCATE ON aircraft_option
  FOR EACH STATEMENT EXECUTE FUNCTION aircraft_option_is_immutable();--> statement-breakpoint
-- Availability is part of the version too: which options a type could be
-- ordered with is as much a fact about a settled flight as the option's deltas.
CREATE OR REPLACE FUNCTION aircraft_type_option_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'aircraft_type_option is immutable; % is not permitted. Publish a new catalogue version instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER aircraft_type_option_no_update
  BEFORE UPDATE ON aircraft_type_option
  FOR EACH ROW EXECUTE FUNCTION aircraft_type_option_is_immutable();--> statement-breakpoint
CREATE TRIGGER aircraft_type_option_no_delete
  BEFORE DELETE ON aircraft_type_option
  FOR EACH ROW EXECUTE FUNCTION aircraft_type_option_is_immutable();--> statement-breakpoint
CREATE TRIGGER aircraft_type_option_no_truncate
  BEFORE TRUNCATE ON aircraft_type_option
  FOR EACH STATEMENT EXECUTE FUNCTION aircraft_type_option_is_immutable();
