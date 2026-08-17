CREATE TYPE "public"."airport_kind" AS ENUM('large_airport', 'medium_airport', 'small_airport', 'heliport', 'seaplane_base', 'balloonport', 'closed');--> statement-breakpoint
CREATE TYPE "public"."runway_surface" AS ENUM('asphalt', 'concrete', 'gravel', 'grass', 'water', 'other');--> statement-breakpoint
CREATE TABLE "airport" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" integer NOT NULL,
	"ident" text NOT NULL,
	"icao_code" text,
	"iata_code" text,
	"name" text NOT NULL,
	"municipality" text,
	"iso_country" text NOT NULL,
	"iso_region" text,
	"continent" text,
	"kind" "airport_kind" NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"elevation_ft" integer,
	"scheduled_service" boolean NOT NULL,
	"has_runway_data" boolean NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airport_ident_key" UNIQUE("ident"),
	CONSTRAINT "airport_source_id_key" UNIQUE("source_id"),
	CONSTRAINT "airport_icao_code_key" UNIQUE("icao_code"),
	CONSTRAINT "airport_iata_code_key" UNIQUE("iata_code"),
	CONSTRAINT "airport_latitude_range" CHECK ("airport"."latitude" >= -90 AND "airport"."latitude" <= 90),
	CONSTRAINT "airport_longitude_range" CHECK ("airport"."longitude" >= -180 AND "airport"."longitude" <= 180),
	CONSTRAINT "airport_not_null_island" CHECK (NOT ("airport"."latitude" = 0 AND "airport"."longitude" = 0)),
	CONSTRAINT "airport_elevation_plausible" CHECK ("airport"."elevation_ft" IS NULL OR ("airport"."elevation_ft" >= -2000 AND "airport"."elevation_ft" <= 30000)),
	CONSTRAINT "airport_icao_code_format" CHECK ("airport"."icao_code" IS NULL OR "airport"."icao_code" ~ '^[A-Z0-9]{4}$'),
	CONSTRAINT "airport_iata_code_format" CHECK ("airport"."iata_code" IS NULL OR "airport"."iata_code" ~ '^[A-Z0-9]{3}$'),
	CONSTRAINT "airport_iso_country_format" CHECK ("airport"."iso_country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "dataset_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset" text NOT NULL,
	"version" text NOT NULL,
	"source_url" text NOT NULL,
	"checksum" text NOT NULL,
	"row_counts" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_version_dataset_checksum_key" UNIQUE("dataset","checksum"),
	CONSTRAINT "dataset_version_checksum_is_sha256" CHECK (length("dataset_version"."checksum") = 64)
);
--> statement-breakpoint
CREATE TABLE "runway" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" integer NOT NULL,
	"airport_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"length_ft" integer,
	"width_ft" integer,
	"surface_raw" text,
	"surface" "runway_surface" NOT NULL,
	"lighted" boolean NOT NULL,
	"closed" boolean NOT NULL,
	CONSTRAINT "runway_source_id_key" UNIQUE("source_id"),
	CONSTRAINT "runway_length_positive" CHECK ("runway"."length_ft" IS NULL OR "runway"."length_ft" > 0),
	CONSTRAINT "runway_width_positive" CHECK ("runway"."width_ft" IS NULL OR "runway"."width_ft" > 0)
);
--> statement-breakpoint
ALTER TABLE "runway" ADD CONSTRAINT "runway_airport_id_airport_id_fk" FOREIGN KEY ("airport_id") REFERENCES "public"."airport"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airport_iso_country_idx" ON "airport" USING btree ("iso_country");--> statement-breakpoint
CREATE INDEX "airport_scheduled_service_idx" ON "airport" USING btree ("scheduled_service");--> statement-breakpoint
CREATE INDEX "airport_kind_scheduled_service_idx" ON "airport" USING btree ("kind","scheduled_service");--> statement-breakpoint
CREATE INDEX "dataset_version_dataset_imported_at_idx" ON "dataset_version" USING btree ("dataset","imported_at");--> statement-breakpoint
CREATE INDEX "runway_airport_id_idx" ON "runway" USING btree ("airport_id");