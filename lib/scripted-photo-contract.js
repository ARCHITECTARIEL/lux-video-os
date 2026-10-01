import { assertJobAuthorizationBinding } from './video-os-render-authorization.js';

export const SCRIPTED_PHOTO_CONTRACT_VERSION = 'scripted-photo-v1';
export const SCRIPTED_PHOTO_FEATURE_FLAG = 'VIDEO_OS_SCRIPTED_PHOTO_ENABLED';
export const STANDARD_SCRIPTED_PHOTO_CREDITS_ENV = 'VIDEO_OS_STANDARD_SCRIPTED_CREDITS';
export const PREMIUM_SCRIPTED_PHOTO_CREDITS = 90;
// Workflow 4.x reconstructs step errors from message + stack and drops custom
// properties. These exact, bounded server-authored codes are therefore the
// durable release/hold signal; do not replace them with ad-hoc Error fields.
const DURABLE_HEYGEN_PRECLAIM_PREFIX = 'VIDEO_OS_HEYGEN_PRECLAIM_V1:';
const DURABLE_PROVIDER_SUBMISSION_POSSIBLE = 'VIDEO_OS_PROVIDER_SUBMISSION_POSSIBLE_V1';
const durablePreclaimCategories = new Set(['CONFIG_MISSING', 'VALIDATION', 'ENTITLEMENT', 'CONSENT', 'RECONCILIATION']);

const tierDetails = new Map([
  ['STANDARD', Object.freeze({ tier: 'standard' })],
  ['PREMIUM', Object.freeze({ tier: 'premium' })],
]);

function failure(message, failureCategory = 'RECONCILIATION', statusCode = 409) {
  return Object.assign(new Error(message), { failureCategory, statusCode });
}

function tierForMarker(marker) {
  const details = tierDetails.get(marker);
  if (!details) throw failure('Scripted-photo tier is invalid.', 'VALIDATION', 400);
  return details;
}

export function isScriptedPhotoRequest(value) {
  return value?.contractVersion === SCRIPTED_PHOTO_CONTRACT_VERSION;
}

export function hasScriptedPhotoContractMarker(value) {
  return typeof value?.contractVersion === 'string' && value.contractVersion.toLowerCase().startsWith('scripted-photo')
    || Boolean(value && typeof value === 'object' && Object.hasOwn(value, 'sourceBinding'));
}

export function scriptedPhotoActivation(marker, env = process.env) {
  const details = tierForMarker(marker);
  if (String(env[SCRIPTED_PHOTO_FEATURE_FLAG] || '').trim().toLowerCase() !== 'true') {
    throw failure('Scripted-photo rendering is disabled.', 'CONFIG_MISSING', 503);
  }
  if (marker === 'PREMIUM') return { tier: details.tier, provider: 'heygen', costCredits: PREMIUM_SCRIPTED_PHOTO_CREDITS };
  const rawCost = String(env[STANDARD_SCRIPTED_PHOTO_CREDITS_ENV] || '').trim();
  const costCredits = Number(rawCost);
  if (!rawCost || !Number.isSafeInteger(costCredits) || costCredits <= 0) {
    throw failure('Standard scripted-photo credit cost is not configured.', 'CONFIG_MISSING', 503);
  }
  return { tier: details.tier, provider: 'heygen', costCredits };
}

