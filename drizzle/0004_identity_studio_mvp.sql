CREATE TABLE "identity_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"face_authorization" boolean NOT NULL,
	"voice_authorization" boolean NOT NULL,
	"provider_processing_authorization" boolean NOT NULL,
	"archive_delete_acknowledgment" boolean NOT NULL,
	"policy_version" text NOT NULL,
	"photo_sha256" text NOT NULL,
	"voice_sha256" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "identity_consents_authorizations_ck" CHECK ("identity_consents"."face_authorization" and "identity_consents"."voice_authorization" and "identity_consents"."provider_processing_authorization" and "identity_consents"."archive_delete_acknowledgment")
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"overall_status" text DEFAULT 'DRAFT' NOT NULL,
	"avatar_status" text DEFAULT 'DRAFT' NOT NULL,
	"voice_status" text DEFAULT 'DRAFT' NOT NULL,
	"provider" text DEFAULT 'heygen' NOT NULL,
	"source_photo_asset_id" uuid NOT NULL,
	"source_voice_asset_id" uuid NOT NULL,
	"provider_avatar_request_id" text,
	"provider_avatar_group_id" text,
	"provider_renderable_avatar_id" text,
	"provider_voice_id" text,
	"avatar_operation_key" uuid,
	"voice_operation_key" uuid,
	"avatar_failure_code" text,
	"avatar_failure_message" text,
	"voice_failure_code" text,
	"voice_failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "user_identities_overall_status_ck" CHECK ("user_identities"."overall_status" in ('DRAFT', 'UPLOADING', 'CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING', 'READY', 'PARTIAL_FAILURE', 'FAILED', 'ARCHIVED')),
	CONSTRAINT "user_identities_avatar_status_ck" CHECK ("user_identities"."avatar_status" in ('DRAFT', 'UPLOADING', 'CREATING', 'PROCESSING', 'READY', 'FAILED')),
	CONSTRAINT "user_identities_voice_status_ck" CHECK ("user_identities"."voice_status" in ('DRAFT', 'UPLOADING', 'CREATING', 'PROCESSING', 'READY', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "width_px" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "height_px" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "provider_asset_id" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "provider_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "identity_id" uuid;--> statement-breakpoint
ALTER TABLE "identity_consents" ADD CONSTRAINT "identity_consents_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_consents" ADD CONSTRAINT "identity_consents_identity_id_user_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_source_photo_asset_id_media_assets_id_fk" FOREIGN KEY ("source_photo_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_source_voice_asset_id_media_assets_id_fk" FOREIGN KEY ("source_voice_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_consents_account_identity_idx" ON "identity_consents" USING btree ("account_id","identity_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_consents_active_policy_uq" ON "identity_consents" USING btree ("identity_id","policy_version") WHERE "identity_consents"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_identities_account_updated_idx" ON "user_identities" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "user_identities_account_status_idx" ON "user_identities" USING btree ("account_id","overall_status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_group_uq" ON "user_identities" USING btree ("provider","provider_avatar_group_id") WHERE "user_identities"."provider_avatar_group_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_avatar_uq" ON "user_identities" USING btree ("provider","provider_renderable_avatar_id") WHERE "user_identities"."provider_renderable_avatar_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_provider_voice_uq" ON "user_identities" USING btree ("provider","provider_voice_id") WHERE "user_identities"."provider_voice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_avatar_operation_uq" ON "user_identities" USING btree ("avatar_operation_key") WHERE "user_identities"."avatar_operation_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_voice_operation_uq" ON "user_identities" USING btree ("voice_operation_key") WHERE "user_identities"."voice_operation_key" is not null;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_identity_id_user_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_provider_asset_uq" ON "media_assets" USING btree ("provider","provider_asset_id") WHERE "media_assets"."provider" is not null and "media_assets"."provider_asset_id" is not null;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_dimensions_positive_ck" CHECK (("media_assets"."width_px" is null or "media_assets"."width_px" > 0) and ("media_assets"."height_px" is null or "media_assets"."height_px" > 0));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_duration_positive_ck" CHECK ("media_assets"."duration_ms" is null or "media_assets"."duration_ms" > 0);