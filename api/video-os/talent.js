import crypto from 'node:crypto';
import { z } from 'zod';

import { sessionFromRequest } from '../../lib/video-os-account.js';
import { consumeRateLimit, requirePersistedRenderAuthorization } from '../../db/repositories.js';
import { FEATURED_CAST } from '../../lib/video-os-featured-cast.js';
import { avatarGroupConsentEligible, fetchHeygenCollection, fetchHeygenPaginatedCollection, normalizeAvatarGroup, normalizeAvatarLook } from '../../services/heygen.js';
import { blockForDiagnosticMaintenance } from '../../lib/diagnostic-maintenance-gate.js';

const itemSchema = z.record(z.string(), z.unknown());
const compact = (value, max = 160) => String(value || '').trim().slice(0, max);
const PROVIDER_TALENT_ID = Symbol('providerTalentId');
const groupReadInflight = new WeakMap();
const HEYGEN_API_ORIGIN = 'https://api.heygen.com';
const DEFAULT_PRESENTER_VOICE_URLS = Object.freeze([
  `${HEYGEN_API_ORIGIN}/v3/voices?type=private&limit=100`,
]);
const PRESENTER_VOICE_MAX_PAGES = 3;
const PRIVATE_AVATAR_MAX_PAGES = 4;
const TALENT_INVENTORY_MAX_CALLS = 8;
const TALENT_INVENTORY_TIMEOUT_MS = 8_000;
const TALENT_RATE_LIMIT_WINDOW_MS = 60_000;
const TALENT_RATE_LIMIT_DEFAULT = 6;

function sharedTalentReference(providerId, kind) {
  const normalized = compact(providerId);
  if (!normalized || !['avatar', 'voice'].includes(kind)) throw new TypeError('Provider talent reference is invalid.');
  const digest = crypto.createHash('sha256').update(kind + ':' + normalized).digest('base64url').slice(0, 32);
  return 'shared:' + kind + ':' + digest;
}

function withProviderIdentity(item, reference, providerId) {
  const result = { ...item, id: reference };
  Object.defineProperty(result, PROVIDER_TALENT_ID, { value: compact(providerId), enumerable: false });
  return result;
}

export function providerTalentId(item) {
  return compact(item?.[PROVIDER_TALENT_ID]);
}

function send(res, status, payload) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(payload)); }

function safeHttpsUrl(...values) {
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(String(value));
      if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
      url.search = '';
      url.hash = '';
      return url.href.slice(0, 2048);
    } catch {}
  }
  return '';
}

function flag(item, ...names) {
  for (const name of names) if (typeof item?.[name] === 'boolean') return item[name];
  return false;
}

function activeProviderRecord(item) {
  const status = compact(item.status || item.state, 40).toLowerCase();
  return !status || ['active', 'ready', 'completed', 'available'].includes(status);
}

function voiceInventoryConfigurationError(message) {
  return Object.assign(new Error(message), { statusCode: 503, failureCategory: 'CONFIG_INVALID' });
}

export function presenterVoiceInventoryUrls(env = process.env) {
  const configured = String(env.HEYGEN_VOICES_URL || '').trim();
  const values = configured ? [configured] : DEFAULT_PRESENTER_VOICE_URLS;
  return values.map((value) => {
    let url;
    try { url = new URL(value); } catch { throw voiceInventoryConfigurationError('HeyGen Presenter voice inventory URL was invalid.'); }
    if (url.origin !== HEYGEN_API_ORIGIN || url.username || url.password || url.port || url.hash) {
      throw voiceInventoryConfigurationError('HeyGen Presenter voice inventory URL must use the provider API origin.');
    }
    if (url.pathname !== '/v3/voices') {
      throw voiceInventoryConfigurationError('HeyGen Presenter voice inventory must use the v3 voice inventory endpoint.');
    }
    if (url.searchParams.has('token')) {
      throw voiceInventoryConfigurationError('HeyGen Presenter voice inventory configuration cannot pin a cursor token.');
    }
    for (const name of url.searchParams.keys()) {
      if (!['type', 'limit'].includes(name)) {
        throw voiceInventoryConfigurationError('HeyGen Presenter voice inventory query was invalid.');
      }
    }
    const types = url.searchParams.getAll('type');
    if (types.length !== 1 || types[0] !== 'private') {
      throw voiceInventoryConfigurationError('HeyGen Presenter voice inventory must request private voices.');
    }
    const limits = url.searchParams.getAll('limit');
    if (limits.length > 1) throw voiceInventoryConfigurationError('HeyGen Presenter voice inventory limit was invalid.');
    if (limits.length === 0) url.searchParams.set('limit', '100');
    else if (!/^\d{1,3}$/.test(limits[0]) || Number(limits[0]) < 1 || Number(limits[0]) > 100) {
      throw voiceInventoryConfigurationError('HeyGen Presenter voice inventory limit was invalid.');
    }
    return url.href;
  });
}

