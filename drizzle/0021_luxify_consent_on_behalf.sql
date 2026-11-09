-- CORE-CONSENT-OBO (2026-11-09): operator-recorded LUXIFY consent on behalf of
-- the subject account, per ARCH-ONBEHALF-CONSENT-1109. Additive only: existing
-- rows default to consent_mode 'self' with every new column NULL, so they
-- satisfy the new CHECKs without a backfill. Nothing in 0000-0020 changes.
-- Pre-0021 code never writes the new columns, so it can only create 'self'
-- rows (mode_fields_ck refuses operator columns on 'self').
-- CORE-CONSENT-OBO-FIX (2026-11-09, amended in place; never applied):
--   H1b  an on-behalf row counts for no job until the subject confirms through
--        a single-use auth_challenges magic link (consent.subject_confirmed).
--   M1   consent_operator refuses +tag aliases and the grantor's own mailbox.
--   M2   a luxified job inserted after 0021 must carry luxify_consent_id.
--   L2   the job consent check runs on every pre-submit -> claimed move.
--   L4   the audit table refuses TRUNCATE.  P2: space fingerprint in the job
--        guard; source-consent cascade closures of on-behalf rows are audited.
--   L7   lock_timeout below: this takes ACCESS EXCLUSIVE on video_jobs,
--        luxify_cinematic_consents and lux_staff_grants. SET LOCAL lasts to the
--        end of the migrator transaction; on 55P03 retry off-peak.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
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
	CONSTRAINT "luxify_consent_audit_events_event_ck" CHECK ("luxify_consent_audit_events"."event" in ('consent.granted_on_behalf', 'consent.subject_confirmed', 'consent.confirmation_expired', 'consent.withdrawn', 'consent.revoked', 'consent.superseded', 'consent.source_revoked')),
	CONSTRAINT "luxify_consent_audit_events_actor_ck" CHECK ("luxify_consent_audit_events"."actor_type" in ('subject', 'operator', 'staff', 'system')),
	CONSTRAINT "luxify_consent_audit_events_hash_ck" CHECK ("luxify_consent_audit_events"."attestation_text_sha256" is null or "luxify_consent_audit_events"."attestation_text_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "luxify_consent_audit_events_request_ck" CHECK ("luxify_consent_audit_events"."request_id" is null or "luxify_consent_audit_events"."request_id" ~ '^[A-Za-z0-9_.:-]{1,128}$'),
	CONSTRAINT "luxify_consent_audit_events_on_behalf_ck" CHECK ("luxify_consent_audit_events"."on_behalf_of_account_id" is null or "luxify_consent_audit_events"."on_behalf_of_account_id" = "luxify_consent_audit_events"."account_id")
);
--> statement-breakpoint
ALTER TABLE "lux_staff_grants" DROP CONSTRAINT "lux_staff_grants_scope_ck";--> statement-breakpoint
-- (id, account_id) is unique before the composite FKs below reference it.
CREATE UNIQUE INDEX "luxify_cinematic_consents_id_account_uq" ON "luxify_cinematic_consents" USING btree ("id","account_id");--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" DROP CONSTRAINT "luxify_cinematic_consents_terminal_ck";--> statement-breakpoint
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
CREATE UNIQUE INDEX "luxify_consent_audit_events_confirmed_uq" ON "luxify_consent_audit_events" USING btree ("consent_id") WHERE "luxify_consent_audit_events"."event" = 'consent.subject_confirmed';--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_operator_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_operator_grant_fk" FOREIGN KEY ("operator_staff_grant_id") REFERENCES "public"."lux_staff_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD CONSTRAINT "video_jobs_luxify_consent_fk" FOREIGN KEY ("luxify_consent_id","account_id") REFERENCES "public"."luxify_cinematic_consents"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "luxify_cinematic_consents_operator_idx" ON "luxify_cinematic_consents" USING btree ("operator_user_id") WHERE "luxify_cinematic_consents"."operator_user_id" is not null;--> statement-breakpoint
CREATE INDEX "video_jobs_luxify_consent_idx" ON "video_jobs" USING btree ("luxify_consent_id") WHERE "video_jobs"."luxify_consent_id" is not null;--> statement-breakpoint
ALTER TABLE "lux_staff_grants" ADD CONSTRAINT "lux_staff_grants_no_self_operator_ck" CHECK ("lux_staff_grants"."scope" <> 'consent_operator' or "lux_staff_grants"."granted_by_account_id" <> "lux_staff_grants"."staff_account_id");--> statement-breakpoint
ALTER TABLE "lux_staff_grants" ADD CONSTRAINT "lux_staff_grants_operator_no_alias_ck" CHECK ("lux_staff_grants"."scope" <> 'consent_operator' or strpos("lux_staff_grants"."staff_email", '+') = 0);--> statement-breakpoint
ALTER TABLE "lux_staff_grants" ADD CONSTRAINT "lux_staff_grants_scope_ck" CHECK ("lux_staff_grants"."scope" in ('creative_approval', 'consent_operator'));--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_mode_fields_ck" CHECK (("luxify_cinematic_consents"."consent_mode" = 'self' and "luxify_cinematic_consents"."operator_user_id" is null and "luxify_cinematic_consents"."operator_staff_grant_id" is null and "luxify_cinematic_consents"."attestation_text_version" is null and "luxify_cinematic_consents"."attestation_text_sha256" is null and "luxify_cinematic_consents"."attested_at" is null and "luxify_cinematic_consents"."attestation_method" is null and "luxify_cinematic_consents"."attestation_evidence_ref" is null) or ("luxify_cinematic_consents"."consent_mode" = 'operator_on_behalf' and "luxify_cinematic_consents"."operator_user_id" is not null and "luxify_cinematic_consents"."operator_staff_grant_id" is not null and "luxify_cinematic_consents"."attestation_text_version" is not null and "luxify_cinematic_consents"."attestation_text_sha256" is not null and "luxify_cinematic_consents"."attested_at" is not null and "luxify_cinematic_consents"."attestation_method" is not null and "luxify_cinematic_consents"."attestation_evidence_ref" is not null and "luxify_cinematic_consents"."operator_user_id" <> "luxify_cinematic_consents"."account_id"));--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_attestation_ck" CHECK ("luxify_cinematic_consents"."consent_mode" = 'self' or ("luxify_cinematic_consents"."attestation_text_version" = 'luxify-operator-attestation/v1' and "luxify_cinematic_consents"."attestation_text_sha256" ~ '^[a-f0-9]{64}$' and "luxify_cinematic_consents"."attestation_method" in ('written', 'recorded_verbal') and "luxify_cinematic_consents"."attestation_evidence_ref" ~ '^video-os/consent-evidence/[a-f0-9]{64}/[0-9a-f-]{36}[.](pdf|png|jpg|webm|mp4|m4a)$' and "luxify_cinematic_consents"."attested_at" <= "luxify_cinematic_consents"."accepted_at" + interval '5 minutes' and "luxify_cinematic_consents"."attested_at" >= "luxify_cinematic_consents"."accepted_at" - interval '7 days' and "luxify_cinematic_consents"."expires_at" <= "luxify_cinematic_consents"."attested_at" + interval '8760 hours'));--> statement-breakpoint
ALTER TABLE "luxify_cinematic_consents" ADD CONSTRAINT "luxify_cinematic_consents_terminal_ck" CHECK (("luxify_cinematic_consents"."revoked_at" is null and "luxify_cinematic_consents"."terminal_reason" is null) or ("luxify_cinematic_consents"."revoked_at" is not null and "luxify_cinematic_consents"."terminal_reason" is not null and "luxify_cinematic_consents"."terminal_reason" in ('withdrawn', 'revoked', 'source_revoked', 'confirmation_expired')));
--> statement-breakpoint
-- Audit rows are append-only: no UPDATE, no DELETE, no TRUNCATE (QA L4).
-- Arch P3: its own wording rather than the consent-record DELETE message.
CREATE FUNCTION luxify_consent_audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'luxify_consent_audit_events rows are append-only (no update, delete or truncate)';
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_consent_audit_events_no_update_trg BEFORE UPDATE ON luxify_consent_audit_events
FOR EACH ROW EXECUTE FUNCTION luxify_consent_audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER luxify_consent_audit_events_no_delete_trg BEFORE DELETE ON luxify_consent_audit_events
FOR EACH ROW EXECUTE FUNCTION luxify_consent_audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER luxify_consent_audit_events_no_truncate_trg BEFORE TRUNCATE ON luxify_consent_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION luxify_consent_audit_events_append_only();
--> statement-breakpoint
-- H1b: a consent.subject_confirmed row is the only thing that lets an
-- on-behalf consent count. It is admitted only for an open, unexpired
-- on-behalf consent, written as the subject account itself, after that
-- account consumed (used_at set, before expiry) the single-use
-- auth_challenges link issued for this exact consent.
CREATE FUNCTION luxify_consent_audit_events_confirm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event = 'consent.subject_confirmed' THEN
    IF NEW.actor_type <> 'subject' OR NEW.actor_account_id <> NEW.account_id THEN
      RAISE EXCEPTION 'luxify consent confirmation must be made by the subject account';
    END IF;
    PERFORM 1 FROM luxify_cinematic_consents consent
      WHERE consent.id = NEW.consent_id
        AND consent.account_id = NEW.account_id
        AND consent.consent_mode = 'operator_on_behalf'
        AND consent.revoked_at IS NULL
        AND consent.expires_at > now();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'luxify consent confirmation needs an open on-behalf consent';
    END IF;
    PERFORM 1 FROM auth_challenges challenge
      WHERE challenge.challenge_type = 'luxify-obo-confirm:' || NEW.consent_id::text
        AND challenge.account_id = NEW.account_id
        AND challenge.used_at IS NOT NULL
        AND challenge.used_at <= challenge.expires_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'luxify consent confirmation needs a consumed subject confirmation link';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_consent_audit_events_confirm_guard_trg BEFORE INSERT ON luxify_consent_audit_events
