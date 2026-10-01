import { z } from 'zod';
import { SCRIPTED_PHOTO_CONTRACT_VERSION } from './scripted-photo-contract.js';

const safeText = (max) => z.string().trim().min(1).max(max);

// Bounds real per-render HeyGen cost exposure -- at ~900 characters (roughly
// 70 seconds of spoken script), the worst case stays close to a typical
// render's cost instead of a single long script costing 10x+ more than the
// flat credit charge covers. See the unit-economics pricing model.
export const PREMIUM_SCRIPT_MAX_CHARS = 900;

export const renderRequestSchema = z.object({
  tier: z.literal('PREMIUM').optional(),
  idempotencyKey: z.string().uuid(),
  provider: z.literal('heygen').default('heygen'),
  title: safeText(120),
  format: z.enum(['vertical', 'landscape', 'square']).default('vertical'),
  script: safeText(PREMIUM_SCRIPT_MAX_CHARS),
  avatar: z.object({ avatarId: safeText(160) }).passthrough().optional(),
  voice: z.object({ voiceId: safeText(160), locale: z.string().trim().max(40).optional() }).passthrough().optional(),
  identityId: z.string().uuid().optional(),
  productionKit: z.record(z.string(), z.unknown()).default({}),
  projectId: z.string().uuid(),
}).strict().superRefine((value, context) => {
  if (!value.identityId && (!value.avatar || !value.voice)) context.addIssue({ code: 'custom', path: ['identityId'], message: 'Choose an authorized identity or an avatar and voice.' });
}).transform(({ tier: _tier, ...canonicalPayload }) => canonicalPayload);

export const scriptedPhotoRenderRequestSchema = z.object({
  contractVersion: z.literal(SCRIPTED_PHOTO_CONTRACT_VERSION),
  tier: z.enum(['STANDARD', 'PREMIUM']),
  projectId: z.string().uuid(),
  identityId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  quoteToken: safeText(8192),
  title: safeText(120),
  script: safeText(PREMIUM_SCRIPT_MAX_CHARS),
  format: z.enum(['vertical', 'landscape', 'square']),
}).strict();

export const scriptedPhotoSaveProjectRequestSchema = z.object({
  action: z.literal('save-project'),
  contractVersion: z.literal(SCRIPTED_PHOTO_CONTRACT_VERSION),
  projectId: z.string().uuid(),
  tier: z.enum(['STANDARD', 'PREMIUM']),
  title: safeText(120),
  script: safeText(PREMIUM_SCRIPT_MAX_CHARS),
  identityId: z.string().uuid(),
  format: z.enum(['vertical', 'landscape', 'square']),
}).strict();

export const scriptedPhotoQuoteRequestSchema = z.object({
  action: z.literal('quote'),
  projectId: z.string().uuid(),
  tier: z.enum(['STANDARD', 'PREMIUM']),
  format: z.enum(['vertical', 'landscape', 'square']),
  idempotencyKey: z.string().uuid(),
}).strict();

export const projectRequestSchema = z.object({
  id: z.string().uuid().optional(),
  title: safeText(120),
  script: safeText(PREMIUM_SCRIPT_MAX_CHARS),
  identityId: z.string().uuid().optional(),
  avatar: z.object({ id: safeText(160), name: z.string().trim().max(180).optional(), source: z.string().trim().max(80).optional() }).strict(),
  voice: z.object({ id: safeText(160), name: z.string().trim().max(180).optional(), source: z.string().trim().max(80).optional() }).strict(),
  settings: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const providerSubmitSchema = z.object({
  data: z.object({ video_id: safeText(200).optional(), id: safeText(200).optional(), job_id: safeText(200).optional() }).passthrough().optional(),
  video_id: safeText(200).optional(),
  id: safeText(200).optional(),
  job_id: safeText(200).optional(),
}).passthrough().refine((value) => Boolean(value.data?.video_id || value.data?.id || value.data?.job_id || value.video_id || value.id || value.job_id), 'Provider response did not contain a job id.');

export const providerStatusSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const finishRequestSchema = z.object({ jobId: safeText(100) }).strict();

// Standard (SadTalker Stage A) project: portrait/identity + uploaded narration
// audio, no script/avatar/voice -- deliberately a separate strict schema from
// projectRequestSchema rather than a loosening of it (see DESIGN.md's "Material
// frontend contract gaps").
export const standardProjectRequestSchema = z.object({
  id: z.string().uuid().optional(),
  tier: z.literal('STANDARD'),
  contractVersion: z.literal('standard-narration-v1'),
  title: safeText(120),
  identityId: z.string().uuid(),
  narrationAudioAssetId: z.string().uuid(),
}).strict();

const sadtalkerStageAAssetSchema = z.object({
  assetId: z.string().uuid(),
  accountId: safeText(100),
  consentId: z.string().uuid(),
  signatureVerified: z.literal(true),
  privateSource: z.literal(true),
  mimeType: safeText(80),
  bytes: z.number().int().positive(),
});

export const sadtalkerStageAInputSchema = z.object({
  jobId: safeText(100),
  accountId: safeText(100),
  correlationId: safeText(100),
  portrait: sadtalkerStageAAssetSchema.extend({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  drivenAudio: sadtalkerStageAAssetSchema.extend({ durationMs: z.number().int().positive() }).strict(),
}).strict();

export function parseSadtalkerStageAInput(value) {
  return parseOrThrow(sadtalkerStageAInputSchema, value, 'SadTalker Stage A input validation failed.');
}

export const stripeCheckoutSessionSchema = z.object({
  id: safeText(255),
  client_reference_id: safeText(100).nullable().optional(),
  payment_status: z.literal('paid'),
  metadata: z.object({ accountId: safeText(100), packageId: z.enum(['credits_500', 'credits_1000', 'credits_2000']), policyVersion: z.literal('2026-07-p0') }).strict(),
}).passthrough();

export function parseOrThrow(schema, value, message = 'Request validation failed.') {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error(message), { statusCode: 400, failureCategory: 'VALIDATION', issues: parsed.error.issues.map(({ path, message: issue }) => ({ path: path.join('.'), message: issue })) });
  return parsed.data;
}
