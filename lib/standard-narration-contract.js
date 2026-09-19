import { featureEnabled } from './video-os-security.js';

// Standard tier (SadTalker Stage A): authorized portrait + authorized uploaded
// narration audio -> validated MP4. No script/TTS involved in this stage.
export const STANDARD_CONTRACT_VERSION = 'standard-narration-v1';

// Policy/pricing carry an explicit "-proposed" suffix until the owner approves
// them (see ACCESS_AND_DECISIONS.md #2/#4 in the backend handoff). Do not drop
// the suffix without that approval being recorded.
export const STANDARD_NARRATION_POLICY_VERSION = 'standard-narration-consent-v1-proposed';
export const STANDARD_NARRATION_PRICING_VERSION = 'standard-narration-pricing-v1-proposed';

export const STANDARD_NARRATION_CREDITS = 90;
export const STANDARD_NARRATION_QUOTE_TTL_MS = 5 * 60 * 1000;
export const STANDARD_NARRATION_PROCESSING_SCOPE = 'standard_sadtalker_stage_a_v1';

// String values matter: the frontend (public/standard-contract.js,
// public/studio.js's standardFailureMessage) already matches specific codes
// by exact literal value. Keep these in sync with that file if either changes.
export const STANDARD_NARRATION_REASON_CODES = Object.freeze({
  VALIDATION: 'standard_narration_validation',
  OWNERSHIP: 'standard_narration_ownership',
  ACCOUNT_NOT_AUTHORIZED: 'standard_narration_account_not_authorized',
  IDENTITY_CONSENT: 'standard_narration_identity_consent_invalid',
  SOURCE_POLICY: 'standard_narration_source_policy',
  NARRATION_CONSENT: 'standard_narration_consent_invalid',
  NARRATION_CONSENT_REQUIRED: 'standard_narration_consent_required',
  BINDING_REQUIRED: 'standard_narration_binding_required',
  INSUFFICIENT_CREDITS: 'standard_narration_insufficient_credits',
  MIGRATION_UNAPPROVED: 'standard_narration_migration_unapproved',
  POLICY_UNAPPROVED: 'standard_narration_policy_unapproved',
  PRICING_UNAPPROVED: 'standard_narration_pricing_unapproved',
  DURABLE_WORKFLOW_DISABLED: 'standard_narration_durable_workflow_disabled',
  RENDER_DISABLED: 'standard_narration_render_disabled',
  ACCOUNT_GATE_UNAVAILABLE: 'standard_narration_account_gate_unavailable',
  IDEMPOTENCY_MISMATCH: 'standard_narration_idempotency_mismatch',
  QUOTE_MISMATCH: 'standard_narration_quote_mismatch',
  QUOTE_CONSUMED: 'standard_narration_quote_consumed',
  QUOTE_EXPIRED: 'standard_narration_quote_expired',
  RECONCILIATION: 'standard_narration_reconciliation',
  UNAVAILABLE: 'standard_narration_unavailable',
});

const KNOWN_REASON_CODES = new Set(Object.values(STANDARD_NARRATION_REASON_CODES));

export function sanitizeStandardNarrationReason(code) {
  const normalized = String(code || '').trim();
  return KNOWN_REASON_CODES.has(normalized) ? normalized : STANDARD_NARRATION_REASON_CODES.UNAVAILABLE;
}

// Schema readiness and activation are deliberately independent, explicit gates
// (four separate env vars, all required) rather than one toggle -- an
// environment variable typo or a single flipped flag must not be enough to
// activate real reservation/rendering. Every one of these defaults to unset
// (disabled) and must be an exact 'true' string. None of these are set in any
// shared/production configuration by this change; enabling them for anything
// beyond local simulation testing is an owner decision (MASTER_SPEC.md 0.3/0.4).
export function standardNarrationSchemaReadiness() {
  if (process.env.VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY !== 'true') {
    return { ready: false, reasonCode: STANDARD_NARRATION_REASON_CODES.MIGRATION_UNAPPROVED, blockers: [STANDARD_NARRATION_REASON_CODES.MIGRATION_UNAPPROVED] };
  }
  return { ready: true };
}

export function standardNarrationActivation({ accountId } = {}) {
  const schema = standardNarrationSchemaReadiness({ accountId });
  if (!schema.ready) return schema;
  if (process.env.VIDEO_OS_STANDARD_NARRATION_POLICY_APPROVED !== 'true') {
    return { ready: false, reasonCode: STANDARD_NARRATION_REASON_CODES.POLICY_UNAPPROVED, blockers: [STANDARD_NARRATION_REASON_CODES.POLICY_UNAPPROVED] };
  }
  if (process.env.VIDEO_OS_STANDARD_NARRATION_PRICING_APPROVED !== 'true') {
    return { ready: false, reasonCode: STANDARD_NARRATION_REASON_CODES.PRICING_UNAPPROVED, blockers: [STANDARD_NARRATION_REASON_CODES.PRICING_UNAPPROVED] };
  }
  if (!featureEnabled('VIDEO_OS_STANDARD_RENDER_ENABLED')) {
    return { ready: false, reasonCode: STANDARD_NARRATION_REASON_CODES.RENDER_DISABLED, blockers: [STANDARD_NARRATION_REASON_CODES.RENDER_DISABLED] };
  }
  return { ready: true };
}
