import assert from 'node:assert/strict';

// Fixed to the reviewed migration tip. Do not derive this list from the target database.
export const isolatedLiveTableNames = Object.freeze([
  'users', 'credit_accounts', 'credit_transactions', 'job_events', 'media_assets',
  'rate_limits', 'stripe_events', 'video_jobs', 'auth_challenges', 'auth_sessions',
  'entitlements', 'projects', 'ops_events', 'identity_consents', 'user_identities',
  'standard_narration_consents', 'standard_narration_quotes', 'identity_video_enrollments',
  'identity_enrollment_events', 'provider_account_bindings', 'provider_verified_account_scopes',
  'provider_account_binding_promotions', 'provider_approval_claims',
  'provider_lifecycle_operations', 'provider_resources', 'provider_consumer_references',
  'provider_lifecycle_events', 'provider_approval_claim_resources', 'luxify_cinematic_consents',
]);

export function assertKnownIsolatedLiveTables(names) {
  assert.ok(names.every(name => isolatedLiveTableNames.includes(name)), 'Unexpected table in test database.');
}
