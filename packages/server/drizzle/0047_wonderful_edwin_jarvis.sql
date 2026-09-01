-- tailfin:migration-strategy expand
-- Display currency (M8-02, §24). Additive: a new `currency_rate` table of live
-- FX rates, and a nullable `display_currency` on `player` (null means the default
-- USD). The previous release neither reads nor writes either — all money stays
-- USD minor units, so this changes only what a client may render, never a stored
-- value. `currency_rate` is deliberately mutable (seeded, then refreshed nightly
-- by the worker), unlike the immutable economy/catalogue tables.
CREATE TABLE "currency_rate" (
	"code" text PRIMARY KEY NOT NULL,
	"rate_e6" bigint NOT NULL,
	"source" text NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "display_currency" text;