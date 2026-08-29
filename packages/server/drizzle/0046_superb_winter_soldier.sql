-- tailfin:migration-strategy expand
-- Executive-office placement (§9.1 follow-up). Additive: a nullable `office_index`
-- on executive_hire records which office a C-Suite member sits in, so the person
-- appears in the office the player clicked rather than the first free one. The
-- previous release neither reads nor writes it, and its rows keep office_index
-- null; a partial unique index keeps one person per office among the non-null rows.
ALTER TABLE "executive_hire" ADD COLUMN "office_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "executive_hire_airline_office_key" ON "executive_hire" USING btree ("airline_id","office_index") WHERE "executive_hire"."office_index" is not null;
