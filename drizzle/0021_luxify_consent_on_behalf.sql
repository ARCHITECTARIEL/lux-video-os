-- CORE-CONSENT-OBO (2026-11-09): operator-recorded LUXIFY consent on behalf of
-- the subject account, per ARCH-ONBEHALF-CONSENT-1109. Additive only: existing
-- rows default to consent_mode 'self' with every new column NULL, so they
-- satisfy the new CHECKs without a backfill. Nothing in 0000-0020 changes.
-- Pre-0021 code never writes the new columns, so it can only create 'self'
-- rows (mode_fields_ck refuses operator columns on 'self').
CREATE TABLE "luxify_consent_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consent_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_account_id" text NOT NULL,
	"on_behalf_of_account_id" text,
	"staff_grant_id" uuid,
	"attestation_text_sha256" text,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "luxify_consent_audit_events_event_ck" CHECK ("luxify_consent_audit_events"."event" in ('consent.granted_on_behalf', 'consent.withdrawn', 'consent.revoked')),
	CONSTRAINT "luxify_consent_audit_events_actor_ck" CHECK ("luxify_consent_audit_events"."actor_type" in ('subject', 'operator', 'staff')),
	CONSTRAINT "luxify_consent_audit_events_hash_ck" CHECK ("luxify_consent_audit_events"."attestation_text_sha256" is null or "luxify_consent_audit_events"."attestation_text_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "luxify_consent_audit_events_request_ck" CHECK ("luxify_consent_audit_events"."request_id" is null or "luxify_consent_audit_events"."request_id" ~ '^[A-Za-z0-9_.:-]{1,128}$'),
	CONSTRAINT "luxify_consent_audit_events_on_behalf_ck" CHECK ("luxify_consent_audit_events"."on_behalf_of_account_id" is null or "luxify_consent_audit_events"."on_behalf_of_account_id" = "luxify_consent_audit_events"."account_id")
);
--> statement-breakpoint
ALTER TABLE "lux_staff_grants" DROP CONSTRAINT "lux_staff_grants_scope_ck";--> statement-breakpoint
-- (id, account_id) is unique before the composite FKs below reference it.
CREATE UNIQUE INDEX "luxify_cinematic_consents_id_account_uq" ON "luxify_cinematic_consents" USING btree ("id","account_id");--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "consent_mode" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "operator_user_id" text;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "operator_staff_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "attestation_text_version" text;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "attestation_text_sha256" text;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "attested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "attestation_method" text;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD COLUMN "attestation_evidence_ref" text;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "luxify_consent_id" uuid;--> statement-breakpoint
ALTER TABLE "luxify_consent_audit_events" ADD CONSTRAINT "luxify_consent_audit_events_consent_fk" FOREIGN KEY ("consent_id","account_id") REFERENCES "public"."luxify_cinematic_consents"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_consent_audit_events" ADD CONSTRAINT "luxify_consent_audit_events_actor_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_consent_audit_events" ADD CONSTRAINT "luxify_consent_audit_events_grant_fk" FOREIGN KEY ("staff_grant_id") REFERENCES "public"."lux_staff_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "luxify_consent_audit_events_consent_idx" ON "luxify_consent_audit_events" USING btree ("consent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "luxify_consent_audit_events_account_idx" ON "luxify_consent_audit_events" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "luxify_consent_audit_events_grant_uq" ON "luxify_consent_audit_events" USING btree ("consent_id") WHERE "luxify_consent_audit_events"."event" = 'consent.granted_on_behalf';--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_operator_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_operator_grant_fk" FOREIGN KEY ("operator_staff_grant_id") REFERENCES "public"."lux_staff_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_luxify_consent_fk" FOREIGN KEY ("luxify_consent_id","account_id") REFERENCES "public"."luxify_cinematic_consents"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "luxify_cinematic_consents_operator_idx" ON "luxify_cinematic_consents" USING btree ("operator_user_id") WHERE "luxify_cinematic_consents"."operator_user_id" is not null;--> statement-breakpoint
CREATE INDEX "video_jobs_luxify_consent_idx" ON "video_jobs" USING btree ("luxify_consent_id") WHERE "video_jobs"."luxify_consent_id" is not null;--> statement-breakpoint
ALTER TABLE "lux_staff_grants" ADD CONSTRAINT "lux_staff_grants_no_self_operator_ck" CHECK ("lux_staff_grants"."scope" <> 'consent_operator' or "lux_staff_grants"."granted_by_account_id" <> "lux_staff_grants"."staff_account_id");--> statement-breakpoint
ALTER TABLE "lux_staff_grants" ADD CONSTRAINT "lux_staff_grants_scope_ck" CHECK ("lux_staff_grants"."scope" in ('creative_approval', 'consent_operator'));--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_mode_fields_ck" CHECK (("luxify_cinematic_consents"."consent_mode" = 'self' and "luxify_cinematic_consents"."operator_user_id" is null and "luxify_cinematic_consents"."operator_staff_grant_id" is null and "luxify_cinematic_consents"."attestation_text_version" is null and "luxify_cinematic_consents"."attestation_text_sha256" is null and "luxify_cinematic_consents"."attested_at" is null and "luxify_cinematic_consents"."attestation_method" is null and "luxify_cinematic_consents"."attestation_evidence_ref" is null) or ("luxify_cinematic_consents"."consent_mode" = 'operator_on_behalf' and "luxify_cinematic_consents"."operator_user_id" is not null and "luxify_cinematic_consents"."operator_staff_grant_id" is not null and "luxify_cinematic_consents"."attestation_text_version" is not null and "luxify_cinematic_consents"."attestation_text_sha256" is not null and "luxify_cinematic_consents"."attested_at" is not null and "luxify_cinematic_consents"."attestation_method" is not null and "luxify_cinematic_consents"."attestation_evidence_ref" is not null and "luxify_cinematic_consents"."operator_user_id" <> "luxify_cinematic_consents"."account_id"));--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_attestation_ck" CHECK ("luxify_cinematic_consents"."consent_mode" = 'self' or ("luxify_cinematic_consents"."attestation_text_version" = 'luxify-operator-attestation/v1' and "luxify_cinematic_consents"."attestation_text_sha256" ~ '^[a-f0-9]{64}$' and "luxify_cinematic_consents"."attestation_method" in ('written', 'recorded_verbal') and "luxify_cinematic_consents"."attestation_evidence_ref" ~ '^video-os/consent-evidence/[a-f0-9]{64}/[0-9a-f-]{36}[.](pdf|png|jpg|webm|mp4|m4a)$' and "luxify_cinematic_consents"."attested_at" <= "luxify_cinematic_consents"."accepted_at" + interval '5 minutes' and "luxify_cinematic_consents"."attested_at" >= "luxify_cinematic_consents"."accepted_at" - interval '7 days' and "luxify_cinematic_consents"."expires_at" <= "luxify_cinematic_consents"."attested_at" + interval '8760 hours'));
--> statement-breakpoint
-- Audit rows are append-only: no UPDATE, no DELETE.
CREATE FUNCTION luxify_consent_audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'luxify_consent_audit_events rows are append-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_consent_audit_events_no_update_trg BEFORE UPDATE ON luxify_consent_audit_events
FOR EACH ROW EXECUTE FUNCTION luxify_consent_audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER luxify_consent_audit_events_no_delete_trg BEFORE DELETE ON luxify_consent_audit_events
FOR EACH ROW EXECUTE FUNCTION luxify_consent_records_no_delete();
--> statement-breakpoint
-- An on-behalf grant needs an active, explicit, non-self consent_operator
-- grant held by the recording operator, with a Lux-domain email. FOR SHARE
-- serializes the insert with a concurrent grant revocation. The 0018 guard
-- still requires an open source identity consent and keeps every column
-- (including the operator/attestation columns) immutable after insert.
CREATE FUNCTION luxify_cinematic_consents_operator_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consent_mode = 'operator_on_behalf' THEN
    PERFORM 1 FROM lux_staff_grants grant_row
      WHERE grant_row.id = NEW.operator_staff_grant_id
        AND grant_row.staff_account_id = NEW.operator_user_id
        AND grant_row.scope = 'consent_operator'
        AND grant_row.revoked_at IS NULL
        AND grant_row.explicit_grant
        AND grant_row.granted_by_account_id <> grant_row.staff_account_id
        AND grant_row.staff_email ~ '^[a-z0-9._%+-]{1,64}@luxmarketingcompany[.]com$'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'on-behalf luxify consent requires an active consent_operator staff grant';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_cinematic_consents_operator_guard_trg BEFORE INSERT ON luxify_cinematic_consents
FOR EACH ROW EXECUTE FUNCTION luxify_cinematic_consents_operator_guard();
--> statement-breakpoint
-- video_jobs.luxify_consent_id: set only at insert (enqueue), never changed.
-- At insert and again on the transition into provider_submitting (provider
-- submit), the consent must be open, unexpired, on the job's own account
-- (the composite FK also pins this) and for the job's primary look. FOR SHARE
-- makes a concurrent withdraw/revoke either commit first (and the job is
-- refused) or wait for the job transaction.
CREATE FUNCTION video_jobs_luxify_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.luxify_consent_id IS DISTINCT FROM OLD.luxify_consent_id THEN
    RAISE EXCEPTION 'video_jobs.luxify_consent_id is set at enqueue and immutable';
  END IF;
  IF NEW.luxify_consent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF video_os_render_mode_for_job(NEW.provider, NEW.input) IS DISTINCT FROM 'luxified' THEN
    RAISE EXCEPTION 'luxify_consent_id is only valid on a luxified job';
  END IF;
  IF TG_OP = 'INSERT' OR (NEW.status = 'provider_submitting' AND OLD.status IS DISTINCT FROM 'provider_submitting') THEN
    PERFORM 1 FROM luxify_cinematic_consents consent
      WHERE consent.id = NEW.luxify_consent_id
        AND consent.account_id = NEW.account_id
        AND consent.revoked_at IS NULL
        AND consent.expires_at > now()
        AND consent.identity_id::text = (NEW.input -> 'lookBindings' -> 0 ->> 'identityId')
        AND consent.provider_look_id = (NEW.input -> 'lookBindings' -> 0 ->> 'providerLookId')
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'luxify job consent is not active for this account and look';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER video_jobs_luxify_consent_guard_tg BEFORE INSERT OR UPDATE OF luxify_consent_id, status, provider, input
ON video_jobs FOR EACH ROW EXECUTE FUNCTION video_jobs_luxify_consent_guard();
