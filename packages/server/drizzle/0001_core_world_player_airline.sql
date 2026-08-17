CREATE TYPE "public"."auth_provider" AS ENUM('google');--> statement-breakpoint
CREATE TYPE "public"."world_status" AS ENUM('staging', 'open', 'locked', 'archived');--> statement-breakpoint
CREATE TABLE "airline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"name" text NOT NULL,
	"iata_code" text NOT NULL,
	"icao_code" text NOT NULL,
	"callsign" text NOT NULL,
	"base_country" text NOT NULL,
	"cash_minor" bigint DEFAULT 0 NOT NULL,
	"reputation" numeric(3, 2) DEFAULT '0.35' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airline_world_id_iata_code_key" UNIQUE("world_id","iata_code"),
	CONSTRAINT "airline_world_id_icao_code_key" UNIQUE("world_id","icao_code"),
	CONSTRAINT "airline_world_id_player_id_key" UNIQUE("world_id","player_id"),
	CONSTRAINT "airline_reputation_range" CHECK ("airline"."reputation" >= 0 AND "airline"."reputation" <= 1),
	CONSTRAINT "airline_iata_code_format" CHECK ("airline"."iata_code" ~ '^[A-Z0-9]{2}$'),
	CONSTRAINT "airline_icao_code_format" CHECK ("airline"."icao_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "airline_base_country_format" CHECK ("airline"."base_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "airline_cash_finite" CHECK ("airline"."cash_minor" > -9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "player" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_identity_provider_subject_key" UNIQUE("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "world" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"epoch" timestamp with time zone NOT NULL,
	"launch_date" timestamp with time zone NOT NULL,
	"speed_multiplier" numeric(4, 2) NOT NULL,
	"status" "world_status" DEFAULT 'staging' NOT NULL,
	"aircraft_catalogue_version" text NOT NULL,
	"economy_config_version" text NOT NULL,
	"player_cap" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "world_name_key" UNIQUE("name"),
	CONSTRAINT "world_speed_multiplier_positive" CHECK ("world"."speed_multiplier" > 0),
	CONSTRAINT "world_player_cap_positive" CHECK ("world"."player_cap" IS NULL OR "world"."player_cap" > 0)
);
--> statement-breakpoint
ALTER TABLE "airline" ADD CONSTRAINT "airline_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airline" ADD CONSTRAINT "airline_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_identity" ADD CONSTRAINT "player_identity_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airline_world_id_idx" ON "airline" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "airline_player_id_idx" ON "airline" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "player_identity_player_id_idx" ON "player_identity" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "world_status_idx" ON "world" USING btree ("status");