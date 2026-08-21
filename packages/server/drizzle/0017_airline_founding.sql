CREATE TABLE "airline_hub" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"airline_id" uuid NOT NULL,
	"airport_id" uuid NOT NULL,
	"founder_grant" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airline_hub_airline_id_airport_id_key" UNIQUE("airline_id","airport_id")
);
--> statement-breakpoint
ALTER TABLE "airline_hub" ADD CONSTRAINT "airline_hub_airline_id_airline_id_fk" FOREIGN KEY ("airline_id") REFERENCES "public"."airline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airline_hub" ADD CONSTRAINT "airline_hub_airport_id_airport_id_fk" FOREIGN KEY ("airport_id") REFERENCES "public"."airport"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airline_hub_airline_id_idx" ON "airline_hub" USING btree ("airline_id");--> statement-breakpoint
CREATE INDEX "airline_hub_airport_id_idx" ON "airline_hub" USING btree ("airport_id");