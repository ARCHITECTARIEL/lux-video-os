// Brief schema for the local Luxify pipeline (tools/luxify-local.mjs).
// Asset references are bare file names resolved under the assets root
// (default %USERPROFILE%\lux-assets, or LUX_ASSETS_DIR / --assets); see docs/LUX-ASSETS.md.
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
// Pre-rendered local clips (no Runway call). `heygen_avatar` is a HeyGen
// avatar render already on disk (driven by a slice of the master voice);
// `local_clip` reuses an already-paid clip. Both are muted in the final mix:
// the single master voice track is the only voice audio.
export const CLIP_SHOT_MODELS = Object.freeze(['heygen_avatar', 'local_clip']);
// HeyGen digital-twin cost per second, used for the plan estimate, the $1/clip
// cap and the cumulative $10 ledger. QA L2: the list price (0.0667 $/s) let a
// 15 s shot round to exactly $1.00, so the cap never fired. This is the rate
// measured on the 2026-11-02 Kristian test (wallet delta $0.59 for 7.18 s incl.
// the TTS line), rounded up: the per-clip cap now binds at 13 s.
export const HEYGEN_AVATAR_USD_PER_SECOND = 0.083;
export const THEMES = Object.freeze(['dark', 'light']);
export const CAPTION_STYLES = Object.freeze(['none', 'kinetic', 'subtitle', 'both', 'cards']);
// D1: mandatory, cannot be disabled from a brief.
export const AI_DISCLOSURE_TEXT = 'AI-generated video and voice';
// QA M4: avatar shots need a local consent record (see docs/LUX-ASSETS.md).
export const AVATAR_CONSENT_VERSION = 'lux-avatar-consent/v1';
export const AVATAR_CONSENT_SCOPES = Object.freeze(['ai_avatar_video', 'ai_voice']);
export const ASPECTS = Object.freeze({ '16:9': { ratio: '1280:720', width: 1280, height: 720 }, '9:16': { ratio: '720:1280', width: 720, height: 1280 } });

const assetName = ext => z.string().min(1).max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, 'must be a bare file name (no folders)')
  .refine(value => ext.some(e => value.toLowerCase().endsWith(e)), `must end with ${ext.join(' or ')}`);
const localPath = z.string().min(1).max(500)
  .refine(value => !/^[a-z]+:\/\//i.test(value), 'must be a local file path, not a URL')
  // QA L3: //host/share and \\host\share are UNC paths on Windows (SMB access).
  .refine(value => !/^[\\/]{2}/.test(value), 'network (UNC or //host) paths are not allowed')
  // QA r2 Low: `C:file.png` is relative to the drive's current directory.
  .refine(value => !/^[A-Za-z]:(?![\\/])/.test(value), 'drive-relative paths (C:file) are not allowed');
const shortText = max => z.string().min(1).max(max).refine(value => !/[\u0000-\u001f]/.test(value), 'control characters are not allowed');
const text = z.string().min(1).max(120).refine(value => !/[\u0000-\u001f]/.test(value), 'control characters are not allowed');

const titleList = z.array(z.object({
    kind: z.enum(['banner', 'lower_third']),
    text,
    subtext: text.optional(),
    start: z.number().min(0),
    end: z.number().positive(),
  }).strict().refine(t => t.end > t.start, 'title end must be after start')).max(4).default([]);

const clipShot = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  model: z.enum(CLIP_SHOT_MODELS),
  // Local mp4/mov inside the brief folder or the assets root.
  clip: localPath.refine(v => /\.(mp4|mov)$/i.test(v), 'clip must be an .mp4 or .mov file'),
  duration: z.number().min(1).max(15),
  // Seconds into `clip` to start from (e.g. reuse part of a paid Runway clip).
  clipStart: z.number().min(0).max(60).default(0),
  titles: titleList,
}).strict();

const runwayShot = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  model: z.enum(['runway', 'seedance']),
  prompt: z.string().min(1).max(1000),
  duration: z.number().int(),
  // Local png/jpeg/webp file inside the brief folder or the assets root (QA M3).
  promptImage: localPath.optional(),
  seed: z.number().int().min(0).max(4294967295).optional(),
  titles: titleList,
}).strict();

