// Only static diagnostic vocabulary may cross the provider/logging boundary.
const allowed = {
  stage: new Set(['read_body', 'validate', 'rate_limit', 'budget', 'generate']),
  code: new Set(['copywriter_provider_error', 'copywriter_internal_error', 'generation_timeout', 'generation_refused', 'copywriter_budget_unavailable', 'copywriter_budget_reached']),
  statusClass: new Set(['internal', 'upstream', 'billing', 'auth', 'model', 'forbidden', 'rate_limit', 'timeout', 'invalid_request', 'refusal']),
  providerErrorType: new Set(['insufficient_funds', 'quota_for_entity_exceeded', 'customer_verification_required', 'content_filter']),
  errorName: new Set(['APIError', 'GatewayAuthenticationError', 'GatewayModelNotFoundError', 'GatewayTimeoutError', 'AbortError', 'TimeoutError', 'AI_RetryError']),
  errorCode: new Set(['insufficient_funds', 'quota_for_entity_exceeded', 'customer_verification_required']),
  message: new Set(['AI writing could not be completed.']),
  gatewayAuthMode: new Set(['api-key', 'oidc', 'none']),
};

export function copywriterDiagnostic(field, value) {
  return allowed[field]?.has(value) ? value : null;
}
