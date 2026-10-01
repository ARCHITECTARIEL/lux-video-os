import { FEATURED_CAST } from '../lib/video-os-featured-cast.js';
import { acceptedJobOutput } from '../lib/video-os-output-acceptance.js';
import { renderTierForJob } from '../lib/scripted-photo-contract.js';

const featuredByKey = new Map(FEATURED_CAST.map((item) => [item.key, item]));
const sharedTalentPattern = /^shared:(avatar|voice):([A-Za-z0-9_-]{32})$/;
const ownedAssetPattern = /^owned-asset:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const presentationMetadataKeys = new Set(['music', 'background', 'lut', 'cta', 'overlay']);

function safePresentationLabel(value, max = 180) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) return null;
  if (/(?:[a-z][a-z0-9+.-]*:\/\/|data:|blob:|javascript:|mailto:)/i.test(normalized)) return null;
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(normalized)) return null;
  if (/\b[A-Za-z0-9_-]{24,}\b/.test(normalized)) return null;
  if (/(?:provider|inventory|pagination|completeness|private[-_\s]?look|next[-_\s]?token|api[-_\s]?key|secret|credential)/i.test(normalized)) return null;
  if (/[^\p{L}\p{N}\s.,:;!?()'"&+\-_/@]/u.test(normalized)) return null;
  return normalized;
}

function verifiedOwnedAssetIds(values = []) {
  return new Set([...values].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function identityReference(value, kind) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const fields = kind === 'avatar' ? [value.avatarId, value.id] : [value.voiceId, value.id];
  const references = fields.filter((field) => typeof field === 'string' && field.trim()).map((field) => field.trim());
  if (!references.length || new Set(references).size !== 1) return '';
  return references[0];
}

export function sanitizePersistedIdentity(value, kind, options = {}) {
  if (!['avatar', 'voice'].includes(kind)) throw new TypeError('Identity kind must be avatar or voice.');
  const reference = identityReference(value, kind);
  if (!reference) return null;

  const featuredMatch = reference.match(kind === 'avatar'
    ? /^featured:([a-z0-9_-]+)$/
    : /^featured:([a-z0-9_-]+):voice$/);
  const featured = featuredMatch ? featuredByKey.get(featuredMatch[1]) : null;
  if (featured) {
    return {
      id: reference,
      [kind === 'avatar' ? 'avatarId' : 'voiceId']: reference,
      name: kind === 'avatar' ? featured.label : `${featured.label} voice`,
      source: 'featured',
    };
  }

  const sharedMatch = reference.match(sharedTalentPattern);
  if (sharedMatch?.[1] === kind) {
    const name = safePresentationLabel(value?.name) || (kind === 'avatar' ? 'Shared presenter' : 'Shared voice');
    return {
      id: reference,
      [kind === 'avatar' ? 'avatarId' : 'voiceId']: reference,
      name,
      source: 'heygen',
    };
  }

  const ownedMatch = reference.match(ownedAssetPattern);
  const approvedOwnedIds = verifiedOwnedAssetIds(options.ownedApplicationAssetIds);
  if (!ownedMatch || !approvedOwnedIds.has(ownedMatch[1].toLowerCase())) return null;
  const name = safePresentationLabel(value?.name) || (kind === 'avatar' ? 'Owned application asset' : 'Owned voice asset');
  return {
    id: reference,
    [kind === 'avatar' ? 'avatarId' : 'voiceId']: reference,
    name,
    source: 'owned-asset',
  };
}

export function sanitizePresentationMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const sanitized = {};
  for (const key of ['name', 'reason']) {
    const label = safePresentationLabel(value[key], key === 'reason' ? 240 : 180);
    if (label) sanitized[key] = label;
  }
  for (const key of presentationMetadataKeys) {
    const candidate = value[key];
    const label = safePresentationLabel(typeof candidate === 'string' ? candidate : candidate?.name);
    if (label) sanitized[key] = { name: label };
  }
  return sanitized;
}

function sanitizedFilename(value) {
  const name = safePresentationLabel(value, 180);
  if (!name || name.includes('/') || name.includes('\\')) return undefined;
  return name;
}

export function accountDto(record) {
  const role = record.user.role || 'customer';
  const subscriptions = {
    owner: { plan: 'Video OS Owner Access', status: 'active', renewal: 'Owner-managed workspace' },
    ceo: { plan: 'Video OS Lite CEO Preview', status: 'active', renewal: 'Full-access executive preview' },
    workspace: { plan: 'Video OS Lite Workspace Access', status: 'active', renewal: 'Password access enabled' },
    customer: { plan: 'Video OS', status: 'contained' },
  };
  return {
    accountId: record.user.id,
    account: { accountId: record.user.id, name: record.user.name, role, subscription: subscriptions[role] || subscriptions.customer },
    credits: { accountId: record.user.id, balance: record.credits.balance, reserved: record.credits.reserved, currency: 'credits' },
    entitlements: record.entitlements || {},
  };
}

export function projectDto(project, options = {}) {
  return {
    id: project.id,
    title: project.title,
    script: project.script,
    identityId: project.identityId || null,
    avatar: sanitizePersistedIdentity(project.avatar, 'avatar', options),
    voice: sanitizePersistedIdentity(project.voice, 'voice', options),
    settings: {},
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function jobDto(job, options = {}) {
  const output = job.output || {};
  const outputAccepted = acceptedJobOutput(job);
  const outputAvatar = sanitizePersistedIdentity(output.avatar, 'avatar', options);
  const inputAvatar = sanitizePersistedIdentity(job.input?.avatar, 'avatar', options);
  const outputVoice = sanitizePersistedIdentity(output.voice, 'voice', options);
  const inputVoice = sanitizePersistedIdentity(job.input?.voice, 'voice', options);
  return {
    id: job.id,
    correlationId: job.correlationId,
    provider: { id: job.provider, name: job.provider === 'heygen' ? 'HeyGen' : job.provider },
    tier: renderTierForJob(job, { unknownLegacy: 'null' }),
    outputAccepted,
    title: job.title,
    format: job.format,
    projectId: job.projectId,
    identityId: job.input?.identityId || null,
    avatar: outputAvatar || inputAvatar,
    voice: outputVoice || inputVoice,
    productionKit: sanitizePresentationMetadata(job.input?.productionKit),
    cost: job.costCredits,
    status: job.status,
    stage: job.status,
    filename: sanitizedFilename(output.filename),
    effects: sanitizePresentationMetadata(output.effects),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    message: job.videoDeletedAt ? 'This video is no longer available.' : outputAccepted ? 'Final MP4 ready.' : job.status === 'ready' ? 'Output acceptance pending.' : job.status === 'failed' ? 'Render needs attention.' : 'Render workflow is running.',
    url: outputAccepted && !job.videoDeletedAt ? `/api/video-os-lite/download?jobId=${encodeURIComponent(job.id)}` : null,
  };
}
