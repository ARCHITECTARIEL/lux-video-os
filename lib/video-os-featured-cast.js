export const FEATURED_CAST = Object.freeze([
  Object.freeze({ key: 'ariel', label: 'Ariel', avatarId: 'ddd0cccc81334e50b493a12c34fb47b1', voiceId: 'ae2cee128a094fb4b9ea3f669ee46099' }),
  Object.freeze({ key: 'oso', label: 'OSO', avatarId: 'e8083119a1024dd0814b6ba7e9addfc4', voiceId: 'b874056efca4441aaa8befa518076eee' }),
  Object.freeze({ key: 'kd', label: 'KD', avatarId: '880ad1223ca84f9590f21a0df4bf66b2', voiceId: 'ef08711aa68b400ba0213075e8d0b421' }),
]);

const featuredAvatarIds = new Set(FEATURED_CAST.map((item) => item.avatarId));
const featuredVoiceIds = new Set(FEATURED_CAST.map((item) => item.voiceId));

const normalizedId = (value) => String(value || '').trim();
const normalizedName = (value) => String(value || '').trim().toLocaleLowerCase('en-US');

export function featuredCastEntry(avatarId) {
  return FEATURED_CAST.find((item) => item.avatarId === normalizedId(avatarId)) || null;
}

export function isFeaturedAvatarId(avatarId) {
  return featuredAvatarIds.has(normalizedId(avatarId));
}

export function matchedVoiceId(avatarId) {
  return featuredCastEntry(avatarId)?.voiceId || null;
}

export function readyJobUsage(results = []) {
  const usage = new Map();
  for (const result of results) {
    if (result?.status !== 'ready') continue;
    const avatarId = normalizedId(result?.avatar?.avatarId || result?.avatar?.id);
    if (!avatarId) continue;
    const current = usage.get(avatarId) || { count: 0, latest: 0 };
    const timestamp = Date.parse(result.updatedAt || result.createdAt || 0) || 0;
    usage.set(avatarId, { count: current.count + 1, latest: Math.max(current.latest, timestamp) });
  }
  return usage;
}

function eligibleAvatar(item) {
  if (!item || normalizedId(item.id) === '' || item.source !== 'heygen') return false;
  if (item.providerReady !== true || item.active !== true || item.archived === true || item.blocked === true) return false;
  if (!item.previewUrl || !/^https:\/\//i.test(item.previewUrl)) return false;
  return isFeaturedAvatarId(item.id) || item.shared === true;
}

export function curateDefaultCast(items = [], results = [], max = 20) {
  const limit = Math.max(0, Math.min(20, Number(max) || 20));
  const unique = new Map();
  for (const [providerOrder, item] of items.entries()) {
    if (!eligibleAvatar(item) || unique.has(item.id)) continue;
    unique.set(item.id, { ...item, providerOrder: Number.isInteger(item.providerOrder) ? item.providerOrder : providerOrder });
  }
  const usage = readyJobUsage(results);
  const featuredOrder = new Map(FEATURED_CAST.map((item, index) => [item.avatarId, index]));
  return [...unique.values()].sort((left, right) => {
    const leftFeatured = featuredOrder.has(left.id);
    const rightFeatured = featuredOrder.has(right.id);
    if (leftFeatured || rightFeatured) {
      if (leftFeatured !== rightFeatured) return leftFeatured ? -1 : 1;
      return featuredOrder.get(left.id) - featuredOrder.get(right.id);
    }
    const leftUsage = usage.get(left.id) || { count: 0, latest: 0 };
    const rightUsage = usage.get(right.id) || { count: 0, latest: 0 };
    if (leftUsage.count !== rightUsage.count) return rightUsage.count - leftUsage.count;
    if (leftUsage.latest !== rightUsage.latest) return rightUsage.latest - leftUsage.latest;
    if (left.providerOrder !== right.providerOrder) return left.providerOrder - right.providerOrder;
    const nameOrder = normalizedName(left.name).localeCompare(normalizedName(right.name), 'en-US');
    return nameOrder || left.id.localeCompare(right.id, 'en-US');
  }).slice(0, limit);
}

export function prioritizeVoices(items = [], avatarId) {
  const unique = new Map();
  for (const item of items) {
    if (!item || normalizedId(item.id) === '' || item.source !== 'heygen' || item.providerReady === false || item.archived === true || item.blocked === true) continue;
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  const matched = matchedVoiceId(avatarId);
  const featuredOrder = new Map(FEATURED_CAST.map((item, index) => [item.voiceId, index]));
  return [...unique.values()].sort((left, right) => {
    if (matched && (left.id === matched || right.id === matched)) {
      if (left.id !== right.id) return left.id === matched ? -1 : 1;
    }
    const leftFeatured = featuredVoiceIds.has(left.id);
    const rightFeatured = featuredVoiceIds.has(right.id);
    if (leftFeatured !== rightFeatured) return leftFeatured ? -1 : 1;
    if (leftFeatured && rightFeatured) return featuredOrder.get(left.id) - featuredOrder.get(right.id);
    const nameOrder = normalizedName(left.name).localeCompare(normalizedName(right.name), 'en-US');
    return nameOrder || left.id.localeCompare(right.id, 'en-US');
  });
}

function resolveFeaturedId(value, kind) {
  const normalized = normalizedId(value);
  if (!normalized.startsWith('featured:')) return normalized;
  const match = normalized.match(/^featured:([a-z0-9_-]+)(:voice)?$/);
  if (!match || (kind === 'voice') !== Boolean(match[2])) {
    throw Object.assign(new Error('Featured presenter mapping is invalid.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  }
  const featured = FEATURED_CAST.find((item) => item.key === match[1]);
  if (!featured) throw Object.assign(new Error('Featured presenter is unavailable.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  return kind === 'voice' ? featured.voiceId : featured.avatarId;
}

export function resolveFeaturedProviderSelections(payload) {
  return {
    ...payload,
    avatar: { ...payload.avatar, avatarId: resolveFeaturedId(payload.avatar?.avatarId, 'avatar') },
    voice: { ...payload.voice, voiceId: resolveFeaturedId(payload.voice?.voiceId, 'voice') },
  };
}
