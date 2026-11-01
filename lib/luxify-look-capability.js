import { createHash } from 'node:crypto';

/**
 * Run-time LUXIFY capability derivation from ONE read-only HeyGen look read
 * (GET /v3/avatars/looks/{look_id}).
 *
 * Rule (owner decision Nov 1, 2026): a look is eligible when HeyGen returns
 * the requested look id with `status: "completed"` AND the look belongs to
 * the account's pinned HeyGen space. There is NO engine requirement: HeyGen's
 * Cinematic Avatar docs take any 1-3 look ids and state no engine,
 * look-type or supported_api_engines prerequisite
 * (developers.heygen.com/cinematic-avatar). supported_api_engines is recorded
 * for audit only and never decides eligibility.
 *
 * Ownership proof (fail closed):
 *   - the caller has already proven the configured HeyGen key belongs to the
 *     account's pinned space (fresh space binding, fingerprint match);
 *   - the look's `data.group_id` must equal the avatar group recorded on the
 *     account's own identity row (provider_avatar_group_id, unique per provider).
 *   If the identity has no recorded group, or the response has no group_id,
 *   ownership cannot be shown and nothing is recorded.
 *
 * Outcomes:
 *   - malformed read, another look id, or ownership not provable -> throws
 *     LUXIFY_CAPABILITY_UNPROVEN, no evidence written;
 *   - a look that is not completed, or that belongs to another group ->
 *     evidence with eligible=false, which supersedes older open evidence.
 *
 * evidenceSha256 is the SHA-256 of the exact response body bytes HeyGen
 * returned, so the stored row is bound to what the provider said.
 */
export const LUXIFY_CAPABILITY_STATUS_FIELD = 'data.status';
export const LUXIFY_CAPABILITY_REQUIRED_STATUS = 'completed';
export const LUXIFY_CAPABILITY_OWNERSHIP_FIELD = 'data.group_id';
export const LUXIFY_CAPABILITY_CHECK_WINDOW_DAYS = 30;

const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,80}$/;

function unproven(reason) {
  return Object.assign(new Error('HeyGen did not return usable capability data for this look.'), {
    code: 'LUXIFY_CAPABILITY_UNPROVEN', statusCode: 409, failureCategory: 'PROVIDER_READBACK', reason,
  });
}

export function deriveLuxifyLookCapability({ providerLookId, expectedGroupId, responseText, payload }) {
  if (!PROVIDER_ID.test(String(providerLookId || ''))) throw unproven('LOOK_ID_INVALID');
  if (typeof expectedGroupId !== 'string' || !PROVIDER_ID.test(expectedGroupId)) throw unproven('OWNERSHIP_UNPROVEN');
  if (typeof responseText !== 'string' || !responseText.length) throw unproven('RESPONSE_EMPTY');
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.data : null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unproven('RESPONSE_SHAPE');
  if (data.id !== providerLookId) throw unproven('LOOK_MISMATCH');
  if (typeof data.group_id !== 'string' || !PROVIDER_ID.test(data.group_id)) throw unproven('OWNERSHIP_FIELD_MISSING');
  if (typeof data.status !== 'string' || !SAFE_VALUE.test(data.status)) throw unproven('STATUS_MISSING');
  if (typeof data.avatar_type !== 'string' || !SAFE_VALUE.test(data.avatar_type)) throw unproven('AVATAR_TYPE_MISSING');
  const rawEngines = data.supported_api_engines === undefined ? [] : data.supported_api_engines;
  if (!Array.isArray(rawEngines) || rawEngines.length > 20 || rawEngines.some(engine => typeof engine !== 'string' || !SAFE_VALUE.test(engine))) {
    throw unproven('ENGINES_FIELD_INVALID');
  }
  const supportedApiEngines = [...new Set(rawEngines)];
  const completed = data.status === LUXIFY_CAPABILITY_REQUIRED_STATUS;
  const owned = data.group_id === expectedGroupId;
  return Object.freeze({
    providerLookId,
    eligible: completed && owned,
    ineligibleReason: !owned ? 'OWNER_MISMATCH' : (!completed ? 'NOT_COMPLETED' : null),
    avatarType: data.avatar_type,
    supportedApiEngines: Object.freeze(supportedApiEngines),
    evidenceSha256: createHash('sha256').update(responseText, 'utf8').digest('hex'),
  });
}