export const briefSchema = z.object({
  version: z.literal(BRIEF_VERSION),
  slug: z.string().regex(/^[a-z0-9-]{1,60}$/),
  title: text,
  aspect: z.enum(Object.keys(ASPECTS)),
  script: z.string().min(1).max(10000),
  shots: z.array(z.union([runwayShot, clipShot])).min(1).max(20),
  transitions: z.array(z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0.2).max(1.5) }).strict()).default([]),
  fontPreset: z.enum(Object.keys(FONT_PRESETS)),
  lut: assetName(['.cube']).nullable().default(null),
  // 1 = the LUT as authored; >1 exaggerates its offset from identity (1104).
  lutStrength: z.number().min(0).max(3).default(1),
  music: z.object({ track: assetName(['.mp3', '.wav', '.m4a']), volume: z.number().min(0).max(1).default(0.35) }).strict().nullable().default(null),
  logoOverlay: assetName(['.png']).nullable().default(null),
  voice: z.discriminatedUnion('source', [
    z.object({ source: z.literal('heygen_audio_file'), path: localPath }).strict(),
    z.object({ source: z.literal('heygen_job'), jobId: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/), path: localPath }).strict(),
  ]),
  loudnessLufs: z.number().min(-24).max(-10).default(-14),
  // ---- v1 optional additions (SPEC-THEME-CAPTIONS-1102; D11: stays v1) ----
  theme: z.enum(THEMES).default('dark'),
  captionStyle: z.enum(CAPTION_STYLES).default('none'),
  // Kinetic marketing lines at absolute video time (D5: no word timings, so
  // the brief supplies the beats). Max 3 words per line is advisory (warning).
  captions: z.array(z.object({ text: shortText(40), start: z.number().min(0), end: z.number().positive() }).strict()
    .refine(c => c.end > c.start, 'caption end must be after start')
    .refine(c => c.end - c.start <= 4, 'caption beats are at most 4 s')).max(40).default([]),
  bug: z.object({ enabled: z.boolean().default(true), opacity: z.number().min(0.4).max(1).default(0.85) }).strict().prefault({}),
  endCard: z.object({
    enabled: z.boolean().default(false),
    duration: z.number().min(2).max(6).default(3),
    cta: shortText(40).optional(),
    url: z.string().max(60).regex(/^[a-z0-9.-]+\.[a-z]{2,}(\/[\w\-./]*)?$/i, 'display URL without a scheme').optional(),
  }).strict().prefault({}),
  // QA M4: required when any heygen_avatar shot is present (checked below and
  // again at run time against the record file itself; fails closed).
  avatarConsent: z.object({ record: localPath.refine(v => /\.json$/i.test(v), 'consent record must be a .json file') }).strict().optional(),
  subtitles: z.object({ burnIn: z.boolean().optional(), sidecar: z.boolean().default(true) }).strict().prefault({}),
}).strict().superRefine((brief, ctx) => {
  if (brief.transitions.length && brief.transitions.length !== brief.shots.length - 1) {
    ctx.addIssue({ code: 'custom', path: ['transitions'], message: 'need exactly one transition per gap between shots (or none)' });
  }
  if (brief.shots.some(s => s.model === 'heygen_avatar') && !brief.avatarConsent) {
    ctx.addIssue({ code: 'custom', path: ['avatarConsent'], message: 'heygen_avatar shots need avatarConsent.record (a local consent record file)' });
  }
  const ids = new Set();
  brief.shots.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: ['shots', i, 'id'], message: 'duplicate shot id' });
    ids.add(s.id);
    const spec = RUNWAY_MODELS[SHOT_MODELS[s.model]];
    if (spec && (s.duration < spec.minDuration || s.duration > spec.maxDuration)) {
      ctx.addIssue({ code: 'custom', path: ['shots', i, 'duration'], message: `${s.model} duration must be ${spec.minDuration}-${spec.maxDuration}s` });
    }
    s.titles.forEach((t, j) => { if (t.end > s.duration) ctx.addIssue({ code: 'custom', path: ['shots', i, 'titles', j, 'end'], message: 'title ends after the shot' }); });
    const next = brief.shots[i + 1] ? brief.transitions[i] : undefined;
    if (next && (next.duration >= s.duration || next.duration >= brief.shots[i + 1].duration)) {
      ctx.addIssue({ code: 'custom', path: ['transitions', i, 'duration'], message: 'transition must be shorter than both shots' });
    }
  });
  const content = brief.shots.reduce((a, s) => a + s.duration, 0) - brief.transitions.reduce((a, t) => a + t.duration, 0);
  brief.captions.forEach((c, i) => {
    if (c.end > content + 1e-6) ctx.addIssue({ code: 'custom', path: ['captions', i, 'end'], message: 'caption ends after the content (before any end card)' });
    const prev = brief.captions[i - 1];
    if (prev && c.start < prev.end) ctx.addIssue({ code: 'custom', path: ['captions', i, 'start'], message: 'captions must be in order and not overlap' });
  });
});

// Consent record file (QA M4). Dates are ISO dates or timestamps.
const isoDate = z.string().max(40).refine(v => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)), 'must be an ISO date');
export const avatarConsentSchema = z.object({
  version: z.literal(AVATAR_CONSENT_VERSION),
  subject: shortText(80),
  avatarIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{6,80}$/)).max(20).optional(),
  consentedAt: isoDate,
  expiresAt: isoDate.optional(),
  method: z.enum(['recorded_verbal', 'written', 'signed_form']),
  scope: z.array(z.enum(AVATAR_CONSENT_SCOPES)).min(1).max(AVATAR_CONSENT_SCOPES.length),
  recordedBy: shortText(80),
  // Bare file name of the evidence (recording/form), kept with the record; not read here.
  evidence: assetName(['.mp4', '.mov', '.m4a', '.wav', '.mp3', '.pdf', '.png', '.jpg']).optional(),
  withdrawn: z.literal(false).optional(),
}).strict();

export function parseAvatarConsent(value, { now = Date.now() } = {}) {
  const result = avatarConsentSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw Object.assign(new Error(`Invalid avatar consent record:\n- ${issues.join('\n- ')}`), { code: 'AVATAR_CONSENT_INVALID', issues });
  }
  const r = result.data;
  const missing = AVATAR_CONSENT_SCOPES.filter(s => !r.scope.includes(s));
  if (missing.length) throw Object.assign(new Error(`Avatar consent record does not cover: ${missing.join(', ')}`), { code: 'AVATAR_CONSENT_INVALID' });
  if (Date.parse(r.consentedAt) > now) throw Object.assign(new Error('Avatar consent record is dated in the future.'), { code: 'AVATAR_CONSENT_INVALID' });
  if (r.expiresAt && Date.parse(r.expiresAt) <= now) throw Object.assign(new Error('Avatar consent record has expired.'), { code: 'AVATAR_CONSENT_EXPIRED' });
  return r;
}

export function parseBrief(value) {
  const result = briefSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw Object.assign(new Error(`Invalid brief:\n- ${issues.join('\n- ')}`), { code: 'BRIEF_INVALID', issues });
  }
  return result.data;
}
