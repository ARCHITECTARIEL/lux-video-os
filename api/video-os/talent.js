import { z } from 'zod';

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

function normalize(item, prefix) {
  const id = compact(item.id || item.avatar_id || item.voice_id || item.avatarId || item.voiceId || `${prefix}-unknown`);
  const previewUrl = compact(item.preview_image_url || item.preview_url || item.image_url || item.thumbnail_url, 500);
  return { id, name: compact(item.name || item.avatar_name || item.voice_name || item.display_name || item.displayName || id, 180), source: compact(item.source || 'heygen', 80), style: compact(item.style || item.gender || item.language || item.locale || 'available', 120), role: compact(item.type || item.category || 'Ready to render', 120), ...(previewUrl ? { previewUrl } : {}) };
}

const unique = (items) => [...new Map(items.filter((item) => item.id).map((item) => [item.id, item])).values()];

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for talent.' });
  const key = String(process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || '').trim();
  if (!key) return send(res, 200, { ok: true, talent: { source: 'missing-key', avatars: [], voices: [] }, connection: { connected: false, status: 'missing_key', missing: ['HEYGEN_API_KEY'] } });
  const avatarsUrl = process.env.HEYGEN_AVATARS_URL || 'https://api.heygen.com/v3/avatars/looks?ownership=public&limit=50';
  const voicesUrl = process.env.HEYGEN_VOICES_URL || 'https://api.heygen.com/v2/voices';
  const settled = await Promise.allSettled([fetchCollection(avatarsUrl, key), fetchCollection(voicesUrl, key)]);
  const avatars = unique((settled[0].status === 'fulfilled' ? settled[0].value : []).filter((item) => Array.isArray(item.supported_api_engines) && item.supported_api_engines.includes('avatar_iv')).map((item) => normalize(item, 'avatar')));
  const voices = unique((settled[1].status === 'fulfilled' ? settled[1].value : []).map((item) => normalize(item, 'voice')));
  const failed = ['avatars', 'voices'].filter((_, index) => settled[index].status === 'rejected');
  return send(res, 200, { ok: true, talent: { source: failed.length ? 'heygen-partial' : 'heygen', avatars, voices }, connection: { connected: Boolean(avatars.length && voices.length), status: failed.length ? 'degraded' : avatars.length && voices.length ? 'connected' : 'empty_inventory', failed, avatarCount: avatars.length, voiceCount: voices.length } });
}
