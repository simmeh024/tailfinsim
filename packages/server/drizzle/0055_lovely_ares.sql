-- tailfin:migration-strategy expand
-- Service packages and route groups (M8-03, App. D).
--
-- Three new tables and nothing touched. Purely additive, so the previous release
-- runs against the result unchanged: it does not know these tables exist, and
-- every existing query is untouched by them.
--
-- `route_group.service_package_id` is `ON DELETE SET NULL` on purpose. The API
-- refuses to delete a package a group still holds — a 409 naming the groups is a
-- more useful answer than a constraint violation — but the database must not
-- refuse, because deleting an airline cascades into `service_package` and
-- `route_group` at once and a RESTRICT would turn that into an error.
--
-- `route_group_member.route_id` is UNIQUE across the whole table rather than
-- within a group: a route belongs to at most one group, which is what makes
-- "which package does this flight fly under?" a question with exactly one answer.

CREATE TABLE "route_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"service_package_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_group_airline_name_key" UNIQUE("airline_id","name")
);
--> statement-breakpoint
CREATE TABLE "route_group_member" (
	"route_group_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	CONSTRAINT "route_group_member_route_group_id_route_id_pk" PRIMARY KEY("route_group_id","route_id"),
	CONSTRAINT "route_group_member_route_key" UNIQUE("route_id")
);
--> statement-breakpoint
CREATE TABLE "service_package" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_package_airline_name_key" UNIQUE("airline_id","name")
);
--> statement-breakpoint
ALTER TABLE "route_group" ADD CONSTRAINT "route_group_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_group" ADD CONSTRAINT "route_group_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_group" ADD CONSTRAINT "route_group_service_package_id_service_package_id_fk" FOREIGN KEY ("service_package_id") REFERENCES "public"."service_package"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_group_member" ADD CONSTRAINT "route_group_member_route_group_id_route_group_id_fk" FOREIGN KEY ("route_group_id") REFERENCES "public"."route_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_group_member" ADD CONSTRAINT "route_group_member_route_id_route_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."route"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_package" ADD CONSTRAINT "service_package_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_package" ADD CONSTRAINT "service_package_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_group_airline_id_idx" ON "route_group" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "route_group_world_id_idx" ON "route_group" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "route_group_member_group_idx" ON "route_group_member" USING btree ("route_group_id");--> statement-breakpoint
CREATE INDEX "service_package_airline_id_idx" ON "service_package" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "service_package_world_id_idx" ON "service_package" USING btree ("world_id");