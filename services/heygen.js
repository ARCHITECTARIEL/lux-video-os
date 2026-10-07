import { parseOrThrow, providerStatusSchema, providerSubmitSchema } from '../lib/video-os-validation.js';
import { logEvent, timingSafeMatch } from '../lib/video-os-security.js';

const API_ORIGIN = 'https://api.heygen.com';
const timeoutMs = () => Number(process.env.HEYGEN_TIMEOUT_MS || 20_000);
const IDENTITY_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'audio/mpeg', 'audio/wav', 'audio/x-wav']);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;
const TERMINAL_READY = new Set(['complete', 'completed', 'ready', 'success', 'succeeded']);
const TERMINAL_FAILED = new Set(['error', 'failed', 'failure', 'rejected']);
const AVATAR_TYPES = new Set(['photo_avatar', 'prompt_avatar', 'digital_twin']);
const GROUP_CONSENT_STATES = new Set(['pending', 'accepted', 'rejected']);

export function assertHeygenConfigured(env = process.env) {
  const configured = Boolean(String(env.HEYGEN_API_KEY || env.HEYGEN_TOKEN || '').trim());
  if (!configured) throw Object.assign(new Error('HEYGEN_API_KEY is not configured.'), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  return true;
}

function key() {
  assertHeygenConfigured();
  return String(process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN).trim();
}

async function responseJson(response, category) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error('HeyGen returned invalid JSON.'), { failureCategory: category }); }
  if (!response.ok) {
    throw Object.assign(new Error(`HeyGen request failed with HTTP ${response.status}.`), {
      statusCode: 502,
      failureCategory: category,
      providerHttpStatus: response.status,
      providerErrorCode: safeProviderErrorCode(data?.error?.code),
    });
  }
  return data;
}

async function postWithReceiptValidation(path, options, validate) {
  // Once a POST is sent, an exception is not evidence that no resource exists.
  // Never automatically replay uploads/clones after a lost or unusable reply.
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, options);
    return await validate(await responseJson(response, 'PROVIDER_SUBMIT_UNKNOWN'));
  } catch (error) {
    const status = Number(error?.providerHttpStatus);
    const providerHttpStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
    throw Object.assign(new Error(providerHttpStatus
      ? `HeyGen request failed with HTTP ${providerHttpStatus}.`
      : 'HeyGen submission outcome is unknown and requires reconciliation.'), {
      statusCode: 502,
      failureCategory: 'PROVIDER_SUBMIT_UNKNOWN',
      providerSubmissionPossible: true,
      ...(providerHttpStatus ? { providerHttpStatus } : {}),
      providerErrorCode: safeProviderErrorCode(error?.providerErrorCode),
    });
  }
}

function enabled(value) { return String(value || '').trim().toLowerCase() === 'true'; }

function cleanProviderId(value, label) {
  const id = String(value || '').trim();
  if (!PROVIDER_ID_PATTERN.test(id)) throw Object.assign(new Error(`${label} was invalid.`), { statusCode: 400, failureCategory: 'INVALID_PROVIDER_REFERENCE' });
  return id;
}

function cleanDisplayName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 100) throw Object.assign(new Error('Identity name must be between 1 and 100 characters.'), { statusCode: 400, failureCategory: 'INVALID_IDENTITY_NAME' });
  return name;
}

function cleanFilename(value) {
  const filename = String(value || 'identity-asset').trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return filename || 'identity-asset';
}

function safeHttpsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.href.slice(0, 2048);
  } catch { return null; }
}

export function safeProviderErrorCode(value) {
  const code = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,80}$/.test(code) ? code : null;
}

export function normalizeIdentityProviderStatus(value, { hasPreview = false, hasFailure = false } = {}) {
  const rawStatus = String(value || '').trim().toLowerCase();
  if (hasFailure || TERMINAL_FAILED.has(rawStatus)) return 'failed';
  if (TERMINAL_READY.has(rawStatus) || (!rawStatus && hasPreview)) return 'completed';
  return 'processing';
}

export function assertIdentityProviderMutationEnabled(env = process.env) {
  if (!enabled(env.VIDEO_OS_IDENTITY_PROVIDER_ENABLED)) {
    throw Object.assign(new Error('Identity provider mutations are disabled.'), { statusCode: 503, failureCategory: 'IDENTITY_PROVIDER_DISABLED' });
  }
  if (!enabled(env.HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED)) {
    throw Object.assign(new Error('HeyGen identity asset privacy has not been confirmed.'), { statusCode: 503, failureCategory: 'IDENTITY_ASSET_PRIVACY_UNCONFIRMED' });
  }
}