FOR EACH ROW EXECUTE FUNCTION luxify_consent_audit_events_confirm_guard();
--> statement-breakpoint
-- QA M1: no-self-grant compares canonical mailboxes (lower-case, +tag
-- stripped), so the grantor's own mailbox can never hold consent_operator
-- through an alias. lux_staff_grants_operator_no_alias_ck refuses '+' too.
CREATE FUNCTION lux_staff_grants_operator_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope = 'consent_operator' THEN
    PERFORM 1 FROM users grantor
      WHERE grantor.id = NEW.granted_by_account_id
        AND regexp_replace(lower(grantor.email), '[+][^@]*@', '@') <> regexp_replace(lower(NEW.staff_email), '[+][^@]*@', '@');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'consent_operator cannot be granted to the grantor''s own mailbox';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER lux_staff_grants_operator_guard_trg BEFORE INSERT ON lux_staff_grants
FOR EACH ROW EXECUTE FUNCTION lux_staff_grants_operator_guard();
--> statement-breakpoint
-- An on-behalf grant needs an active, explicit, non-self consent_operator
-- grant held by the recording operator, with a Lux-domain, non-alias email
-- that is not the grantor's own mailbox. FOR SHARE serializes the insert with
-- a concurrent grant revocation. The 0018 guard still requires an open source
-- identity consent and keeps every column (including the operator/attestation
-- columns) immutable after insert.
CREATE FUNCTION luxify_cinematic_consents_operator_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consent_mode = 'operator_on_behalf' THEN
    PERFORM 1 FROM lux_staff_grants grant_row
      JOIN users grantor ON grantor.id = grant_row.granted_by_account_id
      WHERE grant_row.id = NEW.operator_staff_grant_id
        AND grant_row.staff_account_id = NEW.operator_user_id
        AND grant_row.scope = 'consent_operator'
        AND grant_row.revoked_at IS NULL
        AND grant_row.explicit_grant
        AND grant_row.granted_by_account_id <> grant_row.staff_account_id
        AND grant_row.staff_email ~ '^[a-z0-9._%-]{1,64}@luxmarketingcompany[.]com$'
        AND regexp_replace(lower(grantor.email), '[+][^@]*@', '@') <> grant_row.staff_email
      FOR SHARE OF grant_row;
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
-- P2 / QA L3: the 0018 source-consent cascade (and any other source_revoked
-- close) of an on-behalf row is audited. Self rows keep pre-0021 behaviour.
CREATE FUNCTION luxify_cinematic_consents_cascade_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO luxify_consent_audit_events (consent_id, account_id, event, actor_type, actor_account_id, on_behalf_of_account_id, staff_grant_id, occurred_at)
  VALUES (NEW.id, NEW.account_id, 'consent.source_revoked', 'system', NEW.account_id, NEW.account_id, NEW.operator_staff_grant_id, NEW.revoked_at);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_cinematic_consents_cascade_audit_trg AFTER UPDATE OF revoked_at ON luxify_cinematic_consents
FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.terminal_reason = 'source_revoked' AND NEW.consent_mode = 'operator_on_behalf')
EXECUTE FUNCTION luxify_cinematic_consents_cascade_audit();
--> statement-breakpoint
-- video_jobs.luxify_consent_id: set only at insert (enqueue), never changed.
-- QA M2: a luxified job inserted (or turned luxified) after 0021 must carry
-- it; pre-0021 rows keep NULL. At insert, and on every move from a pre-submit
-- status into a provider-claimed status (QA L2), the consent must be open,
-- unexpired, on the job's own account (the composite FK also pins this), for
-- the job's primary look, in the account's single active verified HeyGen
-- space (Arch P2), and, if on-behalf, confirmed by the subject (H1b). FOR
-- SHARE makes a concurrent withdraw/revoke either commit first (and the job
-- is refused) or wait for the job transaction.
CREATE FUNCTION video_jobs_luxify_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  space_count integer;
  active_space text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.luxify_consent_id IS DISTINCT FROM OLD.luxify_consent_id THEN
    RAISE EXCEPTION 'video_jobs.luxify_consent_id is set at enqueue and immutable';
  END IF;
  IF NEW.luxify_consent_id IS NULL THEN
    IF video_os_render_mode_for_job(NEW.provider, NEW.input) = 'luxified'
      AND (TG_OP = 'INSERT' OR video_os_render_mode_for_job(OLD.provider, OLD.input) IS DISTINCT FROM 'luxified') THEN
      RAISE EXCEPTION 'a luxified job requires luxify_consent_id';
    END IF;
    RETURN NEW;
  END IF;
  IF video_os_render_mode_for_job(NEW.provider, NEW.input) IS DISTINCT FROM 'luxified' THEN
    RAISE EXCEPTION 'luxify_consent_id is only valid on a luxified job';
  END IF;
  IF TG_OP = 'INSERT' OR (
    NEW.status IN ('provider_submitting', 'provider_submit_unknown', 'provider_submitted', 'provider_rendering', 'provider_ready', 'finish_contained', 'finishing', 'ready')
    AND OLD.status IN ('reserved', 'workflow_starting', 'workflow_started')
  ) THEN
    SELECT count(*), min(scope.provider_account_fingerprint) INTO space_count, active_space
      FROM provider_account_bindings binding
      JOIN provider_account_binding_promotions promotion ON promotion.binding_id = binding.id AND promotion.state = 'verified'
      JOIN provider_verified_account_scopes scope ON scope.id = promotion.verified_account_scope_id
      WHERE binding.application_account_id = NEW.account_id
        AND binding.provider = 'heygen'
        AND binding.lifecycle_state = 'active';
    PERFORM 1 FROM luxify_cinematic_consents consent
      WHERE consent.id = NEW.luxify_consent_id
        AND consent.account_id = NEW.account_id
        AND consent.revoked_at IS NULL
        AND consent.expires_at > now()
        AND consent.identity_id::text = (NEW.input -> 'lookBindings' -> 0 ->> 'identityId')
        AND consent.provider_look_id = (NEW.input -> 'lookBindings' -> 0 ->> 'providerLookId')
        AND space_count = 1
        AND consent.provider_space_fingerprint = active_space
        AND (consent.consent_mode = 'self' OR EXISTS (
          SELECT 1 FROM luxify_consent_audit_events confirmation
            WHERE confirmation.consent_id = consent.id
              AND confirmation.account_id = consent.account_id
              AND confirmation.event = 'consent.subject_confirmed'))
      FOR SHARE OF consent;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'luxify job consent is not active for this account and look';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER video_jobs_luxify_consent_guard_tg BEFORE INSERT OR UPDATE OF luxify_consent_id, status, provider, input
ON video_jobs FOR EACH ROW EXECUTE FUNCTION video_jobs_luxify_consent_guard();
