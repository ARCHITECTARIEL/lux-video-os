import { z } from 'zod';

import { FEATURED_CAST } from '../../public/video-os-cast.js';

const itemSchema = z.record(z.string(), z.unknown());
const compact = (value, max = 160) => String(value || '').trim().slice(0, max);

function send(res, status, payload) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(payload)); }

function collection(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  for (const key of ['avatars', 'voices', 'items', 'list']) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

async function fetchCollection(url, key) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json', 'X-Api-Key': key } });
  if (!response.ok) throw new Error(`HeyGen inventory HTTP ${response.status}`);
  return collection(await response.json()).map((item) => itemSchema.parse(item));
}

function pagination(payload) {
  const data = payload?.data;
  return { hasMore: Boolean(payload?.has_more ?? data?.has_more), nextToken: compact(payload?.next_token ?? data?.next_token, 512) };
}

export async function fetchPaginatedCollection(url, key, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const maxPages = Number.isInteger(options.maxPages) ? options.maxPages : 10;
  const items = [];
  const itemIds = new Set();
  const tokens = new Set();
  const pageUrl = new URL(url);
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchImpl(pageUrl.href, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json', 'X-Api-Key': key } });
    if (!response.ok) throw new Error(`HeyGen inventory HTTP ${response.status}`);
    const payload = await response.json();
    for (const raw of collection(payload)) {
      const item = itemSchema.parse(raw);
      const id = compact(item.id || item.avatar_id || item.avatarId);
      if (id && itemIds.has(id)) continue;
      if (id) itemIds.add(id);
      items.push(item);
    }
    const { hasMore, nextToken } = pagination(payload);
    if (!hasMore) return { items, pages: page };
    if (!nextToken) throw new Error('HeyGen inventory pagination did not return a next token.');
    if (tokens.has(nextToken)) throw new Error('HeyGen inventory returned a repeated pagination token.');
    tokens.add(nextToken);
    pageUrl.searchParams.set('token', nextToken);
  }
  throw new Error(`HeyGen inventory exceeded the ${maxPages}-page safety limit.`);
}

function safeHttpsUrl(...values) {
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(String(value));
      if (url.protocol === 'https:') return url.href.slice(0, 2048);
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
  const previewUrl = prefix === 'avatar' ? safeHttpsUrl(item.preview_image_url, item.previewImageUrl, item.thumbnail_url, item.thumbnailUrl, item.image_url, item.imageUrl) : '';
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
    if (!raw) return { id: featured.avatarId, name: featured.label, source: 'heygen', shared: false, featured: true, active: false, providerReady: false, archived: false, blocked: false, providerOrder, unavailableReason: 'This configured LUX presenter is not currently available from HeyGen.' };
    const item = normalizeTalentItem(raw, 'avatar', { featured: true, providerOrder });
    const ready = Boolean(item.previewUrl && item.active && !item.archived && !item.blocked);
    return { ...item, name: featured.label, providerReady: ready, ...(ready ? {} : { unavailableReason: 'HeyGen returned this presenter without a usable active preview.' }) };
  });
}

export function buildSharedAvatars(publicLooks = []) {
  const seen = new Set();
  return publicLooks.flatMap((raw, providerOrder) => {
    const engines = Array.isArray(raw.supported_api_engines) ? raw.supported_api_engines : [];
    const item = normalizeTalentItem(raw, 'avatar', { shared: true, providerReady: engines.includes('avatar_iv'), providerOrder: providerOrder + FEATURED_CAST.length });
    if (!item.id || seen.has(item.id) || !item.previewUrl || !item.active || !item.providerReady || item.archived || item.blocked) return [];
    seen.add(item.id);
    return [item];
  });
}

export function buildVoices(voices = []) {
  const seen = new Set();
  return voices.flatMap((raw, providerOrder) => {
    const item = normalizeTalentItem(raw, 'voice', { providerReady: true, providerOrder });
    if (!item.id || seen.has(item.id) || !item.active || item.archived || item.blocked) return [];
    seen.add(item.id);
    return [item];
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for talent.' });
  const key = String(process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || '').trim();
  if (!key) return send(res, 200, { ok: true, talent: { source: 'missing-key', avatars: buildFeaturedAvatars(), voices: [] }, connection: { connected: false, status: 'missing_key', missing: ['HEYGEN_API_KEY'] } });
  const accountAvatarsUrl = process.env.HEYGEN_ACCOUNT_AVATARS_URL || 'https://api.heygen.com/v3/avatars/looks?ownership=private&limit=50';
  const publicLooksUrl = process.env.HEYGEN_AVATARS_URL || 'https://api.heygen.com/v3/avatars/looks?ownership=public&limit=50';
  const voicesUrl = process.env.HEYGEN_VOICES_URL || 'https://api.heygen.com/v2/voices';
  const settled = await Promise.allSettled([fetchPaginatedCollection(accountAvatarsUrl, key), fetchPaginatedCollection(publicLooksUrl, key), fetchCollection(voicesUrl, key)]);
  const accountAvatars = settled[0].status === 'fulfilled' ? settled[0].value.items : [];
  const publicLooks = settled[1].status === 'fulfilled' ? settled[1].value.items : [];
  const voices = settled[2].status === 'fulfilled' ? settled[2].value : [];
  const featuredAvatars = buildFeaturedAvatars(accountAvatars);
  const sharedAvatars = buildSharedAvatars(publicLooks);
  const normalizedVoices = buildVoices(voices);
  const labels = ['private_looks', 'public_looks', 'voices'];
  const failed = labels.filter((_, index) => settled[index].status === 'rejected');
  const failureReasons = Object.fromEntries(labels.flatMap((label, index) => settled[index].status === 'rejected' ? [[label, compact(settled[index].reason?.message, 240)]] : []));
  const featuredReady = featuredAvatars.filter((item) => item.providerReady).length;
  const connected = Boolean(sharedAvatars.length && normalizedVoices.length);
  return send(res, 200, {
    ok: true,
    talent: { source: failed.length ? 'heygen-partial' : 'heygen', avatars: [...featuredAvatars, ...sharedAvatars], voices: normalizedVoices },
    connection: {
      connected,
      status: failed.length ? 'degraded' : connected ? 'connected' : 'empty_inventory',
      failed,
      failureReasons,
      featuredReady,
      avatarCount: featuredAvatars.length + sharedAvatars.length,
      privateLookCount: accountAvatars.length,
      sharedAvatarCount: sharedAvatars.length,
      voiceCount: normalizedVoices.length,
      pagination: {
        privateLooksPages: settled[0].status === 'fulfilled' ? settled[0].value.pages : 0,
        publicLooksPages: settled[1].status === 'fulfilled' ? settled[1].value.pages : 0,
      },
    },
  });
}
