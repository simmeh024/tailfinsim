CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "session_token_hash_is_sha256" CHECK (length("session"."token_hash") = 64),
	CONSTRAINT "session_expires_after_creation" CHECK ("session"."expires_at" > "session"."created_at")
);
--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_player_id_idx" ON "session" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");