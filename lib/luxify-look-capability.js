import { createHash } from 'node:crypto';

import { LUXIFY_CINEMATIC_CAPABILITY } from './luxify-look-eligibility.js';

/**
 * Run-time LUXIFY capability derivation from ONE read-only HeyGen look read
 * (GET /v3/avatars/looks/{look_id}).
 *
 * Field decision (documented in the PR):
 *   cinematic_avatar support is proven ONLY by the response field
 *   `data.supported_api_engines` (an array of strings) containing the exact
 *   value "cinematic_avatar". Nothing else counts: not avatar_type, not the
 *   presence of avatar_iv/avatar_v, not tags, not a staff-supplied value.
 *
 * Fail closed:
 *   - the read is malformed, is for another look, or lacks avatar_type or
 *     supported_api_engines -> no evidence is recorded at all;
 *   - the look is not `status: "completed"` or the array does not contain
 *     "cinematic_avatar" -> evidence is recorded with eligible=false, which
 *     also supersedes any older open evidence for that look.
 *
 * evidenceSha256 is the SHA-256 of the exact response body bytes HeyGen
 * returned, so the stored row is bound to what the provider said.
 */
export const LUXIFY_CAPABILITY_PROOF_FIELD = 'data.supported_api_engines';
export const LUXIFY_CAPABILITY_PROOF_VALUE = LUXIFY_CINEMATIC_CAPABILITY;
export const LUXIFY_CAPABILITY_CHECK_WINDOW_DAYS = 30;

const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,80}$/;

function unproven(reason) {
  return Object.assign(new Error('HeyGen did not return usable capability data for this look.'), {
    code: 'LUXIFY_CAPABILITY_UNPROVEN', statusCode: 409, failureCategory: 'PROVIDER_READBACK', reason,
  });
}

export function deriveLuxifyLookCapability({ providerLookId, responseText, payload }) {
  if (!PROVIDER_ID.test(String(providerLookId || ''))) throw unproven('LOOK_ID_INVALID');
  if (typeof responseText !== 'string' || !responseText.length) throw unproven('RESPONSE_EMPTY');
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.data : null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unproven('RESPONSE_SHAPE');
  if (data.id !== providerLookId) throw unproven('LOOK_MISMATCH');
  if (typeof data.avatar_type !== 'string' || !SAFE_VALUE.test(data.avatar_type)) throw unproven('AVATAR_TYPE_MISSING');
  if (!Array.isArray(data.supported_api_engines)) throw unproven('ENGINES_FIELD_MISSING');
  if (data.supported_api_engines.length > 20 || data.supported_api_engines.some(engine => typeof engine !== 'string' || !SAFE_VALUE.test(engine))) {
    throw unproven('ENGINES_FIELD_INVALID');
  }
  const supportedApiEngines = [...new Set(data.supported_api_engines)];
  const eligible = data.status === 'completed' && supportedApiEngines.includes(LUXIFY_CAPABILITY_PROOF_VALUE);
  return Object.freeze({
    providerLookId,
    eligible,
    avatarType: data.avatar_type,
    supportedApiEngines: Object.freeze(supportedApiEngines),
    evidenceSha256: createHash('sha256').update(responseText, 'utf8').digest('hex'),
  });
}
