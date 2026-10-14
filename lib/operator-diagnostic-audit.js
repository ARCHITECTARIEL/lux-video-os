// Only these keys may reach the default log or a future ops_events adapter.
export const DETAIL_KEYS = Object.freeze([
  'ok', 'code', 'deploymentMatched', 'gitCommitMatched', 'projectMatched',
  'stableAliasHostMatched', 'uniqueDeploymentHostMatched', 'canaryPinPresent',
  'canaryPinMatchesExpected', 'providerCreationFlagExactlyTrue',
  'providerCreationEnabledForExpectedPin', 'providerCreationEnabledWithoutAccount',
  'providerCreationEnabledForSyntheticAccount', 'identityProviderEnabled',
  'identityAssetPrivacyConfirmed', 'identityProviderPinMatchesCanaryPin',
  'hostedSubjectConsentEnabled', 'billingDisabled', 'durableRenderDisabled',
  'standardRenderDisabled', 'scriptedPhotoDisabled', 'phoneEnrollmentDisabled',
  'phoneExtractionDisabled', 'maintenanceAdmissionActive', 'canaryScopeAsExpected',
  'targetManifestMatched', 'canonicalUrlMatchesTarget', 'connectedDatabaseMatchesTarget',
  'providerCreationDisabled', 'providerCreationCanaryScoped', 'sourceByteAttested', 'readOnly',
]);

const EVENTS = new Set(['admin.canary_scope.checked', 'admin.db_binding.checked']);

export function diagnosticAuditDetails(body) {
  return Object.fromEntries(DETAIL_KEYS.filter((key) => {
    const value = body?.[key];
    return typeof value === 'boolean' || (key === 'code' && typeof value === 'string'
      && ['diagnostic_unavailable', 'operator_required', 'expected_identity_required',
        'nonce_invalid', 'nonce_replayed', 'skew', 'rate_limited'].includes(value));
  }).map((key) => [key, body[key]]));
}

export async function auditOperatorDiagnostic(event, body) {
  if (!EVENTS.has(event)) throw new Error('Unsupported diagnostic audit event');
  console.log(JSON.stringify({ event, detail: diagnosticAuditDetails(body) }));
}
