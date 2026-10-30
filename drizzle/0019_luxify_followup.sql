-- QA R2-L1: refuse to migrate while any approval or capability-evidence row is
-- dated more than 5 minutes in the future (approved_at / observed_at). Such a
-- row can only come from a direct DB write; the app always uses DB now(). The
-- migration fails loudly and rolls back so an operator resolves it explicitly.
DO $$
DECLARE future_rows bigint;
BEGIN
  SELECT (SELECT count(*) FROM luxify_look_creative_approvals WHERE approved_at > now() + interval '5 minutes')
       + (SELECT count(*) FROM luxify_creative_asset_approvals WHERE approved_at > now() + interval '5 minutes')
       + (SELECT count(*) FROM luxify_look_capability_evidence WHERE observed_at > now() + interval '5 minutes')
    INTO future_rows;
  IF future_rows > 0 THEN
    RAISE EXCEPTION 'migration 0019 refused: % luxify approval/evidence row(s) dated more than 5 minutes in the future; resolve them before migrating', future_rows
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "luxify_consent_challenge_uses" (
	"challenge_sha256" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "luxify_consent_challenge_uses_hash_ck" CHECK ("luxify_consent_challenge_uses"."challenge_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "luxify_consent_challenge_uses" ADD CONSTRAINT "luxify_consent_challenge_uses_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "luxify_consent_challenge_uses_used_at_idx" ON "luxify_consent_challenge_uses" USING btree ("used_at");--> statement-breakpoint
CREATE FUNCTION luxify_consent_challenge_uses_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'luxify_consent_challenge_uses rows are insert-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_consent_challenge_uses_insert_only_trg BEFORE UPDATE OR DELETE ON luxify_consent_challenge_uses
FOR EACH ROW EXECUTE FUNCTION luxify_consent_challenge_uses_insert_only();
--> statement-breakpoint
-- QA L-1: approvals may not be recorded with approved_at more than 5 minutes
-- in the future (the app always uses DB now()).
CREATE FUNCTION luxify_creative_approval_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approved_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION '% approved_at is in the future', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_look_creative_approvals_insert_guard_trg BEFORE INSERT ON luxify_look_creative_approvals
FOR EACH ROW EXECUTE FUNCTION luxify_creative_approval_insert_guard();
--> statement-breakpoint
CREATE TRIGGER luxify_creative_asset_approvals_insert_guard_trg BEFORE INSERT ON luxify_creative_asset_approvals
FOR EACH ROW EXECUTE FUNCTION luxify_creative_approval_insert_guard();
--> statement-breakpoint
-- N-1 / L-1 / L-2: revoking a staff grant closes every open look approval,
-- creative-asset approval and capability-evidence row recorded under it.
-- Approvals close at greatest(revoke time, approved_at) (the 0018 window check
-- needs revoked_at >= approved_at), capped at now()+5 minutes so the 0018
-- future-close guard never fires. Rows beyond that cap cannot exist after the
-- R2-L1 guard above plus the insert guard; the filter keeps the revoke safe
-- regardless, and every gate also requires approved_at <= now().
CREATE FUNCTION lux_staff_grant_revoked_cascade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE luxify_look_creative_approvals
      SET revoked_at = least(greatest(NEW.revoked_at, approved_at), now() + interval '5 minutes')
      WHERE staff_grant_id = NEW.id AND revoked_at IS NULL AND approved_at <= now() + interval '5 minutes';
    UPDATE luxify_creative_asset_approvals
      SET revoked_at = least(greatest(NEW.revoked_at, approved_at), now() + interval '5 minutes')
      WHERE staff_grant_id = NEW.id AND revoked_at IS NULL AND approved_at <= now() + interval '5 minutes';
    UPDATE luxify_look_capability_evidence
      SET revoked_at = least(NEW.revoked_at, now() + interval '5 minutes')
      WHERE staff_grant_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER lux_staff_grant_revoked_cascade_trg AFTER UPDATE OF revoked_at ON lux_staff_grants
FOR EACH ROW EXECUTE FUNCTION lux_staff_grant_revoked_cascade();
--> statement-breakpoint
UPDATE "luxify_look_creative_approvals" AS "approval" SET "revoked_at" = least(greatest("grant"."revoked_at", "approval"."approved_at"), now() + interval '5 minutes') FROM "lux_staff_grants" AS "grant" WHERE "grant"."id" = "approval"."staff_grant_id" AND "grant"."revoked_at" IS NOT NULL AND "approval"."revoked_at" IS NULL AND "approval"."approved_at" <= now() + interval '5 minutes';
--> statement-breakpoint
UPDATE "luxify_creative_asset_approvals" AS "approval" SET "revoked_at" = least(greatest("grant"."revoked_at", "approval"."approved_at"), now() + interval '5 minutes') FROM "lux_staff_grants" AS "grant" WHERE "grant"."id" = "approval"."staff_grant_id" AND "grant"."revoked_at" IS NOT NULL AND "approval"."revoked_at" IS NULL AND "approval"."approved_at" <= now() + interval '5 minutes';
--> statement-breakpoint
UPDATE "luxify_look_capability_evidence" AS "evidence" SET "revoked_at" = least("grant"."revoked_at", now() + interval '5 minutes') FROM "lux_staff_grants" AS "grant" WHERE "grant"."id" = "evidence"."staff_grant_id" AND "grant"."revoked_at" IS NOT NULL AND "evidence"."revoked_at" IS NULL;
