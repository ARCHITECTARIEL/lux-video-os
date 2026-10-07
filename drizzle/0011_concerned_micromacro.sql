ALTER TABLE "identity_consents" DROP CONSTRAINT "identity_consents_authorizations_ck";--> statement-breakpoint
ALTER TABLE "provider_lifecycle_operations" DROP CONSTRAINT "provider_lifecycle_operations_kind_ck";--> statement-breakpoint
ALTER TABLE "identity_consents" ADD CONSTRAINT "identity_consents_authorizations_ck" CHECK ((
    "identity_consents"."policy_version" = 'identity-provider-subject-consent-v3'
    and "identity_consents"."face_authorization"
    and "identity_consents"."voice_authorization" = false
    and "identity_consents"."provider_processing_authorization"
    and "identity_consents"."archive_delete_acknowledgment"
    and "identity_consents"."audio_extraction_authorization" = false
    and "identity_consents"."temporary_public_provider_exposure_authorization" = false
    and "identity_consents"."consent_purpose" = 'hosted-avatar-consent'
  ) or (
    "identity_consents"."policy_version" <> 'identity-provider-subject-consent-v3'
    and "identity_consents"."face_authorization"
    and "identity_consents"."voice_authorization"
    and "identity_consents"."provider_processing_authorization"
    and "identity_consents"."archive_delete_acknowledgment"
  ));--> statement-breakpoint
ALTER TABLE "provider_lifecycle_operations" ADD CONSTRAINT "provider_lifecycle_operations_kind_ck" CHECK ("provider_lifecycle_operations"."kind" in ('asset_upload', 'avatar_create', 'avatar_consent_submit', 'voice_clone', 'video_create', 'resource_read', 'resource_delete', 'url_probe'));