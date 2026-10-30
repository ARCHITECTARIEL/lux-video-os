CREATE TABLE "lux_staff_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_account_id" text NOT NULL,
	"staff_email" text NOT NULL,
	"scope" text NOT NULL,
	"explicit_grant" boolean NOT NULL,
	"email_verified_at" timestamp with time zone NOT NULL,
	"granted_by_account_id" text NOT NULL,
	"grant_evidence_sha256" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "lux_staff_grants_scope_ck" CHECK ("lux_staff_grants"."scope" = 'creative_approval'),
	CONSTRAINT "lux_staff_grants_explicit_ck" CHECK ("lux_staff_grants"."explicit_grant"),
	CONSTRAINT "lux_staff_grants_email_ck" CHECK ("lux_staff_grants"."staff_email" ~ '^[a-z0-9._%+-]{1,64}@luxmarketingcompany[.]com$'),
	CONSTRAINT "lux_staff_grants_hash_ck" CHECK ("lux_staff_grants"."grant_evidence_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "lux_staff_grants_window_ck" CHECK ("lux_staff_grants"."revoked_at" is null or "lux_staff_grants"."revoked_at" >= "lux_staff_grants"."granted_at")
);
--> statement-breakpoint
CREATE TABLE "luxify_creative_asset_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"asset_sha256" text NOT NULL,
	"staff_grant_id" uuid NOT NULL,
	"approver_account_id" text NOT NULL,
	"decision" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "luxify_creative_asset_approvals_decision_ck" CHECK ("luxify_creative_asset_approvals"."decision" = 'approved'),
	CONSTRAINT "luxify_creative_asset_approvals_hash_ck" CHECK ("luxify_creative_asset_approvals"."asset_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "luxify_look_capability_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_look_id" text NOT NULL,
	"provider_space_fingerprint" text NOT NULL,
	"capability" text NOT NULL,
	"eligible" boolean NOT NULL,
	"avatar_type" text NOT NULL,
	"supported_api_engines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_sha256" text NOT NULL,
	"staff_grant_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "luxify_look_capability_evidence_capability_ck" CHECK ("luxify_look_capability_evidence"."capability" = 'cinematic_avatar'),
	CONSTRAINT "luxify_look_capability_evidence_look_ck" CHECK ("luxify_look_capability_evidence"."provider_look_id" ~ '^[A-Za-z0-9_.:-]{1,255}$' and "luxify_look_capability_evidence"."avatar_type" ~ '^[A-Za-z0-9_.:-]{1,80}$'),
	CONSTRAINT "luxify_look_capability_evidence_hash_ck" CHECK ("luxify_look_capability_evidence"."provider_space_fingerprint" ~ '^[a-f0-9]{64}$' and "luxify_look_capability_evidence"."evidence_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "luxify_look_capability_evidence_window_ck" CHECK ("luxify_look_capability_evidence"."expires_at" > "luxify_look_capability_evidence"."observed_at" and "luxify_look_capability_evidence"."expires_at" <= "luxify_look_capability_evidence"."observed_at" + interval '30 days')
);
--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "terminal_reason" text;--> statement-breakpoint
ALTER TABLE "lux_staff_grants" ADD CONSTRAINT "lux_staff_grants_staff_account_id_users_id_fk" FOREIGN KEY ("staff_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lux_staff_grants" ADD CONSTRAINT "lux_staff_grants_granted_by_account_id_users_id_fk" FOREIGN KEY ("granted_by_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_creative_asset_approvals" ADD CONSTRAINT "luxify_creative_asset_approvals_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_creative_asset_approvals" ADD CONSTRAINT "luxify_creative_asset_approvals_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_creative_asset_approvals" ADD CONSTRAINT "luxify_creative_asset_approvals_staff_grant_id_lux_staff_grants_id_fk" FOREIGN KEY ("staff_grant_id") REFERENCES "public"."lux_staff_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_creative_asset_approvals" ADD CONSTRAINT "luxify_creative_asset_approvals_approver_account_id_users_id_fk" FOREIGN KEY ("approver_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_look_capability_evidence" ADD CONSTRAINT "luxify_look_capability_evidence_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_look_capability_evidence" ADD CONSTRAINT "luxify_look_capability_evidence_staff_grant_id_lux_staff_grants_id_fk" FOREIGN KEY ("staff_grant_id") REFERENCES "public"."lux_staff_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lux_staff_grants_active_uq" ON "lux_staff_grants" USING btree ("staff_account_id","scope") WHERE "lux_staff_grants"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "luxify_creative_asset_approvals_active_uq" ON "luxify_creative_asset_approvals" USING btree ("media_asset_id") WHERE "luxify_creative_asset_approvals"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "luxify_look_capability_evidence_look_idx" ON "luxify_look_capability_evidence" USING btree ("account_id","provider_look_id","provider_space_fingerprint") WHERE "luxify_look_capability_evidence"."revoked_at" is null;--> statement-breakpoint
UPDATE "luxify_cinematic_consents" SET "terminal_reason" = 'revoked' WHERE "revoked_at" IS NOT NULL AND "terminal_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_terminal_ck" CHECK (("luxify_cinematic_consents"."revoked_at" is null and "luxify_cinematic_consents"."terminal_reason" is null) or ("luxify_cinematic_consents"."revoked_at" is not null and "luxify_cinematic_consents"."terminal_reason" is not null and "luxify_cinematic_consents"."terminal_reason" in ('withdrawn', 'revoked', 'source_revoked')));
--> statement-breakpoint
CREATE FUNCTION luxify_cinematic_consents_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'luxify_cinematic_consents rows are closed, never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.terminal_reason IS NOT NULL THEN
      RAISE EXCEPTION 'luxify cinematic consent must be inserted open';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM identity_consents source
      WHERE source.id = NEW.source_identity_consent_id
        AND source.account_id = NEW.account_id
        AND source.identity_id = NEW.identity_id
        AND source.revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'luxify cinematic consent requires an active source identity consent';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'closed luxify cinematic consent is immutable';
  END IF;
  IF NEW.revoked_at IS NULL
    OR (to_jsonb(NEW) - 'revoked_at' - 'terminal_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'terminal_reason') THEN
    RAISE EXCEPTION 'luxify cinematic consent may only be closed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_cinematic_consents_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON luxify_cinematic_consents
FOR EACH ROW EXECUTE FUNCTION luxify_cinematic_consents_guard();
--> statement-breakpoint
CREATE FUNCTION luxify_source_consent_revoked_cascade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE luxify_cinematic_consents
      SET revoked_at = greatest(NEW.revoked_at, accepted_at), terminal_reason = 'source_revoked'
      WHERE source_identity_consent_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_source_consent_revoked_cascade_trg AFTER UPDATE OF revoked_at ON identity_consents
FOR EACH ROW EXECUTE FUNCTION luxify_source_consent_revoked_cascade();
--> statement-breakpoint
CREATE FUNCTION luxify_consent_records_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are closed, never deleted', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER lux_staff_grants_no_delete_trg BEFORE DELETE ON lux_staff_grants
FOR EACH ROW EXECUTE FUNCTION luxify_consent_records_no_delete();
--> statement-breakpoint
CREATE TRIGGER luxify_creative_asset_approvals_no_delete_trg BEFORE DELETE ON luxify_creative_asset_approvals
FOR EACH ROW EXECUTE FUNCTION luxify_consent_records_no_delete();
--> statement-breakpoint
CREATE TRIGGER luxify_look_capability_evidence_no_delete_trg BEFORE DELETE ON luxify_look_capability_evidence
FOR EACH ROW EXECUTE FUNCTION luxify_consent_records_no_delete();
