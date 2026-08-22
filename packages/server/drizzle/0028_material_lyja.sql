-- tailfin:migration-strategy expand
-- Aircraft acquisition and physical airframes (M4-04, §7.2, App. B.4, C.5–C.6).
--
-- This is an additive, rolling-compatible change: the previous web/worker build
-- knows none of the new tables or enum values and continues using every existing
-- column unchanged. `base_delivery_lead_weeks` has a non-null default so its old
-- aircraft_type INSERT remains valid during a rolling deploy.
--
-- There is one exact data correction below. M4-04 is the first code that can
-- consume a lease term, and Appendix B.4 fixes the ATR 72 deposit at $170k for
-- two months. The earlier catalogue display used the generic commercial estimate
-- ($208k/month); it had never been charged. We briefly remove only the UPDATE
-- trigger, correct only that one v1 row to $85k/month, and immediately restore
-- the immutability guard. No aerodynamic or already-settled fact changes.

CREATE TYPE "public"."aircraft_acquisition_kind" AS ENUM('lease', 'used', 'new');--> statement-breakpoint
CREATE TYPE "public"."aircraft_order_status" AS ENUM('pending', 'delivered');--> statement-breakpoint
CREATE TYPE "public"."airframe_ownership" AS ENUM('owned', 'leased', 'financed');--> statement-breakpoint
CREATE TYPE "public"."used_aircraft_listing_status" AS ENUM('available', 'sold', 'withdrawn');--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'aircraft_lease_deposit' BEFORE 'flight_settlement';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'aircraft_used_purchase' BEFORE 'flight_settlement';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'aircraft_new_purchase' BEFORE 'flight_settlement';--> statement-breakpoint
CREATE TABLE "aircraft_order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"kind" "aircraft_acquisition_kind" NOT NULL,
	"status" "aircraft_order_status" NOT NULL,
	"catalogue_version" text NOT NULL,
	"type_designation" text NOT NULL,
	"build_option_ids" text DEFAULT '[]' NOT NULL,
	"cabin_config_id" uuid,
	"livery_id" uuid,
	"effective_spec" text NOT NULL,
	"owner_history" text DEFAULT '[]' NOT NULL,
	"hours" double precision DEFAULT 0 NOT NULL,
	"cycles" integer DEFAULT 0 NOT NULL,
	"charged_minor" bigint NOT NULL,
	"monthly_lease_rate_minor" bigint,
	"base_lead_time_weeks" integer NOT NULL,
	"option_lead_time_weeks" integer NOT NULL,
	"delivery_airport_icao" text NOT NULL,
	"used_listing_id" uuid,
	"ordered_at" timestamp with time zone NOT NULL,
	"delivery_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "aircraft_order_used_listing_id_unique" UNIQUE("used_listing_id"),
	CONSTRAINT "aircraft_order_charge_nonnegative" CHECK ("aircraft_order"."charged_minor" >= 0),
	CONSTRAINT "aircraft_order_lease_rate_nonnegative" CHECK ("aircraft_order"."monthly_lease_rate_minor" IS NULL OR "aircraft_order"."monthly_lease_rate_minor" >= 0),
	CONSTRAINT "aircraft_order_lead_times_nonnegative" CHECK ("aircraft_order"."base_lead_time_weeks" >= 0 AND "aircraft_order"."option_lead_time_weeks" >= 0),
	CONSTRAINT "aircraft_order_hours_nonnegative" CHECK ("aircraft_order"."hours" >= 0),
	CONSTRAINT "aircraft_order_cycles_nonnegative" CHECK ("aircraft_order"."cycles" >= 0),
	CONSTRAINT "aircraft_order_delivery_not_before_order" CHECK ("aircraft_order"."delivery_at" >= "aircraft_order"."ordered_at"),
	CONSTRAINT "aircraft_order_delivered_at_matches_status" CHECK (("aircraft_order"."status" = 'delivered' AND "aircraft_order"."delivered_at" IS NOT NULL)
          OR ("aircraft_order"."status" = 'pending' AND "aircraft_order"."delivered_at" IS NULL)),
	CONSTRAINT "aircraft_order_kind_terms_match" CHECK (("aircraft_order"."kind" = 'lease' AND "aircraft_order"."monthly_lease_rate_minor" IS NOT NULL AND "aircraft_order"."used_listing_id" IS NULL)
          OR ("aircraft_order"."kind" = 'used' AND "aircraft_order"."monthly_lease_rate_minor" IS NULL AND "aircraft_order"."used_listing_id" IS NOT NULL)
          OR ("aircraft_order"."kind" = 'new' AND "aircraft_order"."monthly_lease_rate_minor" IS NULL AND "aircraft_order"."used_listing_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "airframe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"source_order_id" uuid NOT NULL,
	"catalogue_version" text NOT NULL,
	"type_designation" text NOT NULL,
	"registration" text NOT NULL,
	"build_option_ids" text DEFAULT '[]' NOT NULL,
	"cabin_config_id" uuid,
	"livery_id" uuid,
	"effective_spec" text NOT NULL,
	"owner_history" text DEFAULT '[]' NOT NULL,
	"hours" double precision DEFAULT 0 NOT NULL,
	"cycles" integer DEFAULT 0 NOT NULL,
	"ownership" "airframe_ownership" NOT NULL,
	"delivered_to_icao" text NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airframe_source_order_id_unique" UNIQUE("source_order_id"),
	CONSTRAINT "airframe_world_registration_key" UNIQUE("world_id","registration"),
	CONSTRAINT "airframe_hours_nonnegative" CHECK ("airframe"."hours" >= 0),
	CONSTRAINT "airframe_cycles_nonnegative" CHECK ("airframe"."cycles" >= 0),
	CONSTRAINT "airframe_registration_not_blank" CHECK (char_length("airframe"."registration") BETWEEN 2 AND 10 AND "airframe"."registration" = btrim("airframe"."registration"))
);
--> statement-breakpoint
CREATE TABLE "used_aircraft_listing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"catalogue_version" text NOT NULL,
	"type_designation" text NOT NULL,
	"registration" text NOT NULL,
	"build_option_ids" text DEFAULT '[]' NOT NULL,
	"cabin_config_id" uuid,
	"livery_id" uuid,
	"effective_spec" text NOT NULL,
	"owner_history" text DEFAULT '[]' NOT NULL,
	"hours" double precision NOT NULL,
	"cycles" integer NOT NULL,
	"asking_price_minor" bigint NOT NULL,
	"location_icao" text NOT NULL,
	"status" "used_aircraft_listing_status" DEFAULT 'available' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sold_at" timestamp with time zone,
	CONSTRAINT "used_aircraft_listing_hours_nonnegative" CHECK ("used_aircraft_listing"."hours" >= 0),
	CONSTRAINT "used_aircraft_listing_cycles_nonnegative" CHECK ("used_aircraft_listing"."cycles" >= 0),
	CONSTRAINT "used_aircraft_listing_price_nonnegative" CHECK ("used_aircraft_listing"."asking_price_minor" >= 0),
	CONSTRAINT "used_aircraft_listing_sold_at_matches_status" CHECK (("used_aircraft_listing"."status" = 'sold' AND "used_aircraft_listing"."sold_at" IS NOT NULL)
          OR ("used_aircraft_listing"."status" <> 'sold' AND "used_aircraft_listing"."sold_at" IS NULL)),
	CONSTRAINT "used_aircraft_listing_registration_not_blank" CHECK (char_length("used_aircraft_listing"."registration") BETWEEN 2 AND 10 AND "used_aircraft_listing"."registration" = btrim("used_aircraft_listing"."registration"))
);
--> statement-breakpoint
ALTER TABLE "aircraft_type" ADD COLUMN "base_delivery_lead_weeks" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
DROP TRIGGER aircraft_type_no_update ON aircraft_type;--> statement-breakpoint
UPDATE aircraft_type
SET monthly_lease_rate_minor = 8500000
WHERE catalogue_version = 'v1'
  AND designation = 'ATR 72-600';--> statement-breakpoint
