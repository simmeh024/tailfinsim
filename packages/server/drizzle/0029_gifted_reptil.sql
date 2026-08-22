-- tailfin:migration-strategy expand
-- Used-aircraft market generation and depreciation (M4-05, App. C.5).
--
-- Purely additive: five nullable columns on used_aircraft_listing, one on
-- aircraft_order and one on airframe, plus one index, one unique constraint and
-- three checks. No column changes type, loses a default or becomes NOT NULL.
--
-- Rolling-compatible in both directions, which is what expand has to mean here:
--
--   * the previous build INSERTs none of the new columns, and every one of them
--     is nullable, so its writes stay valid while this build is rolling out;
--   * this build treats a listing with a NULL slot as hand-made and leaves it
--     alone, so M4-04's rows and any row a test wrote survive untouched.
--
-- The unique constraint is the load-bearing part. (world_id, slot_index,
-- generation_index) is one row per market berth per generation, for ever, and it
-- is what makes the refresh idempotent by construction: the engine ticks every
-- second, a generation lasts a game week, and the database is what stops the
-- second call rather than a lock or a remembered timestamp. Postgres treats
-- NULLs in a unique constraint as distinct, so the pre-existing slot-less rows
-- do not collide with each other or with anything this adds.
--
-- No trigger and no immutability guard. A listing is not an immutable fact like
-- an aircraft_type or an economy_config row -- it is withdrawn, sold and
-- expired, all of which are UPDATEs -- and its price snapshot is protected by
-- being written once at generation rather than by being unwritable.

ALTER TABLE "aircraft_order" ADD COLUMN "built_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "airframe" ADD COLUMN "built_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD COLUMN "slot_index" integer;--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD COLUMN "generation_index" integer;--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD COLUMN "built_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD COLUMN "valuation" text;--> statement-breakpoint
CREATE INDEX "used_aircraft_listing_expiry_idx" ON "used_aircraft_listing" USING btree ("world_id","status","expires_at");--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD CONSTRAINT "used_aircraft_listing_slot_generation_key" UNIQUE("world_id","slot_index","generation_index");--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD CONSTRAINT "used_aircraft_listing_slot_nonnegative" CHECK (("used_aircraft_listing"."slot_index" IS NULL OR "used_aircraft_listing"."slot_index" >= 0)
          AND ("used_aircraft_listing"."generation_index" IS NULL OR "used_aircraft_listing"."generation_index" >= 0));--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD CONSTRAINT "used_aircraft_listing_slot_generation_together" CHECK (("used_aircraft_listing"."slot_index" IS NULL) = ("used_aircraft_listing"."generation_index" IS NULL));--> statement-breakpoint
ALTER TABLE "used_aircraft_listing" ADD CONSTRAINT "used_aircraft_listing_built_before_available" CHECK ("used_aircraft_listing"."built_at" IS NULL OR "used_aircraft_listing"."built_at" <= "used_aircraft_listing"."available_at");