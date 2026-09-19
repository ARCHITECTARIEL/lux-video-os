CREATE TABLE "standard_narration_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"audio_asset_id" uuid NOT NULL,
	"audio_sha256" text NOT NULL,
	"policy_version" text NOT NULL,
	"processing_scope" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
CREATE TABLE "standard_narration_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"contract_version" text NOT NULL,
	"project_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"photo_asset_id" uuid NOT NULL,
	"photo_sha256" text NOT NULL,
	"identity_consent_id" uuid NOT NULL,
	"narration_consent_id" uuid NOT NULL,
	"audio_asset_id" uuid NOT NULL,
	"audio_sha256" text NOT NULL,
	"policy_version" text NOT NULL,
	"pricing_version" text NOT NULL,
	"format" text NOT NULL,
	"credits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_job_id" text
);
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "script" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "standard_narration_consents" ADD CONSTRAINT "standard_narration_consents_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_consents" ADD CONSTRAINT "standard_narration_consents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_consents" ADD CONSTRAINT "standard_narration_consents_identity_id_user_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_consents" ADD CONSTRAINT "standard_narration_consents_audio_asset_id_media_assets_id_fk" FOREIGN KEY ("audio_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_quotes" ADD CONSTRAINT "standard_narration_quotes_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_quotes" ADD CONSTRAINT "standard_narration_quotes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_quotes" ADD CONSTRAINT "standard_narration_quotes_identity_id_user_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_quotes" ADD CONSTRAINT "standard_narration_quotes_photo_asset_id_media_assets_id_fk" FOREIGN KEY ("photo_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_quotes" ADD CONSTRAINT "standard_narration_quotes_identity_consent_id_identity_consents_id_fk" FOREIGN KEY ("identity_consent_id") REFERENCES "public"."identity_consents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_quotes" ADD CONSTRAINT "standard_narration_quotes_narration_consent_id_standard_narration_consents_id_fk" FOREIGN KEY ("narration_consent_id") REFERENCES "public"."standard_narration_consents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard_narration_quotes" ADD CONSTRAINT "standard_narration_quotes_audio_asset_id_media_assets_id_fk" FOREIGN KEY ("audio_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "standard_narration_consents_account_idempotency_uq" ON "standard_narration_consents" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "standard_narration_consents_binding_idx" ON "standard_narration_consents" USING btree ("account_id","actor_id","project_id","identity_id","audio_asset_id","granted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "standard_narration_quotes_consumed_job_uq" ON "standard_narration_quotes" USING btree ("consumed_job_id");