CREATE TABLE "identity_enrollment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"event_type" text NOT NULL,
	"state_from" text,
	"state_to" text,
	"failure_code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_video_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"contract_version" text NOT NULL,
	"status" text DEFAULT 'AWAITING_UPLOAD' NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"display_name" text NOT NULL,
	"photo_asset_id" uuid NOT NULL,
	"photo_sha256" text NOT NULL,
	"declared_filename" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"declared_bytes" integer NOT NULL,
	"upload_pathname" text NOT NULL,
	"upload_etag" text,
	"upload_operation_key" uuid NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"source_sha256" text,
	"source_bytes" integer,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_video_asset_id" uuid,
	"derived_voice_asset_id" uuid,
	"derived_audio_sha256" text,
	"derived_audio_bytes" integer,
	"derived_audio_duration_ms" integer,
	"derivation_version" text,
	"identity_id" uuid,
	"consent_policy_version" text,
	"consent_purpose" text,
	"consented_source_sha256" text,
	"consent_idempotency_key" uuid,
	"consent_authorizations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consented_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"workflow_operation_key" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"cleanup_status" text DEFAULT 'NOT_REQUIRED' NOT NULL,
	"cleanup_attempts" integer DEFAULT 0 NOT NULL,
	"source_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "identity_video_enrollments_upload_pathname_unique" UNIQUE("upload_pathname"),
	CONSTRAINT "identity_video_enrollments_upload_operation_key_unique" UNIQUE("upload_operation_key"),
	CONSTRAINT "identity_video_enrollments_status_ck" CHECK ("identity_video_enrollments"."status" in ('AWAITING_UPLOAD', 'SOURCE_HASHING', 'AWAITING_EXTRACTION_CONSENT', 'EXTRACTION_QUEUED', 'EXTRACTING', 'IDENTITY_READY', 'FAILED', 'REVOKED', 'EXPIRED')),
	CONSTRAINT "identity_video_enrollments_state_version_ck" CHECK ("identity_video_enrollments"."state_version" > 0),
	CONSTRAINT "identity_video_enrollments_declared_bytes_ck" CHECK ("identity_video_enrollments"."declared_bytes" > 0 and "identity_video_enrollments"."declared_bytes" <= 104857600),
	CONSTRAINT "identity_video_enrollments_attempt_count_ck" CHECK ("identity_video_enrollments"."attempt_count" >= 0 and "identity_video_enrollments"."attempt_count" <= 3),
	CONSTRAINT "identity_video_enrollments_hash_ck" CHECK ("identity_video_enrollments"."photo_sha256" ~ '^[a-f0-9]{64}$' and ("identity_video_enrollments"."source_sha256" is null or "identity_video_enrollments"."source_sha256" ~ '^[a-f0-9]{64}$') and ("identity_video_enrollments"."derived_audio_sha256" is null or "identity_video_enrollments"."derived_audio_sha256" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "identity_video_enrollments_cleanup_status_ck" CHECK ("identity_video_enrollments"."cleanup_status" in ('NOT_REQUIRED', 'PENDING', 'DELETED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "identity_enrollment_events" ADD CONSTRAINT "identity_enrollment_events_enrollment_id_identity_video_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."identity_video_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_video_enrollments" ADD CONSTRAINT "identity_video_enrollments_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_video_enrollments" ADD CONSTRAINT "identity_video_enrollments_photo_asset_id_media_assets_id_fk" FOREIGN KEY ("photo_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_video_enrollments" ADD CONSTRAINT "identity_video_enrollments_source_video_asset_id_media_assets_id_fk" FOREIGN KEY ("source_video_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_video_enrollments" ADD CONSTRAINT "identity_video_enrollments_derived_voice_asset_id_media_assets_id_fk" FOREIGN KEY ("derived_voice_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_video_enrollments" ADD CONSTRAINT "identity_video_enrollments_identity_id_user_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_enrollment_events_enrollment_created_idx" ON "identity_enrollment_events" USING btree ("enrollment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_video_enrollments_account_idempotency_uq" ON "identity_video_enrollments" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_video_enrollments_identity_uq" ON "identity_video_enrollments" USING btree ("identity_id") WHERE "identity_video_enrollments"."identity_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_video_enrollments_consent_idempotency_uq" ON "identity_video_enrollments" USING btree ("consent_idempotency_key") WHERE "identity_video_enrollments"."consent_idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "identity_video_enrollments_account_updated_idx" ON "identity_video_enrollments" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "identity_video_enrollments_status_updated_idx" ON "identity_video_enrollments" USING btree ("status","updated_at");