export function assertIdentityProviderAccountAuthorized(accountId, env = process.env) {
  const allowed = String(env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID || '').trim();
  if (!allowed) throw Object.assign(new Error('Identity provider account is not configured.'), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  if (!timingSafeMatch(accountId, allowed)) throw Object.assign(new Error('This account is not authorized for identity provider creation.'), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
  return true;
}

function inventoryCollection(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  for (const field of ['avatars', 'voices', 'items', 'list']) if (Array.isArray(data?.[field])) return data[field];
  return [];
}

function inventoryPagination(payload) {
  const data = payload?.data;
  return {
    hasMore: Boolean(payload?.has_more ?? data?.has_more),
    nextToken: String(payload?.next_token ?? data?.next_token ?? '').trim().slice(0, 512),
  };
}

function inventoryUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw Object.assign(new Error('HeyGen inventory URL was invalid.'), { statusCode: 503, failureCategory: 'CONFIG_INVALID' }); }
  if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) throw Object.assign(new Error('HeyGen inventory URL must use the configured provider API origin.'), { statusCode: 503, failureCategory: 'CONFIG_INVALID' });
  return url;
}

async function fetchHeygenInventoryPage(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(inventoryUrl(url).href, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json', 'X-Api-Key': key() } });
  if (!response.ok) throw new Error(`HeyGen inventory HTTP ${response.status}`);
  return response.json();
}

export async function fetchHeygenCollection(url, options = {}) {
  return inventoryCollection(await fetchHeygenInventoryPage(url, options));
}

export async function fetchHeygenPaginatedCollection(url, options = {}) {
  const maxPages = Number.isInteger(options.maxPages) ? options.maxPages : 10;
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : Number.POSITIVE_INFINITY;
  const items = [];
  const itemIds = new Set();
  const tokens = new Set();
  const pageUrl = inventoryUrl(url);
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await fetchHeygenInventoryPage(pageUrl, options);
    for (const item of inventoryCollection(payload)) {
      const id = String(item?.id || item?.avatar_id || item?.avatarId || '').trim().slice(0, 160);
      if (id && itemIds.has(id)) continue;
      if (id) itemIds.add(id);
      items.push(item);
    }
    const { hasMore, nextToken } = inventoryPagination(payload);
    if (items.length >= maxItems) return { items: items.slice(0, maxItems), pages: page, complete: !hasMore, truncated: hasMore || items.length > maxItems };
    if (!hasMore) return { items, pages: page, complete: true, truncated: false };
    if (page === maxPages && options.allowTruncatedPageLimit === true) return { items, pages: page, complete: false, truncated: true };
    if (!nextToken) throw new Error('HeyGen inventory pagination did not return a next token.');
    if (tokens.has(nextToken)) throw new Error('HeyGen inventory returned a repeated pagination token.');
    tokens.add(nextToken);
    pageUrl.searchParams.set('token', nextToken);
  }
  throw new Error(`HeyGen inventory exceeded the ${maxPages}-page safety limit.`);
}

export function buildPhotoAvatarRequest({ assetId, name }) {
  return { type: 'photo', name: cleanDisplayName(name), file: { type: 'asset_id', asset_id: cleanProviderId(assetId, 'HeyGen asset ID') } };
}

export function buildVoiceCloneRequest({ assetId, name, language, removeBackgroundNoise = true }) {
  const body = {
    audio: { type: 'asset_id', asset_id: cleanProviderId(assetId, 'HeyGen asset ID') },
    voice_name: cleanDisplayName(name),
    remove_background_noise: removeBackgroundNoise !== false,
  };
  const languageHint = String(language || '').trim();
  if (languageHint) body.language = languageHint.slice(0, 32);
  return body;
}

export function normalizeAvatarGroup(payload) {
  const data = payload?.data || payload || {};
  const failureCode = safeProviderErrorCode(data?.error?.code);
  const status = normalizeIdentityProviderStatus(data.status, { hasFailure: Boolean(failureCode || data?.error?.message) });
  const rawConsent = typeof data.consent_status === 'string' ? data.consent_status.toLowerCase() : null;
  return {
    providerGroupId: typeof data.id === 'string' ? data.id : null,
    status,
    consentStatus: rawConsent && !GROUP_CONSENT_STATES.has(rawConsent) ? 'unknown' : rawConsent,
    ready: status === 'completed',
    failureCode,
    failureMessage: status === 'failed' ? 'HeyGen avatar processing failed.' : null,
  };
}