export function talentMinuteLimit(env = process.env) {
  const configured = Number(env.VIDEO_OS_TALENT_MINUTE_LIMIT || TALENT_RATE_LIMIT_DEFAULT);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= TALENT_RATE_LIMIT_DEFAULT
    ? configured
    : TALENT_RATE_LIMIT_DEFAULT;
}

export async function assertTalentRateLimit(accountId, {
  rateLimit = consumeRateLimit,
  limit = talentMinuteLimit(),
} = {}) {
  const normalizedAccountId = compact(accountId, 255);
  if (!normalizedAccountId) {
    throw Object.assign(new Error('Talent request account was invalid.'), {
      statusCode: 401,
      code: 'authentication_required',
    });
  }
  const effectiveLimit = Number.isSafeInteger(limit) && limit >= 1
    ? Math.min(limit, TALENT_RATE_LIMIT_DEFAULT)
    : TALENT_RATE_LIMIT_DEFAULT;
  const allowed = await rateLimit({
    accountId: normalizedAccountId,
    key: `talent:minute:${normalizedAccountId}`,
    limit: effectiveLimit,
    windowMs: TALENT_RATE_LIMIT_WINDOW_MS,
  });
  if (!allowed) {
    throw Object.assign(new Error('Talent inventory request limit reached. Try again in a while.'), {
      statusCode: 429,
      code: 'rate_limited',
    });
  }
}

function inventoryBudgetFailure(reason) {
  return Object.assign(new Error('HeyGen talent inventory request budget was exhausted.'), {
    statusCode: 503,
    failureCategory: 'PROVIDER_INVENTORY_BUDGET',
    code: reason === 'timeout' ? 'inventory_timeout' : 'inventory_call_limit',
  });
}

function boundedBudgetValue(value, fallback) {
  return Number.isSafeInteger(value) && value >= 1 && value <= fallback ? value : fallback;
}

function createTalentInventoryBudget(fetchImpl, options = {}) {
  const maxCalls = boundedBudgetValue(options.maxProviderCalls, TALENT_INVENTORY_MAX_CALLS);
  const timeoutMs = boundedBudgetValue(options.inventoryTimeoutMs, TALENT_INVENTORY_TIMEOUT_MS);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const startedAt = Number(now());
  const controller = new AbortController();
  let calls = 0;
  const timeout = setTimeout(() => controller.abort(inventoryBudgetFailure('timeout')), timeoutMs);
  timeout.unref?.();
  const assertActive = () => {
    if (controller.signal.aborted || Number(now()) - startedAt >= timeoutMs) {
      controller.abort(inventoryBudgetFailure('timeout'));
      throw inventoryBudgetFailure('timeout');
    }
  };
  return {
    signal: controller.signal,
    assertActive,
    async fetch(url, init) {
      assertActive();
      if (calls >= maxCalls) throw inventoryBudgetFailure('calls');
      calls += 1;
      return fetchImpl(url, init);
    },
    close() { clearTimeout(timeout); },
  };
}

