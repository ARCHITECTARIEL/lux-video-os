CREATE TABLE "credit_accounts" (
	"account_id" text PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"purchased" integer DEFAULT 0 NOT NULL,
	"spent" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"event_type" text NOT NULL,
	"stage_from" text,
	"stage_to" text,
	"failure_category" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"job_id" text,
	"kind" text NOT NULL,
	"private_pathname" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_private_pathname_unique" UNIQUE("private_pathname")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"stripe_event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"livemode" boolean NOT NULL,
	"payload_sha256" text NOT NULL,
	"account_id" text,
	"session_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"name" text DEFAULT 'Video OS Account' NOT NULL,
	"role" text DEFAULT 'customer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "video_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"workflow_run_id" text,
	"correlation_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_job_id" text,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"format" text NOT NULL,
	"cost_credits" integer NOT NULL,
	"provider_cost_usd" numeric(12, 4),
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "video_jobs_workflow_run_id_unique" UNIQUE("workflow_run_id"),
	CONSTRAINT "video_jobs_provider_job_id_unique" UNIQUE("provider_job_id")
);
--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_video_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."video_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_job_id_video_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."video_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_source_uq" ON "credit_transactions" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "credit_transactions_account_created_idx" ON "credit_transactions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "job_events_job_created_idx" ON "job_events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "video_jobs_account_idempotency_uq" ON "video_jobs" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "video_jobs_account_updated_idx" ON "video_jobs" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "video_jobs_status_updated_idx" ON "video_jobs" USING btree ("status","updated_at");