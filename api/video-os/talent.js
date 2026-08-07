import crypto from 'node:crypto';
import { z } from 'zod';

import { sessionFromRequest } from '../../lib/video-os-account.js';
import { requireRenderAccountAuthorization } from '../../lib/video-os-security.js';
import { FEATURED_CAST } from '../../lib/video-os-featured-cast.js';
import { fetchHeygenCollection, fetchHeygenPaginatedCollection } from '../../services/heygen.js';

const itemSchema = z.record(z.string(), z.unknown());
const compact = (value, max = 160) => String(value || '').trim().slice(0, max);
const PROVIDER_TALENT_ID = Symbol('providerTalentId');

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
    if (!raw) return { id, name: featured.label, source: 'heygen', shared: false, featured: true, featuredKey: featured.key, matchedVoiceId, active: false, providerReady: false, archived: false, blocked: false, providerOrder, unavailableReason: 'This configured LUX presenter is not currently available from HeyGen.' };
    const item = normalizeTalentItem(raw, 'avatar', { featured: true, providerOrder });
    const ready = Boolean(item.previewUrl && item.active && !item.archived && !item.blocked);
    return withProviderIdentity({ ...item, name: featured.label, featuredKey: featured.key, matchedVoiceId, providerReady: ready, ...(ready ? {} : { unavailableReason: 'HeyGen returned this presenter without a usable active preview.' }) }, id, raw.id || raw.avatar_id || raw.avatarId);
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

function authorizeTalentRequest(req) {
  try {
    const session = sessionFromRequest(req);
    requireRenderAccountAuthorization(session.accountId);
    return { session };
  } catch (error) {
    const status = error?.statusCode === 403 ? 403 : error?.statusCode === 503 ? 503 : 401;
    return { error, status };
  }
}

export async function loadTalentInventory(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const key = String(env.HEYGEN_API_KEY || env.HEYGEN_TOKEN || '').trim();
  if (!key) return { talent: { source: 'missing-key', avatars: buildFeaturedAvatars(), voices: [] }, connection: { connected: false, status: 'missing_key' } };
  const accountAvatarsUrl = env.HEYGEN_ACCOUNT_AVATARS_URL || 'https://api.heygen.com/v3/avatars/looks?ownership=private&limit=50';
  const publicLooksUrl = env.HEYGEN_AVATARS_URL || 'https://api.heygen.com/v3/avatars/looks?ownership=public&limit=50';
  const voicesUrl = env.HEYGEN_VOICES_URL || 'https://api.heygen.com/v2/voices';
  const settled = await Promise.allSettled([
    fetchHeygenPaginatedCollection(accountAvatarsUrl, { fetchImpl }),
    fetchHeygenPaginatedCollection(publicLooksUrl, { fetchImpl, maxPages: 1, maxItems: 50, allowTruncatedPageLimit: true }),
    fetchHeygenCollection(voicesUrl, { fetchImpl }),
  ]);
  const accountAvatars = settled[0].status === 'fulfilled' ? settled[0].value.items : [];
  const publicLooks = settled[1].status === 'fulfilled' ? settled[1].value.items : [];
  const voices = settled[2].status === 'fulfilled' ? settled[2].value : [];
  const featuredAvatars = buildFeaturedAvatars(accountAvatars);
  const sharedAvatars = buildSharedAvatars(publicLooks).slice(0, Math.max(0, 20 - featuredAvatars.length));
  const normalizedVoices = buildVoices(voices);
  const connected = Boolean(sharedAvatars.length && normalizedVoices.length);
  const degraded = settled.some((result) => result.status === 'rejected');
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
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for talent.' });
  const authorization = authorizeTalentRequest(req);
  if (authorization.error) {
    const status = authorization.status;
    return send(res, status, { ok: false, code: status === 403 ? 'talent_forbidden' : status === 503 ? 'talent_contained' : 'authentication_required', error: status === 403 ? 'Talent inventory is unavailable for this account.' : status === 503 ? 'Talent inventory is contained pending configuration.' : 'Sign in to access provider talent.' });
  }
  return send(res, 200, { ok: true, ...await loadTalentInventory() });
}