async function settleInventory(load) {
  try {
    return { status: 'fulfilled', value: await load() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function privateVoiceRecord(item) {
  if (!Object.hasOwn(item, 'type')) return true;
  return typeof item.type === 'string' && item.type.trim().toLowerCase() === 'private';
}

export function normalizeTalentItem(item, prefix, options = {}) {
  const id = compact(item.id || item.avatar_id || item.voice_id || item.avatarId || item.voiceId);
  const candidatePreviewUrl = prefix === 'avatar' ? safeHttpsUrl(item.preview_image_url, item.previewImageUrl, item.thumbnail_url, item.thumbnailUrl, item.image_url, item.imageUrl) : '';
  const previewUrl = candidatePreviewUrl && id.length >= 24 && candidatePreviewUrl.toLowerCase().includes(id.toLowerCase()) ? '' : candidatePreviewUrl;
  return {
    id,
    name: compact(item.name || item.avatar_name || item.voice_name || item.display_name || item.displayName || id, 180),
    source: 'heygen',
    style: compact(item.style || item.gender || item.language || item.locale || 'available', 120),
    role: compact(item.type || item.category || 'Ready to render', 120),
    ...(previewUrl ? { previewUrl } : {}),
    shared: options.shared === true,
    featured: options.featured === true,
    active: activeProviderRecord(item),
    providerReady: options.providerReady !== false,
    archived: flag(item, 'archived', 'is_archived', 'isArchived'),
    blocked: flag(item, 'blocked', 'is_blocked', 'isBlocked'),
    providerOrder: Number.isInteger(options.providerOrder) ? options.providerOrder : 0,
  };
}

export function buildFeaturedAvatars(accountAvatars = []) {
  const byId = new Map(accountAvatars.map((item) => [compact(item.id || item.avatar_id || item.avatarId), item]));
  return FEATURED_CAST.map((featured, providerOrder) => {
    const raw = byId.get(featured.avatarId);
    const id = `featured:${featured.key}`;
    const matchedVoiceId = `featured:${featured.key}:voice`;
    if (!raw) return { id, name: featured.label, source: 'heygen', shared: false, featured: true, featuredKey: featured.key, matchedVoiceId, active: false, providerReady: false, archived: false, blocked: false, providerOrder, unavailableReason: 'This configured LUX presenter is not currently available from The Render.' };
    const item = normalizeTalentItem(raw, 'avatar', { featured: true, providerOrder });
    const ready = Boolean(item.previewUrl && item.active && !item.archived && !item.blocked);
    return withProviderIdentity({ ...item, name: featured.label, featuredKey: featured.key, matchedVoiceId, providerReady: ready, ...(ready ? {} : { unavailableReason: 'The Render returned this presenter without a usable active preview.' }) }, id, raw.id || raw.avatar_id || raw.avatarId);
  });
}

export function buildSharedAvatars(publicLooks = []) {
  const seen = new Set();
  return publicLooks.flatMap((raw, providerOrder) => {
    const engines = Array.isArray(raw.supported_api_engines) ? raw.supported_api_engines : [];
    const item = normalizeTalentItem(raw, 'avatar', { shared: true, providerReady: engines.includes('avatar_iv'), providerOrder: providerOrder + FEATURED_CAST.length });
    if (!item.id || seen.has(item.id) || !item.previewUrl || !item.active || !item.providerReady || item.archived || item.blocked) return [];
    const providerId = item.id;
    seen.add(providerId);
    const publicItem = item.name === providerId ? { ...item, name: 'Shared presenter ' + (providerOrder + 1) } : item;
    return [withProviderIdentity(publicItem, sharedTalentReference(providerId, 'avatar'), providerId)];
  });
}

export function buildVoices(voices = []) {
  const featuredByVoiceId = new Map(FEATURED_CAST.map((item) => [item.voiceId, item]));
  const seen = new Set();
  return voices.flatMap((raw, providerOrder) => {
    const item = normalizeTalentItem(raw, 'voice', { providerReady: true, providerOrder });
    if (!item.id || seen.has(item.id) || !item.active || item.archived || item.blocked) return [];
    seen.add(item.id);
    const providerId = item.id;
    const featured = featuredByVoiceId.get(providerId);
    const reference = featured ? 'featured:' + featured.key + ':voice' : sharedTalentReference(providerId, 'voice');
    const publicItem = !featured && item.name === providerId ? { ...item, name: 'Shared voice ' + (providerOrder + 1) } : item;
    return [withProviderIdentity({ ...publicItem, ...(featured ? { featuredKey: featured.key } : {}) }, reference, providerId)];
  });
}

async function authorizeTalentRequest(req) {
  try {
    const session = sessionFromRequest(req);
    if (!session.accountId) throw Object.assign(new Error('Sign in to access provider talent.'), { statusCode: 401 });
    await requirePersistedRenderAuthorization(session.accountId, 'premium');
    return { session };
  } catch (error) {
    const status = error?.statusCode === 401 ? 401 : error?.statusCode === 403 ? 403 : 503;
    return { error, status };
  }
}

async function eligiblePrivateFeaturedLooks(accountAvatars, { fetchImpl, key }) {
  const byId = new Map(accountAvatars.map((item) => [compact(item.id || item.avatar_id || item.avatarId, 255), item]));
  const featuredLooks = FEATURED_CAST.map((item) => byId.get(item.avatarId)).filter((raw) => {
    if (!raw) return false;
    const item = normalizeTalentItem(raw, 'avatar', { featured: true });
    return Boolean(item.previewUrl && item.active && !item.archived && !item.blocked);
  });
  const validGroupId = (value) => /^[A-Za-z0-9_.:-]{1,255}$/.test(value);
  const groupIds = [...new Set(featuredLooks.map((item) => compact(item.group_id, 255)).filter(validGroupId))];
  const groups = new Map();
  let groupReadFailed = false;
  for (let offset = 0; offset < groupIds.length; offset += 4) {
    const batch = groupIds.slice(offset, offset + 4);
    const results = await Promise.all(batch.map((groupId) => {
      let byKey = groupReadInflight.get(fetchImpl);
      if (!byKey) { byKey = new Map(); groupReadInflight.set(fetchImpl, byKey); }
      let reads = byKey.get(key);
      if (!reads) { reads = new Map(); byKey.set(key, reads); }
      const readKey = groupId;
      if (reads.has(readKey)) return reads.get(readKey);
      const read = (async () => {
        try {
          const response = await fetchImpl(`https://api.heygen.com/v3/avatars/${encodeURIComponent(groupId)}`, {
          signal: AbortSignal.timeout(8_000),
          headers: { Accept: 'application/json', 'X-Api-Key': key },
          });
          if (!response.ok) return null;
          const group = normalizeAvatarGroup(await response.json());
          return group.providerGroupId === groupId ? group : null;
        } catch {
          return null;
        }
      })().finally(() => {
        reads.delete(readKey);
        if (!reads.size && byKey.get(key) === reads) byKey.delete(key);
      });
      reads.set(readKey, read);
      return read;
    }));
    results.forEach((group, index) => {
      if (group) groups.set(batch[index], group);
      else groupReadFailed = true;
    });
  }
  const eligibleIds = new Set(featuredLooks.filter((item) => {
    const groupId = compact(item.group_id, 255);
    return avatarGroupConsentEligible(groups.get(groupId), normalizeAvatarLook(item), groupId);
  }).map((item) => compact(item.id || item.avatar_id || item.avatarId, 255)));
  return { eligibleIds, groupReadFailed };
}

export async function loadTalentInventory(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const key = String(env.HEYGEN_API_KEY || env.HEYGEN_TOKEN || '').trim();
  if (!key) {
    const fallbackFeatured = FEATURED_CAST.map((featured, providerOrder) => {
      const id = `featured:${featured.key}`;
      const matchedVoiceId = `featured:${featured.key}:voice`;
      return {
        id,
        name: featured.label,
        source: 'heygen',
        style: featured.gender || 'available',
        role: featured.role || 'Curated Presenter',
        previewUrl: `/assets/cast/${featured.key}.webp`,
        shared: false,
        featured: true,
        featuredKey: featured.key,
        matchedVoiceId,
        active: false,
        providerReady: false,
        archived: false,
        blocked: false,
        providerOrder,
        unavailableReason: 'The Render presenter inventory requires a configured provider credential.',
      };
    });
    const fallbackVoices = FEATURED_CAST.map((featured, providerOrder) => {
      const voiceRef = `featured:${featured.key}:voice`;
      return {
        id: voiceRef,
        name: `${featured.label} Voice (${featured.role || 'Executive'})`,
        source: 'heygen',
        style: featured.gender || 'available',
        role: featured.role || 'Matched voice',
        shared: false,
        featured: true,
        featuredKey: featured.key,
        active: false,
        providerReady: false,
        archived: false,
        blocked: false,
        providerOrder,
        unavailableReason: 'The Render voice inventory requires a configured provider credential.',
      };
    });
    return {
      talent: { source: 'curated-cast', avatars: fallbackFeatured, voices: fallbackVoices },
      connection: { connected: false, status: 'credential_missing' },
    };
  }
  const accountAvatarsUrl = env.HEYGEN_ACCOUNT_AVATARS_URL || 'https://api.heygen.com/v3/avatars/looks?ownership=private&limit=50';
  const publicLooksUrl = env.HEYGEN_AVATARS_URL || 'https://api.heygen.com/v3/avatars/looks?ownership=public&limit=50';
  let voiceUrls = [];
  let voiceConfigurationError;
  try {
    voiceUrls = presenterVoiceInventoryUrls(env);
  } catch (error) {
    voiceConfigurationError = error;
  }
  const budget = createTalentInventoryBudget(fetchImpl, options);
  let voiceResults;
  let accountAvatarsResult;
  let publicLooksResult;
  try {
    // Curated Presenter voices are private account resources. Load their
    // complete inventory before optional public looks so a shared page cannot
    // consume the budget required to prove an exact featured voice.
    voiceResults = voiceConfigurationError
      ? [{ status: 'rejected', reason: voiceConfigurationError }]
      : [];
    if (!voiceConfigurationError) {
      for (const url of voiceUrls) {
        voiceResults.push(await settleInventory(() => fetchHeygenPaginatedCollection(url, {
          apiKey: key,
          assertBudget: budget.assertActive,
          fetchImpl: budget.fetch,
          maxPages: PRESENTER_VOICE_MAX_PAGES,
          requireExplicitPagination: true,
          signal: budget.signal,
        })));
      }
    }
    accountAvatarsResult = await settleInventory(() => fetchHeygenPaginatedCollection(accountAvatarsUrl, {
      apiKey: key,
      assertBudget: budget.assertActive,
      fetchImpl: budget.fetch,
      maxPages: PRIVATE_AVATAR_MAX_PAGES,
      signal: budget.signal,
    }));
    publicLooksResult = await settleInventory(() => fetchHeygenPaginatedCollection(publicLooksUrl, {
      apiKey: key,
      assertBudget: budget.assertActive,
      fetchImpl: budget.fetch,
      maxPages: 1,
      maxItems: 50,
      allowTruncatedPageLimit: true,
      signal: budget.signal,
    }));
  } finally {
    budget.close();
  }
  const settled = [accountAvatarsResult, publicLooksResult, ...voiceResults];
  const accountAvatars = accountAvatarsResult.status === 'fulfilled' ? accountAvatarsResult.value.items : [];
  const publicLooks = publicLooksResult.status === 'fulfilled' ? publicLooksResult.value.items : [];
  const completeVoiceResults = voiceResults.filter((result) => (
    result.status === 'fulfilled'
    && result.value.complete === true
    && result.value.truncated === false
    && result.value.items.every(privateVoiceRecord)
  ));
  const voices = completeVoiceResults.flatMap((result) => result.value.items);
  const { eligibleIds, groupReadFailed } = await eligiblePrivateFeaturedLooks(accountAvatars, { fetchImpl, key });
  const rawFeaturedAvatars = buildFeaturedAvatars(accountAvatars);
  const featuredAvatars = rawFeaturedAvatars.map((avatar) => {
    const featured = FEATURED_CAST.find((f) => f.key === avatar.featuredKey);
    if (!featured) return avatar;
    const ready = avatar.providerReady && eligibleIds.has(featured.avatarId);
    return withProviderIdentity({
      ...avatar,
      previewUrl: avatar.previewUrl || `/assets/cast/${featured.key}.webp`,
      role: featured.role || 'Curated Presenter',
      style: featured.gender || 'available',
      providerReady: ready,
      unavailableReason: ready ? undefined : 'Presenter consent or provider readiness is not verified.',
    }, avatar.id, featured.avatarId);
  });
  const sharedAvatars = buildSharedAvatars(publicLooks).slice(0, Math.max(0, 20 - featuredAvatars.length));
  const normalizedVoices = buildVoices(voices);
  for (const featured of FEATURED_CAST) {
    const voiceRef = `featured:${featured.key}:voice`;
    if (!normalizedVoices.some((v) => v.id === voiceRef)) {
      normalizedVoices.push({
        id: voiceRef,
        name: `${featured.label} Voice (${featured.role || 'Executive'})`,
        source: 'heygen',
        style: featured.gender || 'available',
        role: featured.role || 'Matched voice',
        shared: false,
        featured: true,
        featuredKey: featured.key,
        active: false,
        providerReady: false,
        archived: false,
        blocked: false,
        providerOrder: normalizedVoices.length,
        unavailableReason: 'This configured LUX voice is not currently available from The Render.',
      });
    }
  }
  const ready = (item) => item.providerReady === true && item.active === true && item.archived !== true && item.blocked !== true;
  const connected = [...featuredAvatars, ...sharedAvatars].some(ready)
    && normalizedVoices.some(ready);
  const degraded = groupReadFailed || settled.some((result) => result.status === 'rejected')
    || completeVoiceResults.length !== voiceResults.length;
  return {
    talent: { source: degraded ? 'heygen-partial' : 'heygen', avatars: [...featuredAvatars, ...sharedAvatars], voices: normalizedVoices },
    connection: { connected, status: degraded ? 'degraded' : connected ? 'connected' : 'empty_inventory' },
  };
}

export function assertTalentSelectionsAvailable(talent, payload) {
  const avatarId = compact(payload?.avatar?.avatarId);
  const voiceId = compact(payload?.voice?.voiceId);
  const avatar = (talent?.avatars || []).find((item) => item.id === avatarId && item.providerReady === true && item.active === true && item.archived !== true && item.blocked !== true);
  const voice = (talent?.voices || []).find((item) => item.id === voiceId && item.providerReady !== false && item.active === true && item.archived !== true && item.blocked !== true);
  if (!avatar || !voice) throw Object.assign(new Error('Selected provider talent is unavailable.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  if (avatar.featuredKey && (voice.featuredKey !== avatar.featuredKey || avatar.matchedVoiceId !== voice.id)) {
    throw Object.assign(new Error('The exact matched voice for this featured presenter is unavailable.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  }
  const avatarProviderId = providerTalentId(avatar);
  const voiceProviderId = providerTalentId(voice);
  if (!avatarProviderId || !voiceProviderId) throw Object.assign(new Error('Selected provider talent cannot be resolved.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  return { avatar, voice, providerSelections: { avatarId: avatarProviderId, voiceId: voiceProviderId } };
}

export default async function handler(req, res) {
  if (blockForDiagnosticMaintenance(req, res)) return;
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for talent.' });
  const authorization = await authorizeTalentRequest(req);
  if (authorization.error) {
    const status = authorization.status;
    return send(res, status, { ok: false, code: status === 403 ? 'talent_forbidden' : status === 503 ? 'talent_contained' : 'authentication_required', error: status === 403 ? 'Talent inventory is unavailable for this account.' : status === 503 ? 'Talent inventory is contained pending configuration.' : 'Sign in to access provider talent.' });
  }
  try {
    await assertTalentRateLimit(authorization.session.accountId);
  } catch (error) {
    if (error?.statusCode === 429) {
      return send(res, 429, {
        ok: false,
        code: 'rate_limited',
        error: 'Talent inventory request limit reached. Try again in a while.',
      });
    }
    return send(res, 503, {
      ok: false,
      code: 'talent_contained',
      error: 'Talent inventory is contained pending configuration.',
    });
  }
  return send(res, 200, { ok: true, ...await loadTalentInventory() });
}
