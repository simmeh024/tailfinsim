-- tailfin:migration-strategy expand
-- §10.3's research tree (M9-05). Purely additive: two new tables and one new
-- `cash_movement_cause` value. The previous release reads and writes none of
-- them — it settles flights without accruing points and has no research routes
-- — so it keeps working against the result, and a rollback to it simply leaves
-- the new tables untouched.
--
-- The enum value is added and **not used** here. ADR-0016 applies every pending
-- migration in one transaction, and PostgreSQL refuses a new enum value used in
-- the transaction that added it (`unsafe use of new value ... of enum type
-- cash_movement_cause`). There is no data migration, so nothing names `research`
-- until a later request does.
--
-- No backfill either, and that is deliberate rather than an omission: research
-- points are earned by flights settled from here on. A flight settled before
-- this migration earned nothing, because there was nothing to earn — awarding
-- it retroactively would be inventing points for history nobody was researching
-- with.
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'research' BEFORE 'admin_adjustment';--> statement-breakpoint
CREATE TABLE "research_account" (
	"airline_id" uuid PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"earned_milli" bigint DEFAULT 0 NOT NULL,
	"spent_milli" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_account_earned_range" CHECK ("research_account"."earned_milli" >= 0 AND "research_account"."earned_milli" <= 9007199254740991),
	CONSTRAINT "research_account_spent_nonneg" CHECK ("research_account"."spent_milli" >= 0),
	CONSTRAINT "research_account_spent_within_earned" CHECK ("research_account"."spent_milli" <= "research_account"."earned_milli")
);
--> statement-breakpoint
CREATE TABLE "research_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"airline_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completes_at" timestamp with time zone NOT NULL,
	"research_points" integer NOT NULL,
	"cash_cost_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_project_airline_node_key" UNIQUE("airline_id","node_id"),
	CONSTRAINT "research_project_points_positive" CHECK ("research_project"."research_points" > 0),
	CONSTRAINT "research_project_cash_positive" CHECK ("research_project"."cash_cost_minor" > 0),
	CONSTRAINT "research_project_completes_after_start" CHECK ("research_project"."completes_at" > "research_project"."started_at"),
	CONSTRAINT "research_project_node_not_blank" CHECK (char_length("research_project"."node_id") > 0 AND "research_project"."node_id" = btrim("research_project"."node_id"))
);
--> statement-breakpoint
ALTER TABLE "research_account" ADD CONSTRAINT "research_account_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_account" ADD CONSTRAINT "research_account_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_project" ADD CONSTRAINT "research_project_world_id_world_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."world"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_project" ADD CONSTRAINT "research_project_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;