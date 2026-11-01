// Brief schema for the local Luxify pipeline (tools/luxify-local.mjs).
// Asset references are bare file names resolved under the assets root
// (default C:\Users\ariel\lux-assets on Windows); see docs/LUX-ASSETS.md.
import { z } from 'zod';

import { RUNWAY_MODELS } from '../services/runway-models.js';

export const BRIEF_VERSION = 'luxify-local/v1';
export const CLIP_CAP_USD = 1;
export const VIDEO_CAP_USD = 10;

// Brief `model` values map to doc-confirmed Runway model ids.
export const SHOT_MODELS = Object.freeze({ runway: 'gen4.5', seedance: 'seedance2_fast' });
export const FONT_PRESETS = Object.freeze({
  'lux-sans': 'lux-sans.ttf',
  'lux-sans-bold': 'lux-sans-bold.ttf',
  'lux-serif': 'lux-serif.ttf',
});
export const TRANSITIONS = Object.freeze(['fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'smoothleft', 'smoothright', 'circleopen', 'circleclose']);
export const ASPECTS = Object.freeze({ '16:9': { ratio: '1280:720', width: 1280, height: 720 }, '9:16': { ratio: '720:1280', width: 720, height: 1280 } });

const assetName = ext => z.string().min(1).max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, 'must be a bare file name (no folders)')
  .refine(value => ext.some(e => value.toLowerCase().endsWith(e)), `must end with ${ext.join(' or ')}`);
const localPath = z.string().min(1).max(500).refine(value => !/^[a-z]+:\/\//i.test(value), 'must be a local file path, not a URL');
const text = z.string().min(1).max(120).refine(value => !/[\u0000-\u001f]/.test(value), 'control characters are not allowed');

const shot = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  model: z.enum(['runway', 'seedance']),
  prompt: z.string().min(1).max(1000),
  duration: z.number().int(),
  // Local png/jpeg/webp file inside the brief folder or the assets root (QA M3).
  promptImage: localPath.optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  titles: z.array(z.object({
    kind: z.enum(['banner', 'lower_third']),
    text,
    subtext: text.optional(),
    start: z.number().min(0),
    end: z.number().positive(),
  }).strict().refine(t => t.end > t.start, 'title end must be after start')).max(4).default([]),
}).strict();

export const briefSchema = z.object({
  version: z.literal(BRIEF_VERSION),
  slug: z.string().regex(/^[a-z0-9-]{1,60}$/),
  title: text,
  aspect: z.enum(Object.keys(ASPECTS)),
  script: z.string().min(1).max(10000),
  shots: z.array(shot).min(1).max(20),
  transitions: z.array(z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0.2).max(1.5) }).strict()).default([]),
  fontPreset: z.enum(Object.keys(FONT_PRESETS)),
  lut: assetName(['.cube']).nullable().default(null),
  music: z.object({ track: assetName(['.mp3', '.wav', '.m4a']), volume: z.number().min(0).max(1).default(0.35) }).strict().nullable().default(null),
  logoOverlay: assetName(['.png']).nullable().default(null),
  voice: z.discriminatedUnion('source', [
    z.object({ source: z.literal('heygen_audio_file'), path: localPath }).strict(),
    z.object({ source: z.literal('heygen_job'), jobId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/), path: localPath }).strict(),
  ]),
  loudnessLufs: z.number().min(-24).max(-10).default(-14),
}).strict().superRefine((brief, ctx) => {
  if (brief.transitions.length && brief.transitions.length !== brief.shots.length - 1) {
    ctx.addIssue({ code: 'custom', path: ['transitions'], message: 'need exactly one transition per gap between shots (or none)' });
  }
  const ids = new Set();
  brief.shots.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: ['shots', i, 'id'], message: 'duplicate shot id' });
    ids.add(s.id);
    const spec = RUNWAY_MODELS[SHOT_MODELS[s.model]];
    if (s.duration < spec.minDuration || s.duration > spec.maxDuration) {
      ctx.addIssue({ code: 'custom', path: ['shots', i, 'duration'], message: `${s.model} duration must be ${spec.minDuration}-${spec.maxDuration}s` });
    }
    s.titles.forEach((t, j) => { if (t.end > s.duration) ctx.addIssue({ code: 'custom', path: ['shots', i, 'titles', j, 'end'], message: 'title ends after the shot' }); });
    const next = brief.shots[i + 1] ? brief.transitions[i] : undefined;
    if (next && (next.duration >= s.duration || next.duration >= brief.shots[i + 1].duration)) {
      ctx.addIssue({ code: 'custom', path: ['transitions', i, 'duration'], message: 'transition must be shorter than both shots' });
    }
  });
});

export function parseBrief(value) {
  const result = briefSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw Object.assign(new Error(`Invalid brief:\n- ${issues.join('\n- ')}`), { code: 'BRIEF_INVALID', issues });
  }
  return result.data;
}
