# 2026-10-13 correction: provider creation activation

The October 1 execution notes accurately describe their checkpoints, when `providerCreationActivationStatus()` was hardcoded off. They do not describe the ID-001 local candidate at HEAD `23f207ad` or the subsequent ID-001b QA edits.

In the local candidate, `providerCreationActivationStatus(env, accountId)` is default-disabled and gated by `VIDEO_OS_PROVIDER_CREATION_ENABLED` (trimmed and case-insensitive `true`). While `VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID` is set, creation is enabled only for that exact account ID; other or missing account IDs are blocked. Other provider, consent, entitlement, cost and binding gates still apply. This correction does not establish production deployment or activation.

The diagnostic retains `providerCreationDisabled` as the no-account status and now reports `providerCreationCanaryScoped` separately. A canary-scoped enabled state blocks its containment attestation. Neither field exposes the pinned account ID.

Safe rollback order: unset `VIDEO_OS_PROVIDER_CREATION_ENABLED` and the enrollment flags **before** removing the canary pin. Removing the pin while provider creation remains enabled opens creation to all accounts subject to the other gates.
