export const FEATURED_CAST = Object.freeze([
  Object.freeze({ key: 'ariel', label: 'Ariel' }),
  Object.freeze({ key: 'oso', label: 'OSO' }),
  Object.freeze({ key: 'kd', label: 'Kristian' }),
  // Multicultural Men
  Object.freeze({ key: 'marcus', label: 'Marcus' }),
  Object.freeze({ key: 'mateo', label: 'Mateo' }),
  Object.freeze({ key: 'kenji', label: 'Kenji' }),
  Object.freeze({ key: 'liam', label: 'Liam' }),
  // Multicultural Women
  Object.freeze({ key: 'maya', label: 'Maya' }),
  Object.freeze({ key: 'sofia', label: 'Sofia' }),
  Object.freeze({ key: 'hana', label: 'Hana' }),
  Object.freeze({ key: 'elena', label: 'Elena' }),
]);

export const FEATURED_CAST_METADATA = Object.freeze({
  ariel: Object.freeze({ gender: 'male', ethnicity: 'hispanic', role: 'Executive Anchor' }),
  oso: Object.freeze({ gender: 'male', ethnicity: 'multicultural', role: 'Brand Ambassador' }),
  kd: Object.freeze({ gender: 'male', ethnicity: 'caucasian', role: 'Executive Anchor' }),
  marcus: Object.freeze({ gender: 'male', ethnicity: 'black', role: 'Tech & Enterprise' }),
  mateo: Object.freeze({ gender: 'male', ethnicity: 'hispanic', role: 'Sales & Growth' }),
  kenji: Object.freeze({ gender: 'male', ethnicity: 'asian', role: 'Product & Strategy' }),
  liam: Object.freeze({ gender: 'male', ethnicity: 'caucasian', role: 'Creative Director' }),
  maya: Object.freeze({ gender: 'female', ethnicity: 'black', role: 'Executive Briefing' }),
  sofia: Object.freeze({ gender: 'female', ethnicity: 'hispanic', role: 'Brand & Outreach' }),
  hana: Object.freeze({ gender: 'female', ethnicity: 'asian', role: 'FinTech & Operations' }),
  elena: Object.freeze({ gender: 'female', ethnicity: 'caucasian', role: 'Client Success' }),
});

const featuredKeys = new Set(FEATURED_CAST.map((item) => item.key));
const featuredOrder = new Map(FEATURED_CAST.map((item, index) => [item.key, index]));
const normalizedId = (value) => String(value || '').trim();
const normalizedKey = (value) => String(value || '').trim().toLocaleLowerCase('en-US');
const normalizedName = (value) => String(value || '').trim().toLocaleLowerCase('en-US');

export function featuredCastEntry(item) {
  const key = normalizedKey(item?.featuredKey || item?.key);
  return FEATURED_CAST.find((entry) => entry.key === key) || null;
}

export function isFeaturedAvatar(item) {
  return featuredKeys.has(normalizedKey(item?.featuredKey));
}

export function matchedVoiceId(avatar) {
  return isFeaturedAvatar(avatar) ? normalizedId(avatar?.matchedVoiceId) || null : null;
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
  return isFeaturedAvatar(item) || item.shared === true;
}

export function curateDefaultCast(items = [], results = [], max = 20) {
  const limit = Math.max(0, Math.min(20, Number(max) || 20));
  const unique = new Map();
  for (const [providerOrder, item] of items.entries()) {
    if (!eligibleAvatar(item) || unique.has(item.id)) continue;
    unique.set(item.id, { ...item, providerOrder: Number.isInteger(item.providerOrder) ? item.providerOrder : providerOrder });
  }
  const usage = readyJobUsage(results);
  return [...unique.values()].sort((left, right) => {
    const leftKey = normalizedKey(left.featuredKey);
    const rightKey = normalizedKey(right.featuredKey);
    const leftFeatured = featuredOrder.has(leftKey);
    const rightFeatured = featuredOrder.has(rightKey);
    if (leftFeatured || rightFeatured) {
      if (leftFeatured !== rightFeatured) return leftFeatured ? -1 : 1;
      return featuredOrder.get(leftKey) - featuredOrder.get(rightKey);
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

export function prioritizeVoices(items = [], avatar) {
  const unique = new Map();
  for (const item of items) {
    if (!item || normalizedId(item.id) === '' || item.source !== 'heygen' || item.providerReady === false || item.archived === true || item.blocked === true) continue;
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  const matched = matchedVoiceId(avatar);
  return [...unique.values()].sort((left, right) => {
    if (matched && (left.id === matched || right.id === matched)) {
      if (left.id !== right.id) return left.id === matched ? -1 : 1;
    }
    const leftOrder = featuredOrder.get(normalizedKey(left.featuredKey));
    const rightOrder = featuredOrder.get(normalizedKey(right.featuredKey));
    const leftFeatured = Number.isInteger(leftOrder);
    const rightFeatured = Number.isInteger(rightOrder);
    if (leftFeatured !== rightFeatured) return leftFeatured ? -1 : 1;
    if (leftFeatured && rightFeatured) return leftOrder - rightOrder;
    const nameOrder = normalizedName(left.name).localeCompare(normalizedName(right.name), 'en-US');
    return nameOrder || left.id.localeCompare(right.id, 'en-US');
  });
}
