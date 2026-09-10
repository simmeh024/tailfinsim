-- tailfin:migration-strategy expand
-- The training academy (M9-01, §10.1). Purely additive: two new tables, two new
-- `cash_movement_cause` values and one nullable column on `crew_conversion`. The
-- previous release reads and writes none of them — a conversion with a null
-- `academy_id` is exactly what every conversion was before this migration, a
-- course bought in at the market rate — so it keeps working against the result.
--
-- The two enum values are added and **not used** in this migration. ADR-0016
-- applies every pending migration in one transaction, and PostgreSQL refuses a
-- new enum value used in the transaction that added it (`unsafe use of new value
-- ... of enum type cash_movement_cause`), which has bitten this repository twice.
-- There is no data migration here, so nothing names them until a later request
-- does.
--
-- `academy_module`'s uniqueness is two partial indexes rather than one
-- constraint: NULLs are distinct to a unique index, so a single
-- (academy_id, kind, family) unique would happily allow six CBT suites.
CREATE TYPE "public"."academy_build_status" AS ENUM('under_construction', 'operational');--> statement-breakpoint
CREATE TYPE "public"."academy_module_kind" AS ENUM('cbt_suite', 'cabin_service_mockup', 'emergency_drill', 'fixed_base_sim', 'full_flight_sim', 'ground_ops_bay', 'dispatch_lab');--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'academy_construction' BEFORE 'admin_adjustment';--> statement-breakpoint
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'academy_upkeep' BEFORE 'admin_adjustment';--> statement-breakpoint
CREATE TABLE "academy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"crew_base_id" uuid NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"pending_level" integer,
	"construction_started_at" timestamp with time zone,
	"construction_ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academy_crew_base_key" UNIQUE("crew_base_id"),
	CONSTRAINT "academy_level_range" CHECK ("academy"."level" >= 0 AND "academy"."level" <= 5),
	CONSTRAINT "academy_pending_level_is_next" CHECK ("academy"."pending_level" IS NULL
          OR ("academy"."pending_level" = "academy"."level" + 1 AND "academy"."pending_level" <= 5)),
	CONSTRAINT "academy_construction_terms" CHECK (("academy"."pending_level" IS NULL
             AND "academy"."construction_started_at" IS NULL
             AND "academy"."construction_ready_at" IS NULL)
          OR ("academy"."pending_level" IS NOT NULL
             AND "academy"."construction_started_at" IS NOT NULL
             AND "academy"."construction_ready_at" IS NOT NULL
             AND "academy"."construction_ready_at" > "academy"."construction_started_at"))
);
--> statement-breakpoint
CREATE TABLE "academy_module" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" uuid NOT NULL,
	"kind" "academy_module_kind" NOT NULL,
	"family" text,
	"status" "academy_build_status" DEFAULT 'under_construction' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academy_module_family_matches_kind" CHECK (("academy_module"."kind" = 'full_flight_sim') = ("academy_module"."family" IS NOT NULL)),
	CONSTRAINT "academy_module_ready_after_start" CHECK ("academy_module"."ready_at" > "academy_module"."started_at"),
	CONSTRAINT "academy_module_installed_matches_status" CHECK (("academy_module"."status" = 'operational' AND "academy_module"."installed_at" IS NOT NULL)
          OR ("academy_module"."status" = 'under_construction' AND "academy_module"."installed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "crew_conversion" ADD COLUMN "academy_id" uuid;--> statement-breakpoint
ALTER TABLE "academy" ADD CONSTRAINT "academy_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy" ADD CONSTRAINT "academy_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy" ADD CONSTRAINT "academy_crew_base_id_crew_base_id_fk" FOREIGN KEY ("crew_base_id") REFERENCES "public"."crew_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_module" ADD CONSTRAINT "academy_module_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "academy_airline_idx" ON "academy" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "academy_due_idx" ON "academy" USING btree ("world_id","construction_ready_at") WHERE pending_level IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "academy_module_kind_key" ON "academy_module" USING btree ("academy_id","kind") WHERE family IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "academy_module_family_key" ON "academy_module" USING btree ("academy_id","kind","family") WHERE family IS NOT NULL;--> statement-breakpoint
CREATE INDEX "academy_module_due_idx" ON "academy_module" USING btree ("status","ready_at");--> statement-breakpoint
ALTER TABLE "crew_conversion" ADD CONSTRAINT "crew_conversion_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crew_conversion_academy_idx" ON "crew_conversion" USING btree ("academy_id","status");