CREATE TRIGGER aircraft_type_no_update
  BEFORE UPDATE ON aircraft_type
  FOR EACH ROW EXECUTE FUNCTION aircraft_type_is_immutable();--> statement-breakpoint
ALTER TABLE "aircraft_order" ADD CONSTRAINT "aircraft_order_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aircraft_order" ADD CONSTRAINT "aircraft_order_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aircraft_order" ADD CONSTRAINT "aircraft_order_delivery_airport_icao_airport_icao_code_fk" FOREIGN KEY ("delivery_airport_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aircraft_order" ADD CONSTRAINT "aircraft_order_used_listing_id_used_aircraft_listing_id_fk" FOREIGN KEY ("used_listing_id") REFERENCES "public"."used_aircraft_listing"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airframe" ADD CONSTRAINT "airframe_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airframe" ADD CONSTRAINT "airframe_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airframe" ADD CONSTRAINT "airframe_source_order_id_aircraft_order_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."aircraft_order"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airframe" ADD CONSTRAINT "airframe_delivered_to_icao_airport_icao_code_fk" FOREIGN KEY ("delivered_to_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD CONSTRAINT "used_aircraft_listing_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD CONSTRAINT "used_aircraft_listing_location_icao_airport_icao_code_fk" FOREIGN KEY ("location_icao") REFERENCES "public"."airport"("icao_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aircraft_order_airline_ordered_at_idx" ON "aircraft_order" USING btree ("airline_id","ordered_at");--> statement-breakpoint
CREATE INDEX "aircraft_order_due_idx" ON "aircraft_order" USING btree ("world_id","status","delivery_at");--> statement-breakpoint
CREATE INDEX "airframe_airline_id_idx" ON "airframe" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "used_aircraft_listing_world_status_idx" ON "used_aircraft_listing" USING btree ("world_id","status","available_at");--> statement-breakpoint
ALTER TABLE "aircraft_type" ADD CONSTRAINT "aircraft_type_base_delivery_positive" CHECK ("aircraft_type"."base_delivery_lead_weeks" > 0);
--> statement-breakpoint
-- The commercial/build snapshot is permanent. Delivery is the one allowed
-- transition: pending -> delivered, with the real delivered_at instant. Using
-- to_jsonb keeps the guard complete when a column is added later; forgetting to
-- extend a hand-written comparison would silently make that new fact mutable.
CREATE OR REPLACE FUNCTION aircraft_order_delivery_only() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'delivered_at')
       IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'delivered_at') THEN
    RAISE EXCEPTION 'aircraft_order commercial and build facts are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'pending'
     AND OLD.delivered_at IS NULL
     AND NEW.status = 'delivered'
     AND NEW.delivered_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'aircraft_order permits only pending -> delivered'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER aircraft_order_delivery_only
  BEFORE UPDATE ON aircraft_order
  FOR EACH ROW EXECUTE FUNCTION aircraft_order_delivery_only();