export function validateScriptedPhotoTransport(req, env = process.env) {
  const headers = req?.headers || {};
  if (!env.VIDEO_OS_PUBLIC_ORIGIN || headers.origin !== env.VIDEO_OS_PUBLIC_ORIGIN || !['same-origin', 'none', undefined].includes(headers['sec-fetch-site'])) {
    throw failure('Origin not allowed.', 'VALIDATION', 403);
  }
  if (String(headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw failure('JSON required.', 'VALIDATION', 400);
  }
  return true;
}

export function renderTierForReservation({ provider, input, tier }) {
  if (isScriptedPhotoRequest(input)) {
    const details = tierDetails.get(input?.tier);
    if (provider !== 'heygen' || !details || tier !== details.tier || input?.renderAuthorization !== undefined) {
      throw failure('Scripted-photo reservation binding is invalid.');
    }
    return details.tier;
  }
  if (hasScriptedPhotoContractMarker(input)) throw failure('Scripted-photo contract version is invalid.');
  if (provider === 'heygen') return 'premium';
  if (provider === 'sadtalker') return 'standard';
  throw failure('Render provider cannot be mapped to a tier.');
}

export function renderTierForJob(job, { unknownLegacy = 'error' } = {}) {
  if (isScriptedPhotoRequest(job?.input)) {
    if (job?.provider !== 'heygen') throw failure('Scripted-photo provider binding is invalid.');
    const marker = job.input?.tier;
    const details = tierDetails.get(marker);
    const authority = job.input?.renderAuthorization;
    if (!details || !authority) throw failure('Scripted-photo authorization binding is invalid.');
    try { assertJobAuthorizationBinding(job, details.tier); } catch { throw failure('Scripted-photo authorization binding is invalid.'); }
    return details.tier;
  }
  if (hasScriptedPhotoContractMarker(job?.input)) throw failure('Scripted-photo contract version is invalid.');
  if (job?.provider === 'heygen') return 'premium';
  if (job?.provider === 'sadtalker') return 'standard';
  if (unknownLegacy === 'null') return null;
  throw failure('Render provider cannot be mapped to a tier.');
}

export function assertScriptedPhotoJobActivation(job, env = process.env) {
  if (!isScriptedPhotoRequest(job?.input)) return null;
  const tier = renderTierForJob(job);
  const activation = scriptedPhotoActivation(tier === 'standard' ? 'STANDARD' : 'PREMIUM', env);
  if (job.costCredits !== activation.costCredits) throw failure('Scripted-photo credit cost no longer matches configuration.');
  return activation;
}

export function assertScriptedPhotoHeygenInput(job, env = process.env) {
  if (!isScriptedPhotoRequest(job?.input)) return true;
  renderTierForJob(job);
  const timeout = Number(env.HEYGEN_TIMEOUT_MS || 20_000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw failure('HeyGen timeout configuration is invalid.', 'CONFIG_MISSING', 503);
  const providerId = /^[A-Za-z0-9_.:-]{1,255}$/;
  const input = job.input;
  const avatarId = input.avatar?.avatarId;
  const voiceId = input.voice?.voiceId;
  if (!providerId.test(String(avatarId || '')) || !providerId.test(String(voiceId || ''))
    || avatarId !== input.sourceBinding?.providerRenderableAvatarId || voiceId !== input.sourceBinding?.providerVoiceId
    || input.sourceBinding?.provider !== 'heygen'
    || typeof input.script !== 'string' || !input.script.trim() || input.script.length > 900
    || typeof job.title !== 'string' || !job.title.trim() || job.title.length > 120
    || !['vertical', 'landscape', 'square'].includes(job.format)
    || Object.hasOwn(input, 'productionKit')) {
    throw failure('Scripted-photo HeyGen input is invalid.', 'VALIDATION', 400);
  }
  return true;
}

export function durableHeygenPreclaimMessage(failureCategory) {
  const category = durablePreclaimCategories.has(failureCategory) ? failureCategory : 'RECONCILIATION';
  return `${DURABLE_HEYGEN_PRECLAIM_PREFIX}${category}`;
}

export function durableProviderSubmissionPossibleMessage() {
  return DURABLE_PROVIDER_SUBMISSION_POSSIBLE;
}

export function parseDurableRenderFailure(error) {
  const message = String(error?.message || '');
  if (message === DURABLE_PROVIDER_SUBMISSION_POSSIBLE) return { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' };
  if (message.startsWith(DURABLE_HEYGEN_PRECLAIM_PREFIX)) {
    const category = message.slice(DURABLE_HEYGEN_PRECLAIM_PREFIX.length);
    return durablePreclaimCategories.has(category) ? { kind: 'heygen-preclaim', failureCategory: category } : null;
  }
  return null;
}
