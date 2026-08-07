import { z } from 'zod';

const safeText = (max) => z.string().trim().min(1).max(max);

export const renderRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
  provider: z.literal('heygen').default('heygen'),
  title: safeText(120),
  format: z.enum(['vertical', 'landscape', 'square']).default('vertical'),
  script: safeText(4000),
  avatar: z.object({ avatarId: safeText(160) }).passthrough().optional(),
  voice: z.object({ voiceId: safeText(160), locale: z.string().trim().max(40).optional() }).passthrough().optional(),
  identityId: z.string().uuid().optional(),
  productionKit: z.record(z.string(), z.unknown()).default({}),
  projectId: z.string().uuid(),
}).strict().superRefine((value, context) => {
  if (!value.identityId && (!value.avatar || !value.voice)) context.addIssue({ code: 'custom', path: ['identityId'], message: 'Choose an authorized identity or an avatar and voice.' });
});

export const projectRequestSchema = z.object({
  id: z.string().uuid().optional(),
  title: safeText(120),
  script: safeText(4000),
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
