-- Review-only additive proposal. This file is not in drizzle/meta/_journal.json.
-- Assign a migration identity only after the optional-branch lineage decision.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.identity_consents
    WHERE (
      policy_version <> 'identity-provider-subject-consent-v3'
      OR consent_purpose IS NOT DISTINCT FROM 'hosted-avatar-consent'
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'Hosted consent purpose compatibility check failed' USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE public.identity_consents
  ADD CONSTRAINT identity_consents_hosted_v3_purpose_ck
  CHECK (
    policy_version <> 'identity-provider-subject-consent-v3'
    OR consent_purpose IS NOT DISTINCT FROM 'hosted-avatar-consent'
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE public.identity_consents
  VALIDATE CONSTRAINT identity_consents_hosted_v3_purpose_ck;
