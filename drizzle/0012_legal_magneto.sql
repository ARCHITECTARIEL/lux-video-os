CREATE TABLE "ops_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"event" text NOT NULL,
	"account_id" text,
	"entity_type" text,
	"entity_id" text,
	"correlation_id" text,
	"code" text,
	"http_status" integer,
	"message" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ops_events_created_at_idx" ON "ops_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ops_events_account_id_idx" ON "ops_events" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ops_events_entity_id_idx" ON "ops_events" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "ops_events_code_idx" ON "ops_events" USING btree ("code");--> statement-breakpoint
COMMENT ON TABLE "ops_events" IS 'Operational events retained for 30 days by an external operations process; this migration does not schedule deletion.';--> statement-breakpoint
COMMENT ON COLUMN "ops_events"."details" IS 'Redacted structured metadata only; secrets, credentials, raw payloads, and personal media must not be stored.';
