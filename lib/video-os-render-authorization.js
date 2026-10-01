// Durable permission decision stored by the server at reservation time.
import { isTesterAccountId, isTesterEmailExact } from './video-os-testers.js';

export function configuredPremiumIdentity(accountId, email, env = process.env) {
  return isTesterAccountId(accountId) || isTesterEmailExact(email)
    || String(env.VIDEO_OS_RENDER_ACCOUNT_ID || '').split(',').map(id => id.trim()).filter(Boolean).includes(String(accountId || '').trim());
}

export const RENDER_AUTHORIZATION_VERSION = 1;
export function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  return value;
}
const keys = { standard: ['standardRendering', 'fullAccess', 'ownerAccess'], premium: ['liveRendering', 'fullAccess', 'ownerAccess'] };

export function renderAuthorization(accountId, tier, grants, now = new Date()) {
  if (!keys[tier]) throw new TypeError('Unknown render tier.');
  const grant = grants.find(item => item.accountId === accountId && item.enabled === true
    && keys[tier].includes(item.entitlementKey)
    && (!item.expiresAt || new Date(item.expiresAt) > now));
  if (!grant) throw Object.assign(new Error('This account is not authorized for this render tier.'), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
  return { version: RENDER_AUTHORIZATION_VERSION, accountId, tier, entitlementKey: grant.entitlementKey, sourceType: grant.sourceType, sourceId: grant.sourceId || null };
}

export function assertJobAuthorizationBinding(job, tier) {
  const decision = job.input?.renderAuthorization;
  // Pre-repair jobs may finish only after checking current persisted permission.
  if (decision === undefined) return;
  if (!decision || decision.version !== RENDER_AUTHORIZATION_VERSION || decision.accountId !== job.accountId
    || decision.tier !== tier || !keys[tier]?.includes(decision.entitlementKey)
    || decision.jobId !== job.id) {
    throw Object.assign(new Error('Render authorization does not match the reserved job.'), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
  }
}
