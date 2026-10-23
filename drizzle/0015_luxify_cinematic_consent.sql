CREATE TABLE "luxify_cinematic_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"source_identity_consent_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"provider_look_id" text NOT NULL,
	"provider_space_fingerprint" text NOT NULL,
	"policy_version" text NOT NULL,
	"purpose" text NOT NULL,
	"cinematic_generation_authorization" boolean NOT NULL,
	"provider_processing_authorization" boolean NOT NULL,
	"approval_evidence_sha256" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "luxify_cinematic_consents_policy_ck" CHECK ("luxify_cinematic_consents"."policy_version" = 'luxify-cinematic-consent/v1' and "luxify_cinematic_consents"."purpose" = 'luxify-cinematic-generation'),
	CONSTRAINT "luxify_cinematic_consents_authorization_ck" CHECK ("luxify_cinematic_consents"."cinematic_generation_authorization" and "luxify_cinematic_consents"."provider_processing_authorization"),
	CONSTRAINT "luxify_cinematic_consents_look_ck" CHECK ("luxify_cinematic_consents"."provider_look_id" ~ '^[A-Za-z0-9_.:-]{1,255}$'),
	CONSTRAINT "luxify_cinematic_consents_hash_ck" CHECK ("luxify_cinematic_consents"."provider_space_fingerprint" ~ '^[a-f0-9]{64}$' and "luxify_cinematic_consents"."approval_evidence_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "luxify_cinematic_consents_window_ck" CHECK ("luxify_cinematic_consents"."expires_at" > "luxify_cinematic_consents"."accepted_at" and "luxify_cinematic_consents"."expires_at" <= "luxify_cinematic_consents"."accepted_at" + interval '8760 hours' and ("luxify_cinematic_consents"."revoked_at" is null or "luxify_cinematic_consents"."revoked_at" >= "luxify_cinematic_consents"."accepted_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_consents_id_account_identity_uq" ON "identity_consents" USING btree ("id","account_id","identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_id_account_uq" ON "user_identities" USING btree ("id","account_id");--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_identity_owner_fk" FOREIGN KEY ("identity_id","account_id") REFERENCES "public"."user_identities"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_source_consent_fk" FOREIGN KEY ("source_identity_consent_id","account_id","identity_id") REFERENCES "public"."identity_consents"("id","account_id","identity_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "luxify_cinematic_consents_account_key_uq" ON "luxify_cinematic_consents" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "luxify_cinematic_consents_active_look_uq" ON "luxify_cinematic_consents" USING btree ("account_id","identity_id","provider_look_id","provider_space_fingerprint") WHERE "luxify_cinematic_consents"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "luxify_cinematic_consents_expiry_idx" ON "luxify_cinematic_consents" USING btree ("expires_at") WHERE "luxify_cinematic_consents"."revoked_at" is null;