export function normalizeAvatarLook(payload) {
  const data = payload?.data || payload || {};
  const previewImageUrl = safeHttpsUrl(data.preview_image_url);
  const previewVideoUrl = safeHttpsUrl(data.preview_video_url);
  const failureCode = safeProviderErrorCode(data?.error?.code);
  const status = normalizeIdentityProviderStatus(data.status, { hasPreview: Boolean(previewImageUrl || previewVideoUrl), hasFailure: Boolean(failureCode || data?.error?.message) });
  return {
    providerLookId: typeof data.id === 'string' ? data.id : null,
    providerGroupId: typeof data.group_id === 'string' ? data.group_id : null,
    avatarType: AVATAR_TYPES.has(data.avatar_type) ? data.avatar_type : 'unknown',
    status,
    ready: status === 'completed' && typeof data.id === 'string',
    supportedEngines: Array.isArray(data.supported_api_engines) ? data.supported_api_engines.filter((item) => typeof item === 'string').slice(0, 10) : [],
    previewImageUrl,
    previewVideoUrl,
    failureCode,
    failureMessage: status === 'failed' ? 'HeyGen avatar look processing failed.' : null,
  };
}

export function normalizeVoice(payload) {
  const data = payload?.data || payload || {};
  const previewAudioUrl = safeHttpsUrl(data.preview_audio_url);
  const failureCode = safeProviderErrorCode(data.failure_code || data?.error?.code);
  const status = normalizeIdentityProviderStatus(data.status, { hasPreview: Boolean(previewAudioUrl), hasFailure: Boolean(failureCode || data.failure_message || data?.error?.message) });
  return {
    providerVoiceId: typeof data.voice_id === 'string' ? data.voice_id : null,
    status,
    ready: status === 'completed' && typeof data.voice_id === 'string' && Boolean(previewAudioUrl),
    previewAudioUrl,
    failureCode,
    failureMessage: status === 'failed' ? 'HeyGen voice cloning failed.' : null,
  };
}

async function heygenGet(path, category) {
  const response = await fetch(`${API_ORIGIN}${path}`, { signal: AbortSignal.timeout(timeoutMs()), headers: { Accept: 'application/json', 'X-Api-Key': key() } });
  return responseJson(response, category);
}

export function providerMediaHostname(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw Object.assign(new Error('HeyGen media URL was invalid.'), { failureCategory: 'PROVIDER_POLL' }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Object.assign(new Error('HeyGen media URL was invalid.'), { failureCategory: 'PROVIDER_POLL' });
  return url.hostname.toLowerCase();
}

export async function uploadHeygenIdentityAsset({ accountId, buffer, contentType, filename }) {
  assertIdentityProviderMutationEnabled();
  assertIdentityProviderAccountAuthorized(accountId);
  const normalizedType = String(contentType || '').trim().toLowerCase();
  if (!IDENTITY_CONTENT_TYPES.has(normalizedType)) throw Object.assign(new Error('Identity asset type is not supported by HeyGen.'), { statusCode: 400, failureCategory: 'UNSUPPORTED_IDENTITY_ASSET' });
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024) throw Object.assign(new Error('Identity asset size is invalid.'), { statusCode: 400, failureCategory: 'INVALID_IDENTITY_ASSET_SIZE' });
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: normalizedType }), cleanFilename(filename));
  return postWithReceiptValidation('/v3/assets', { method: 'POST', signal: AbortSignal.timeout(timeoutMs()), headers: { Accept: 'application/json', 'X-Api-Key': key() }, body: form }, payload => {
    const data = payload?.data || {};
    return {
    providerAssetId: cleanProviderId(data.asset_id || data.id, 'HeyGen asset ID'),
    contentType: typeof data.mime_type === 'string' ? data.mime_type : normalizedType,
    sizeBytes: Number.isFinite(data.size_bytes) ? data.size_bytes : bytes.byteLength,
    };
  });
}

export async function createHeygenPhotoAvatar({ accountId, assetId, name, idempotencyKey }) {
  assertIdentityProviderMutationEnabled();
  assertIdentityProviderAccountAuthorized(accountId);
  const requestKey = cleanProviderId(idempotencyKey, 'HeyGen idempotency key');
  return postWithReceiptValidation('/v3/avatars', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs()),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': key(), 'Idempotency-Key': requestKey },
    body: JSON.stringify(buildPhotoAvatarRequest({ assetId, name })),
  }, payload => {
    const data = payload?.data || {};
    const avatarGroup = normalizeAvatarGroup(data.avatar_group);
    const avatarLook = normalizeAvatarLook(data.avatar_item);
    cleanProviderId(avatarGroup.providerGroupId, 'HeyGen avatar group ID');
    cleanProviderId(avatarLook.providerLookId, 'HeyGen avatar look ID');
    if (avatarLook.providerGroupId !== avatarGroup.providerGroupId) {
      throw new Error('HeyGen avatar receipt has conflicting group references.');
    }
    return { avatarGroup, avatarLook };
  });
}

