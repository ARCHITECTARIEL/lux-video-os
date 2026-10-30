CREATE TABLE "luxify_consent_challenge_uses" (
	"challenge_sha256" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"identity_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "luxify_consent_challenge_uses_hash_ck" CHECK ("luxify_consent_challenge_uses"."challenge_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "luxify_consent_challenge_uses" ADD CONSTRAINT "luxify_consent_challenge_uses_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION luxify_consent_challenge_uses_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'luxify_consent_challenge_uses rows are insert-only';
END $$;
--> statement-breakpoint
CREATE TRIGGER luxify_consent_challenge_uses_insert_only_trg BEFORE UPDATE OR DELETE ON luxify_consent_challenge_uses
FOR EACH ROW EXECUTE FUNCTION luxify_consent_challenge_uses_insert_only();
--> statement-breakpoint
CREATE FUNCTION lux_staff_grant_revoked_cascade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE luxify_look_creative_approvals
      SET revoked_at = greatest(NEW.revoked_at, approved_at)
      WHERE staff_grant_id = NEW.id AND revoked_at IS NULL;
    UPDATE luxify_creative_asset_approvals
      SET revoked_at = greatest(NEW.revoked_at, approved_at)
      WHERE staff_grant_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER lux_staff_grant_revoked_cascade_trg AFTER UPDATE OF revoked_at ON lux_staff_grants
FOR EACH ROW EXECUTE FUNCTION lux_staff_grant_revoked_cascade();
--> statement-breakpoint
UPDATE "luxify_look_creative_approvals" AS "approval" SET "revoked_at" = greatest("grant"."revoked_at", "approval"."approved_at") FROM "lux_staff_grants" AS "grant" WHERE "grant"."id" = "approval"."staff_grant_id" AND "grant"."revoked_at" IS NOT NULL AND "approval"."revoked_at" IS NULL;
--> statement-breakpoint
UPDATE "luxify_creative_asset_approvals" AS "approval" SET "revoked_at" = greatest("grant"."revoked_at", "approval"."approved_at") FROM "lux_staff_grants" AS "grant" WHERE "grant"."id" = "approval"."staff_grant_id" AND "grant"."revoked_at" IS NOT NULL AND "approval"."revoked_at" IS NULL;
