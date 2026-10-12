import { z } from 'zod';

export const LUXIFY_CONTRACT_VERSION = 'luxify-cinematic-v1';
export const LUXIFY_RENDER_MODE = 'luxify_cinematic_v1';
export const LUXIFY_PROVIDER_CAPABILITY = 'cinematic_avatar';

export const LUXIFY_TITLE_MAX_CHARS = 120;
export const LUXIFY_PROMPT_MAX_CHARS = 1_500;
export const LUXIFY_MIN_LOOKS = 1;
export const LUXIFY_MAX_LOOKS = 3;
export const LUXIFY_MIN_DURATION_SECONDS = 4;
export const LUXIFY_MAX_DURATION_SECONDS = 15;
export const LUXIFY_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
export const LUXIFY_RESOLUTIONS = Object.freeze(['720p', '1080p']);

const canonicalUuid = z.string().uuid().transform(value => value.toLowerCase());
const boundedText = maximum => z.string().trim().min(1).max(maximum);
const lookIdentityIds = z.array(canonicalUuid)
  .min(LUXIFY_MIN_LOOKS)
  .max(LUXIFY_MAX_LOOKS)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'LUXIFY look identities must be unique.' });
    }
  });

const intentFields = {
  contractVersion: z.literal(LUXIFY_CONTRACT_VERSION),
  projectId: canonicalUuid,
  idempotencyKey: canonicalUuid,
  title: boundedText(LUXIFY_TITLE_MAX_CHARS),
  prompt: boundedText(LUXIFY_PROMPT_MAX_CHARS),
  lookIdentityIds,
  aspectRatio: z.enum(LUXIFY_ASPECT_RATIOS),
  resolution: z.enum(LUXIFY_RESOLUTIONS),
  durationSeconds: z.number().int().min(LUXIFY_MIN_DURATION_SECONDS).max(LUXIFY_MAX_DURATION_SECONDS),
};

function immutableIntent(value) {
  return Object.freeze({ ...value, lookIdentityIds: Object.freeze([...value.lookIdentityIds]) });
}

export const luxifyIntentSchema = z.object(intentFields).strict().transform(immutableIntent);

export const luxifyRenderRequestSchema = z.object({
  ...intentFields,
  quoteToken: z.string().trim().min(40).max(8_192),
}).strict().transform(({ quoteToken, ...intent }) => Object.freeze({ ...immutableIntent(intent), quoteToken }));

export function canonicalizeLuxifyIntent(value) {
  return luxifyIntentSchema.parse(value);
}

export function canonicalizeLuxifyRenderRequest(value) {
  return luxifyRenderRequestSchema.parse(value);
}

export function isLuxifyRequest(value) {
  return value?.contractVersion === LUXIFY_CONTRACT_VERSION;
}

function normalizedMarker(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Jobs pass a provider option and require HeyGen. Projects intentionally omit
// it because their persisted settings do not contain a provider assignment.
export function classifyLuxifyMarker(value, options = {}) {
  const contractVersion = normalizedMarker(value?.contractVersion);
  const renderMode = normalizedMarker(value?.renderMode);
  const providerCapability = normalizedMarker(value?.providerCapability);
  const luxifyLike = contractVersion.startsWith('luxify')
    || renderMode.startsWith('luxify')
    || providerCapability.startsWith(LUXIFY_PROVIDER_CAPABILITY);
  if (!luxifyLike) return null;

  const exactMarkers = value?.contractVersion === LUXIFY_CONTRACT_VERSION
    && value?.renderMode === LUXIFY_RENDER_MODE
    && value?.providerCapability === LUXIFY_PROVIDER_CAPABILITY;
  const providerAccepted = !Object.hasOwn(options, 'provider') || options.provider === 'heygen';
  return exactMarkers && providerAccepted ? 'luxify' : 'unavailable';
}

export function luxifyFormatForAspectRatio(aspectRatio) {
  if (aspectRatio === '16:9') return 'landscape';
  if (aspectRatio === '9:16') return 'vertical';
  if (aspectRatio === '1:1') return 'square';
  throw new TypeError('Unsupported LUXIFY aspect ratio.');
}