export async function getHeygenPhotoAvatarStatus({ groupId, lookId }) {
  const groupReference = cleanProviderId(groupId, 'HeyGen avatar group ID');
  const lookReference = cleanProviderId(lookId, 'HeyGen avatar look ID');
  const [groupPayload, lookPayload] = await Promise.all([
    heygenGet(`/v3/avatars/${encodeURIComponent(groupReference)}`, 'PHOTO_AVATAR_GROUP_POLL'),
    heygenGet(`/v3/avatars/looks/${encodeURIComponent(lookReference)}`, 'PHOTO_AVATAR_LOOK_POLL'),
  ]);
  const avatarGroup = normalizeAvatarGroup(groupPayload);
  const avatarLook = normalizeAvatarLook(lookPayload);
  const exactGroup = avatarGroup.providerGroupId === groupReference && avatarLook.providerGroupId === groupReference;
  const knownType = avatarLook.avatarType !== 'unknown';
  const consentAccepted = avatarGroup.consentStatus === 'accepted'
    || (avatarGroup.consentStatus === null && ['photo_avatar', 'prompt_avatar'].includes(avatarLook.avatarType));
  return {
    avatarGroup,
    avatarLook,
    ready: avatarGroup.ready && avatarLook.ready && exactGroup && knownType && consentAccepted,
    failed: avatarGroup.status === 'failed' || avatarLook.status === 'failed',
  };
}

export async function cloneHeygenVoice({ accountId, assetId, name, language, removeBackgroundNoise }) {
  assertIdentityProviderMutationEnabled();
  assertIdentityProviderAccountAuthorized(accountId);
  return postWithReceiptValidation('/v3/voices/clone', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs()),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': key() },
    body: JSON.stringify(buildVoiceCloneRequest({ assetId, name, language, removeBackgroundNoise })),
  }, payload => {
    const data = payload?.data || {};
    return { providerVoiceId: cleanProviderId(data.voice_clone_id || data.voice_id, 'HeyGen voice ID'), status: 'processing', ready: false };
  });
}

export async function getHeygenVoiceStatus(voiceId) {
  const reference = cleanProviderId(voiceId, 'HeyGen voice ID');
  return normalizeVoice(await heygenGet(`/v3/voices/${encodeURIComponent(reference)}`, 'VOICE_CLONE_POLL'));
}

export async function submitHeygen(job) {
  const input = job.input;
  const response = await fetch(`${API_ORIGIN}/v3/videos`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs()),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': key(), 'Idempotency-Key': job.id },
    body: JSON.stringify({ type: 'avatar', avatar_id: input.avatar.avatarId, script: input.script, voice_id: input.voice.voiceId, title: job.title, resolution: '1080p', aspect_ratio: job.format === 'landscape' ? '16:9' : job.format === 'square' ? '1:1' : '9:16' }),
  });
  const parsed = parseOrThrow(providerSubmitSchema, await responseJson(response, 'PROVIDER_SUBMIT'), 'HeyGen submission response was invalid.');
  return { providerJobId: parsed.data?.video_id || parsed.data?.id || parsed.data?.job_id || parsed.video_id || parsed.id || parsed.job_id };
}

export async function pollHeygen(providerJobId) {
  const response = await fetch(`${API_ORIGIN}/v3/videos/${encodeURIComponent(providerJobId)}`, { signal: AbortSignal.timeout(timeoutMs()), headers: { Accept: 'application/json', 'X-Api-Key': key() } });
  const parsed = parseOrThrow(providerStatusSchema, await responseJson(response, 'PROVIDER_POLL'), 'HeyGen status response was invalid.');
  const data = parsed.data || parsed;
  const status = String(data.status || parsed.status || '').toLowerCase();
  const sourceUrl = [data.video_url, data.videoUrl, data.download_url, data.downloadUrl, data.url].find((value) => typeof value === 'string');
  if (status === 'failed' || status === 'error') throw Object.assign(new Error('HeyGen render failed.'), { failureCategory: 'PROVIDER_REJECTED' });
  if (status === 'completed' && sourceUrl) logEvent('provider.media_ready', { providerHostname: providerMediaHostname(sourceUrl) });
  return { ready: status === 'completed' && Boolean(sourceUrl), status: status || 'processing', sourceUrl: sourceUrl || null };
}
