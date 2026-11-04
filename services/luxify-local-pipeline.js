// Local Luxify pipeline: Runway clips (via services/runway-models.js) ->
// cinematic grade from services/media-finisher.js (LUT) -> drawtext titles ->
// xfade transitions -> music ducked under the HeyGen voice -> loudnorm ->
// themed captions / disclosure / bug / end card -> final.mp4 + VTT/SRT +
// receipt.json. Makes no HeyGen calls (heygen_avatar shots are local files). Runway is only contacted
// in live mode, which the CLI gates behind --live plus RUNWAYML_API_SECRET.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, existsSync } from 'node:fs';
import { access, copyFile, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { AI_DISCLOSURE_TEXT, ASPECTS, CLIP_CAP_USD, parseAvatarConsent, CLIP_SHOT_MODELS, FONT_PRESETS, HEYGEN_AVATAR_USD_PER_SECOND, SHOT_MODELS, VIDEO_CAP_USD } from '../lib/luxify-local-brief.js';
import { buildCues, bugFilter, cardsAss, subtitleMaxChars, subtitleTop, scaleCube, disclosureFilters, endCardGraph, kineticFilters, kineticFitWarnings, kineticWarnings, subtitleFilters, themeTokens, toSrt, toVtt, wavDurationSeconds } from './luxify-local-overlays.js';
import { cinematicFinishingFilterGraph } from './media-finisher.js';
import { RUNWAY_MAX_DATA_URI_BYTES, RUNWAY_USD_PER_CREDIT, awaitRunwayTask, buildRunwayRequest, createRunwayTask, imageFileToDataUri, resumeRunwayTask } from './runway-models.js';

export const REQUIRED_FILTERS = Object.freeze(['drawtext', 'xfade', 'sidechaincompress', 'loudnorm', 'lut3d', 'overlay']);
const CLIP_CAP_CREDITS = Math.round(CLIP_CAP_USD / RUNWAY_USD_PER_CREDIT);
const VIDEO_CAP_CREDITS = Math.round(VIDEO_CAP_USD / RUNWAY_USD_PER_CREDIT);
const FPS = 30;
// Size caps (QA L3). Local inputs larger than these are refused before ffmpeg.
export const MAX_CLIP_BYTES = 1024 * 1024 * 1024;
export const MAX_VOICE_BYTES = 200 * 1024 * 1024;
export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
export const MAX_LOGO_PIXELS = 4096;
export const MAX_CONSENT_BYTES = 64 * 1024;
// QA L4/L5: caps for the other owner assets (checked with realpath containment).
export const MAX_LUT_BYTES = 10 * 1024 * 1024;
export const MAX_FONT_BYTES = 20 * 1024 * 1024;
export const MAX_MUSIC_BYTES = 50 * 1024 * 1024;
// QA M1: every ffmpeg call is killed after this long (overridable per call).
export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 1x1 png used only to validate i2v shots while planning; the real image is
// loaded from disk (loadShotImage) right before submit.
const PLAN_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' ? false : !rel.startsWith('..') && !isAbsolute(rel);
}

async function realRoots(...dirs) {
  const roots = [];
  for (const root of dirs) { if (!root) continue; try { roots.push(await realpath(root)); } catch { /* missing root */ } }
  return roots;
}

// QA M3: only local files inside the brief folder or the owner's assets root.
export async function loadShotImage(path, { briefDir, assetsRoot }) {
  const roots = await realRoots(briefDir, assetsRoot);
  let real;
  try { real = await realpath(resolve(briefDir, path)); } catch { throw fail(`Shot image not found: ${basename(path)}`, 'IMAGE_NOT_FOUND'); }
  if (!roots.some(root => inside(root, real))) throw fail('Shot image must be inside the brief folder or the assets folder.', 'IMAGE_OUTSIDE_ROOTS');
  // QA L4: check the size before reading. Base64 grows 4/3, so anything above
  // 3/4 of the data-URI cap can never pass.
  const info = await stat(real);
  if (!info.isFile() || info.size > Math.floor(RUNWAY_MAX_DATA_URI_BYTES * 3 / 4)) throw fail('Shot image must be a png/jpeg/webp file of at most ~3.75 MB.', 'RUNWAY_IMAGE_INVALID');
  return imageFileToDataUri(await readFile(real));
}

const isClipShot = shot => CLIP_SHOT_MODELS.includes(shot.model);

// Pre-rendered clips (heygen_avatar / local_clip) follow the same containment
// rule as shot images: inside the brief folder or the assets root.
export async function resolveLocalClip(path, { briefDir, assetsRoot }) {
  const roots = await realRoots(briefDir, assetsRoot);
  let real;
  try { real = await realpath(resolve(briefDir, path)); } catch { throw fail(`Clip not found: ${basename(path)}`, 'CLIP_NOT_FOUND'); }
  if (!roots.some(root => inside(root, real))) throw fail('Clip must be inside the brief folder or the assets folder.', 'CLIP_OUTSIDE_ROOTS');
  const info = await stat(real);
  if (!info.isFile()) throw fail(`Clip is not a file: ${basename(path)}`, 'CLIP_NOT_FOUND');
  if (info.size > MAX_CLIP_BYTES) throw fail(`Clip ${basename(path)} is larger than ${MAX_CLIP_BYTES / 1024 / 1024} MB.`, 'CLIP_TOO_LARGE');
  return real;
}

// QA M1/L3: the logo must be a real PNG inside <assets>/overlays (symlinks are
// resolved first), at most 5 MB and 4096 px a side. Missing -> null (skipped);
// anything else wrong -> LOGO_INVALID, before any ffmpeg run.
export async function validateLogo(logoPath, assetsRoot) {
  if (!logoPath) return null;
  if (!(await exists(logoPath))) return null;
  const roots = await realRoots(...[assetsRoot].flat().map(r => join(resolve(r), 'overlays')));
  let real;
  try { real = await realpath(logoPath); } catch { return null; }
  if (!roots.some(root => inside(root, real))) throw fail('Logo must be inside the assets overlays folder (symlinks pointing elsewhere are refused).', 'LOGO_OUTSIDE_ROOTS');
  const info = await stat(real);
  if (!info.isFile()) throw fail('Logo is not a file.', 'LOGO_INVALID');
  if (info.size > MAX_LOGO_BYTES) throw fail(`Logo is larger than ${MAX_LOGO_BYTES / 1024 / 1024} MB.`, 'LOGO_INVALID');
  const handle = await open(real, 'r');
  let head;
  try { head = Buffer.alloc(24); await handle.read(head, 0, 24, 0); } finally { await handle.close(); }
  if (!head.subarray(0, 8).equals(PNG_MAGIC) || head.toString('ascii', 12, 16) !== 'IHDR') throw fail('Logo is not a PNG file.', 'LOGO_INVALID');
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
  if (!w || !h || w > MAX_LOGO_PIXELS || h > MAX_LOGO_PIXELS) throw fail(`Logo must be 1-${MAX_LOGO_PIXELS} px a side.`, 'LOGO_INVALID');
  return real;
}

// QA L4: LUT, font and music files must resolve (symlinks followed) inside
// <root>/<sub> of one of the asset roots, be regular files and stay under a
// size cap. Missing files are left to missingAssets(); returns the real path.
const ASSET_RULES = Object.freeze({
  lut: { sub: 'luts', max: MAX_LUT_BYTES, code: 'LUT_INVALID' },
  font: { sub: 'fonts', max: MAX_FONT_BYTES, code: 'FONT_INVALID' },
  cardFont: { sub: 'fonts', max: MAX_FONT_BYTES, code: 'FONT_INVALID' },
  music: { sub: 'music', max: MAX_MUSIC_BYTES, code: 'MUSIC_INVALID' },
});
export async function validateAssetFile(kind, path, roots) {
  const rule = ASSET_RULES[kind];
  if (!rule) throw fail(`Unknown asset kind ${kind}`, 'ASSET_INVALID');
  if (!path || !(await exists(path))) return null;
  const allowed = await realRoots(...[roots].flat().filter(Boolean).map(r => join(resolve(r), rule.sub)));
  let real;
  try { real = await realpath(path); } catch { return null; }
  if (!allowed.some(root => inside(root, real))) throw fail(`${kind} must be inside an assets ${rule.sub} folder (symlinks pointing elsewhere are refused).`, `${rule.code.split('_')[0]}_OUTSIDE_ROOTS`);
  const info = await stat(real);
  if (!info.isFile()) throw fail(`${kind} is not a file: ${basename(path)}`, rule.code);
  if (info.size > rule.max) throw fail(`${kind} ${basename(path)} is larger than ${rule.max / 1024 / 1024} MB.`, rule.code);
  if (rule.sub === 'fonts') parseFontNameTable(await readFile(real));
  return real;
}

// Validates every capped asset of a resolved asset set (CLI + runPipeline).
export async function validateAssets(assets) {
  const roots = assets.roots || [assets.root];
  for (const kind of Object.keys(ASSET_RULES)) await validateAssetFile(kind, assets[kind], roots);
}

// QA M4: avatar shots fail closed without a valid local consent record inside
// the brief folder or the assets root. Returns { file, sha256, subject, ... } for the receipt.
export async function loadAvatarConsent(brief, { briefDir, assetsRoot, now = Date.now() }) {
  if (!brief.shots.some(s => s.model === 'heygen_avatar')) return null;
  if (!brief.avatarConsent?.record) throw fail('heygen_avatar shots need avatarConsent.record; refusing to render.', 'AVATAR_CONSENT_MISSING');
  const roots = await realRoots(briefDir, assetsRoot);
  let real;
  try { real = await realpath(resolve(briefDir, brief.avatarConsent.record)); } catch { throw fail(`Avatar consent record not found: ${basename(brief.avatarConsent.record)}`, 'AVATAR_CONSENT_MISSING'); }
  if (!roots.some(root => inside(root, real))) throw fail('Avatar consent record must be inside the brief folder or the assets folder.', 'AVATAR_CONSENT_OUTSIDE_ROOTS');
  const info = await stat(real);
  if (!info.isFile() || info.size > MAX_CONSENT_BYTES) throw fail('Avatar consent record must be a JSON file of at most 64 KB.', 'AVATAR_CONSENT_INVALID');
  const raw = await readFile(real);
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw fail('Avatar consent record is not valid JSON.', 'AVATAR_CONSENT_INVALID'); }
  const record = parseAvatarConsent(value, { now });
  return { file: basename(real), sha256: createHash('sha256').update(raw).digest('hex'), subject: record.subject, method: record.method, consentedAt: record.consentedAt, expiresAt: record.expiresAt || null, scope: record.scope };
}

// QA L2: the voice track must live in the brief folder or the assets folder.
export async function assertVoiceContained(assets, briefDir) {
  const roots = await realRoots(briefDir, assets.root);
  let real;
  try { real = await realpath(assets.voice); } catch { throw fail('Voice file not found.', 'VOICE_NOT_FOUND'); }
  if (!roots.some(root => inside(root, real))) throw fail('Voice file must be inside the brief folder or the assets folder.', 'VOICE_OUTSIDE_ROOTS');
  const info = await stat(real);
  if (!info.isFile() || info.size > MAX_VOICE_BYTES) throw fail(`Voice must be a file of at most ${MAX_VOICE_BYTES / 1024 / 1024} MB.`, 'VOICE_INVALID');
  return real;
}

function fail(message, code) { return Object.assign(new Error(message), { code }); }

export function defaultAssetsRoot(env = process.env, platform = process.platform) {
  // %USERPROFILE%\lux-assets on Windows, ~/lux-assets elsewhere; LUX_ASSETS_DIR or --assets override.
  if (env.LUX_ASSETS_DIR) return env.LUX_ASSETS_DIR;
  return join(homedir(), 'lux-assets');
}

// Adapter env for planning: caps mirror the $1/clip limit; never contains a secret.
function planEnv() {
  return { VIDEO_OS_RUNWAY_MAX_CREDITS_PER_TASK: String(CLIP_CAP_CREDITS), VIDEO_OS_RUNWAY_MAX_DURATION_SECONDS: '10' };
}

function shotInput(brief, shot) {
  return {
    mode: shot.promptImage ? 'image_to_video' : 'text_to_video',
    model: SHOT_MODELS[shot.model],
    promptText: shot.prompt,
    ...(shot.promptImage ? { promptImage: PLAN_IMAGE } : {}),
    ratio: ASPECTS[brief.aspect].ratio,
    duration: shot.duration,
    ...(shot.seed !== undefined ? { seed: shot.seed } : {}),
  };
}

// Builds the plan and enforces the $1/clip and $10/video caps. Throws before
// anything is submitted; callers must not retry a CAP_EXCEEDED error.
export function planBrief(brief) {
  const shots = brief.shots.map(shot => {
    if (isClipShot(shot)) {
      // No Runway call. HeyGen avatar seconds are estimated at list price and
      // held to the same $1/clip cap (the render itself happens outside this tool).
      // QA L2: compare the unrounded estimate so the cap can actually bind.
      const rawUsd = shot.model === 'heygen_avatar' ? Math.ceil(shot.duration) * HEYGEN_AVATAR_USD_PER_SECOND : 0;
      const heygenEstUsd = +rawUsd.toFixed(2);
      if (rawUsd > CLIP_CAP_USD) throw fail(`Shot ${shot.id} exceeds the $${CLIP_CAP_USD} per-clip cap.`, 'CAP_EXCEEDED_CLIP');
      return { id: shot.id, briefModel: shot.model, model: shot.model, mode: 'local_clip', duration: shot.duration, ratio: ASPECTS[brief.aspect].ratio, credits: 0, estUsd: heygenEstUsd, heygenEstUsd };
    }
    const input = shotInput(brief, shot);
    let request;
    try {
      request = buildRunwayRequest(input, planEnv());
    } catch (error) {
      if (error.code === 'RUNWAY_CREDIT_LIMIT' || error.code === 'RUNWAY_DURATION_LIMIT') {
        throw fail(`Shot ${shot.id} exceeds the $${CLIP_CAP_USD} per-clip cap.`, 'CAP_EXCEEDED_CLIP');
      }
      throw fail(`Shot ${shot.id}: ${error.message}`, error.code || 'SHOT_INVALID');
    }
    if (request.credits > CLIP_CAP_CREDITS) throw fail(`Shot ${shot.id} exceeds the $${CLIP_CAP_USD} per-clip cap.`, 'CAP_EXCEEDED_CLIP');
    return { id: shot.id, briefModel: shot.model, model: request.body.model, mode: request.mode, duration: shot.duration, ratio: request.body.ratio, credits: request.credits, estUsd: +(request.credits * RUNWAY_USD_PER_CREDIT).toFixed(2), input };
  });
  const totalCredits = shots.reduce((sum, s) => sum + s.credits, 0);
  const heygenEstUsd = +shots.reduce((sum, s) => sum + (s.heygenEstUsd || 0), 0).toFixed(2);
  const totalEstUsd = +(totalCredits * RUNWAY_USD_PER_CREDIT + heygenEstUsd).toFixed(2);
  if (totalCredits > VIDEO_CAP_CREDITS || totalEstUsd > VIDEO_CAP_USD) throw fail(`Video estimate $${totalEstUsd.toFixed(2)} exceeds the $${VIDEO_CAP_USD} per-video cap.`, 'CAP_EXCEEDED_VIDEO');
  const transitions = brief.transitions.reduce((sum, t) => sum + t.duration, 0);
  return {
    slug: brief.slug,
    aspect: brief.aspect,
    shots,
    totalCredits,
    totalEstUsd,
    ...(heygenEstUsd ? { runwayEstUsd: +(totalCredits * RUNWAY_USD_PER_CREDIT).toFixed(2), heygenEstUsd } : {}),
    caps: { clipUsd: CLIP_CAP_USD, videoUsd: VIDEO_CAP_USD, usdPerCredit: RUNWAY_USD_PER_CREDIT },
    timelineSeconds: +(shots.reduce((sum, s) => sum + s.duration, 0) - transitions + (brief.endCard?.enabled ? brief.endCard.duration : 0)).toFixed(3),
    theme: brief.theme,
    captionStyle: brief.captionStyle,
    disclosure: AI_DISCLOSURE_TEXT,
    warnings: [...kineticWarnings(brief.captions || []), ...kineticFitWarnings(brief.captions || [], ASPECTS[brief.aspect].width, ASPECTS[brief.aspect].height)],
  };
}

// Tracked brand pack in this repo (LUTs + logos; fonts/music only when the
// repo is private, see brand-assets/README.md).
export const REPO_ASSETS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'brand-assets');

// Each asset comes from the first root that has it: the primary root, then
// the fallbacks in order (e.g. repo brand-assets, then %USERPROFILE%\lux-assets).
export function resolveAssets(brief, assetsRoot, briefDir = process.cwd(), { fallbackRoots = [] } = {}) {
  const root = resolve(assetsRoot);
  const roots = [root, ...fallbackRoots.map(r => resolve(r)).filter(r => r !== root)];
  const pick = (sub, name) => {
    if (!name) return null;
    for (const r of roots) { const p = join(r, sub, name); if (existsSync(p)) return p; }
    return join(root, sub, name);
  };
  return {
    root,
    roots,
    font: pick('fonts', FONT_PRESETS[brief.fontPreset]),
    lut: pick('luts', brief.lut),
    // Keyword cards always use the bold brand face, whatever fontPreset says.
    ...(brief.captionStyle === 'cards' ? { cardFont: pick('fonts', FONT_PRESETS['lux-sans-bold']) } : {}),
    music: brief.music ? pick('music', brief.music.track) : null,
    logo: pick('overlays', brief.logoOverlay),
    logoDark: pick('overlays', brief.logoOverlayDark),
    voice: resolve(briefDir, brief.voice.path),
  };
}

export async function missingAssets(assets) {
  const missing = [];
  for (const [key, path] of Object.entries(assets)) {
    if (key === 'root' || key === 'roots' || key === 'logo' || key === 'logoDark' || !path) continue;
    try { await access(path); } catch { missing.push({ key, path }); }
  }
  return missing;
}

// The logo is optional: a missing PNG skips the corner bug and the end-card
// logo cleanly instead of blocking the render.
export async function optionalAssetWarnings(assets) {
  if (!assets.logo) return [];
  try { await access(assets.logo); return []; } catch { return [`LOGO_MISSING: ${basename(assets.logo)} not found; corner bug and end-card logo will be skipped`]; }
}

// Clip-shot files (heygen_avatar / local_clip) that do not exist yet.
export async function missingClips(brief, briefDir) {
  const out = [];
  for (const shot of brief.shots.filter(isClipShot)) {
    try { await access(resolve(briefDir, shot.clip)); } catch { out.push({ key: `clip:${shot.id}`, path: resolve(briefDir, shot.clip) }); }
  }
  return out;
}

export function resolveFfmpeg(explicit, env = process.env) {
  const candidates = [explicit, env.LUX_FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) continue;
    const missing = REQUIRED_FILTERS.filter(name => !new RegExp(`\\s${name}\\s`).test(result.stdout));
    if (!missing.length) return candidate;
  }
  throw fail(`No ffmpeg with the required filters (${REQUIRED_FILTERS.join(', ')}) was found. Pass --ffmpeg <path>. ffmpeg-static lacks drawtext.`, 'FFMPEG_UNAVAILABLE');
}

// QA M2: escape a file path used as an unquoted filter option value. Two
// levels: the option parser (\ ' :) and then the filtergraph parser
// (\ ' [ ] , ;). Windows separators become '/', so `C:\x` -> `C\\:/x`.
export function ffFilterPath(path, platform = process.platform) {
  let value = String(path);
  if (platform === 'win32' || /^[A-Za-z]:\\/.test(value)) value = value.replace(/\\/g, '/');
  const level1 = value.replace(/[\\':]/g, ch => `\\${ch}`);
  return level1.replace(/[\\'[\],;]/g, ch => `\\${ch}`);
}

// QA L1: never overwrite. `-n` alone is not enough (ffmpeg 7 exits 0 when it
// refuses an existing output), so the output (last arg) is checked first and
// confirmed afterwards.
// QA M1: a failed, timed-out or empty run removes the partial output (it did
// not exist before this call), so no 0-byte final is ever left behind.
export async function runFfmpeg(ffmpeg, args, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  const output = args[args.length - 1];
  const checkOutput = output !== '-';
  if (checkOutput && await exists(output)) throw fail(`${basename(output)} already exists; refusing to overwrite.`, 'OUTPUT_EXISTS');
  try {
    await spawnFfmpeg(ffmpeg, args, timeoutMs);
    if (checkOutput) {
      let size = -1;
      try { size = (await stat(output)).size; } catch { /* missing */ }
      if (size < 0) throw fail('ffmpeg did not write its output.', 'FFMPEG_FAILED');
      if (size === 0) throw fail('ffmpeg wrote an empty output.', 'FFMPEG_EMPTY_OUTPUT');
    }
  } catch (error) {
    if (checkOutput) { try { await unlink(output); } catch { /* nothing written */ } }
    throw error;
  }
}

function spawnFfmpeg(ffmpeg, args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-n', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-3000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(fail(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)} s and was killed.`, 'FFMPEG_TIMEOUT'));
      return code === 0 ? resolvePromise() : reject(fail(`ffmpeg exited ${code}: ${stderr.slice(-800)}`, 'FFMPEG_FAILED'));
    });
  });
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function titleFilters(shot, font, width, height, textFiles, theme = 'dark', { avoidBottom = null } = {}) {
  const tk = themeTokens(theme);
  // 1104: in portrait the lower third sat at 0.76 H and its plate ran into the
  // AI label at 0.83 H; it now ends above the label.
  const ly0 = height > width ? 0.67 : 0.76;
  return shot.titles.flatMap((t, i) => {
    const enable = `enable='between(t,${t.start},${t.end})'`;
    const main = textFiles[`${i}-main`];
    const size = Math.round(height / (t.kind === 'banner' ? 14 : 20));
    // v3c: with burned-in subtitles the lower-third plate ends above the subtitle plate.
    const plateH = Math.round(size * (t.subtext ? 2.8 : 1.7));
    const ly = avoidBottom == null ? ly0 : Math.min(ly0, Math.floor(((avoidBottom - plateH) / height) * 1000) / 1000);
    const base = `fontfile=${ffFilterPath(font)}:expansion=none:fontcolor=${tk.text}:fontsize=${size}:borderw=2:bordercolor=${tk.stroke}`;
    if (t.kind === 'banner') {
      return [`drawbox=x=0:y=ih*0.08:w=iw:h=${Math.round(size * 1.8)}:color=${tk.titlePlate}:t=fill:${enable}`,
        `drawtext=${base}:textfile=${ffFilterPath(main)}:x=(w-text_w)/2:y=h*0.08+${Math.round(size * 0.4)}:${enable}`];
    }
    const out = [`drawbox=x=iw*0.05:y=ih*${ly}:w=iw*0.6:h=${Math.round(size * (t.subtext ? 2.8 : 1.7))}:color=${tk.lowerPlate}:t=fill:${enable}`,
      `drawtext=${base}:textfile=${ffFilterPath(main)}:x=w*0.07:y=h*${ly}+${Math.round(size * 0.35)}:${enable}`];
    if (t.subtext) out.push(`drawtext=fontfile=${ffFilterPath(font)}:expansion=none:fontcolor=${tk.textSecondary}:fontsize=${Math.round(size * 0.65)}:textfile=${ffFilterPath(textFiles[`${i}-sub`])}:x=w*0.07:y=h*${ly}+${Math.round(size * 1.7)}:${enable}`);
    return out;
  });
}

// Step 1+2 per clip: grade (media-finisher graph + optional LUT) and burn titles.
export async function finishClip({ ffmpeg, input, output, shot, assets, width, height, workdir, grainStrength = 6, theme = 'dark', lutStrength = 1, ffmpegTimeoutMs, avoidBottom = null }) {
  const textFiles = {};
  for (const [i, t] of shot.titles.entries()) {
    textFiles[`${i}-main`] = join(workdir, `${shot.id}-t${i}.txt`);
    await writeFile(textFiles[`${i}-main`], t.text);
    if (t.subtext) { textFiles[`${i}-sub`] = join(workdir, `${shot.id}-t${i}s.txt`); await writeFile(textFiles[`${i}-sub`], t.subtext); }
  }
  // The LUT is inserted here (not via media-finisher's env) so its path gets
  // the full two-level escaping (QA M2).
  let grade = cinematicFinishingFilterGraph(width, height, { VIDEO_OS_COLOR_LUT_PATH: '', VIDEO_OS_FILM_GRAIN_STRENGTH: grainStrength });
  if (assets.lut) {
    const anchor = 'eq=saturation=1.14:contrast=1.06';
    if (!grade.includes(anchor)) throw fail('media-finisher grade changed; LUT insertion point missing.', 'GRADE_UNSUPPORTED');
    let lutPath = assets.lut;
    if (lutStrength !== 1) {
      lutPath = join(workdir, `${shot.id}-lut-x${lutStrength}.cube`);
      await writeFile(lutPath, scaleCube(await readFile(assets.lut, 'utf8'), lutStrength));
    }
    grade = grade.replace(anchor, `${anchor},lut3d=file=${ffFilterPath(lutPath)}:interp=tetrahedral`);
  }
  // Clip shots: hold the last frame if the clip is short; their audio is always
  // dropped (-an) so the master voice track stays the only voice.
  const hold = isClipShot(shot) ? [`tpad=stop_mode=clone:stop_duration=${shot.duration}`] : [];
  const vf = [grade, ...titleFilters(shot, assets.font, width, height, textFiles, theme, { avoidBottom }), ...hold, `fps=${FPS}`, 'settb=AVTB', 'format=yuv420p'].join(',');
  const seek = isClipShot(shot) && shot.clipStart ? ['-ss', String(shot.clipStart)] : [];
  await runFfmpeg(ffmpeg, [...seek, '-i', input, '-t', String(shot.duration), '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', output], { timeoutMs: ffmpegTimeoutMs });
}

// QA L5: bounds-checked sfnt reader. Any out-of-range offset or length is a
// clean FONT_INVALID, never a RangeError or a silently garbled table.
function fontInvalid(why) { return fail(`Font is malformed: ${why}`, 'FONT_INVALID'); }
export function parseFontNameTable(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw fontInvalid('too short');
  if (buf.length > MAX_FONT_BYTES) throw fail(`Font is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB.`, 'FONT_INVALID');
  const tag = buf.readUInt32BE(0);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(tag)) throw fontInvalid('not a TrueType/OpenType file');
  const tables = buf.readUInt16BE(4);
  if (!tables || 12 + tables * 16 > buf.length) throw fontInvalid('table directory out of range');
  let entry = -1;
  for (let i = 0; i < tables; i += 1) if (buf.toString('latin1', 12 + i * 16, 16 + i * 16) === 'name') entry = 12 + i * 16;
  if (entry < 0) throw fontInvalid('no name table');
  const off = buf.readUInt32BE(entry + 8), size = buf.readUInt32BE(entry + 12);
  if (off + 6 > buf.length || size < 6 || off + size > buf.length) throw fontInvalid('name table out of range');
  const count = buf.readUInt16BE(off + 2), strings = off + buf.readUInt16BE(off + 4);
  if (off + 6 + count * 12 > off + size || strings > off + size) throw fontInvalid('name records out of range');
  const records = [];
  for (let j = 0; j < count; j += 1) {
    const r = off + 6 + j * 12;
    const platform = buf.readUInt16BE(r), id = buf.readUInt16BE(r + 6), len = buf.readUInt16BE(r + 8), at = strings + buf.readUInt16BE(r + 10);
    if (at + len > off + size) throw fontInvalid('name string out of range');
    records.push({ platform, id, raw: buf.subarray(at, at + len) });
  }
  return { entry, records };
}

// Family name (name ID 16, else 1) from a TTF/OTF name table, for libass.
export async function fontFamilyName(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_FONT_BYTES) throw fail(`Font ${basename(path)} is not a file of at most ${MAX_FONT_BYTES / 1024 / 1024} MB.`, 'FONT_INVALID');
  const { records } = parseFontNameTable(await readFile(path));
  const found = {};
  for (const { platform, id, raw } of records) {
    if ((id !== 1 && id !== 16) || found[id]) continue;
    if ((platform === 3 || platform === 0) && raw.length % 2) throw fontInvalid('odd-length UTF-16 name');
    found[id] = platform === 3 || platform === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
  }
  if (found[16] || found[1]) return (found[16] || found[1]).replace(/[,\r\n]/g, ' ');
  throw fail(`No family name in ${basename(path)}`, 'FONT_INVALID');
}

export const CARD_FONT_FAMILY = 'LuxCardBold';
// Returns a copy of a TrueType/OpenType font whose 'name' table is replaced by
// a minimal one (family, subfamily, full name, PostScript name = `family`).
// The new table is appended; only its directory entry changes. Glyphs are
// untouched.
export function renameFontFamily(buf, family) {
  if (!/^[A-Za-z0-9]{1,31}$/.test(family)) throw fail('Font family must be 1-31 ASCII letters/digits.', 'FONT_INVALID');
  const { entry } = parseFontNameTable(buf);
  const names = [[1, family], [2, 'Regular'], [4, family], [6, family]];
  const strings = names.map(([, v]) => Buffer.from(v, 'utf16le').swap16());
  const header = Buffer.alloc(6 + names.length * 12);
  header.writeUInt16BE(0, 0); header.writeUInt16BE(names.length, 2); header.writeUInt16BE(header.length, 4);
  let off = 0;
  names.forEach(([id], j) => {
    const r = 6 + j * 12;
    header.writeUInt16BE(3, r); header.writeUInt16BE(1, r + 2); header.writeUInt16BE(0x409, r + 4);
    header.writeUInt16BE(id, r + 6); header.writeUInt16BE(strings[j].length, r + 8); header.writeUInt16BE(off, r + 10);
    off += strings[j].length;
  });
  const table = Buffer.concat([header, ...strings]);
  const pad = (4 - (buf.length % 4)) % 4;
  const out = Buffer.concat([buf, Buffer.alloc(pad), table, Buffer.alloc((4 - (table.length % 4)) % 4)]);
  out.writeUInt32BE(buf.length + pad, entry + 8);
  out.writeUInt32BE(table.length, entry + 12);
  return out;
}

// Step 3: xfade chain. Returns filter text and the final video duration.
export function xfadeGraph(durations, transitions) {
  if (durations.length === 1) return { graph: '[0:v]null[vout]', duration: durations[0] };
  if (!transitions.length) {
    const inputs = durations.map((_, i) => `[${i}:v]`).join('');
    return { graph: `${inputs}concat=n=${durations.length}:v=1:a=0[vout]`, duration: durations.reduce((a, b) => a + b, 0) };
  }
  const parts = [];
  let prev = '[0:v]';
  let length = durations[0];
  for (let i = 1; i < durations.length; i++) {
    const t = transitions[i - 1];
    const d = t.duration;
    const offset = +(length - d).toFixed(3);
    const out = i === durations.length - 1 ? '[vout]' : `[x${i}]`;
    parts.push(`${prev}[${i}:v]xfade=transition=${t.type}:duration=${d}:offset=${offset}${out}`);
    prev = out;
    length = +(length + durations[i] - d).toFixed(3);
  }
  return { graph: parts.join(';'), duration: length };
}

// QA L6: on-screen window of each shot after xfade overlaps. Shot i starts at
// sum(durations before i) - sum(transitions before i); neighbouring windows
// meet at the middle of each crossfade, so per-shot overlays swap there.
export function shotWindows(durations, transitions = []) {
  const out = [];
  let start = 0;
  durations.forEach((d, i) => {
    const before = i > 0 ? (transitions[i - 1]?.duration || 0) : 0;
    const after = i < durations.length - 1 ? (transitions[i]?.duration || 0) : 0;
    out.push({ start: +(start + before / 2).toFixed(3), end: +(start + d - after / 2).toFixed(3) });
    start += d - after;
  });
  return out;
}

// Steps 3-5: transitions, logo, music ducked under voice, loudness, mux.
export async function assembleFinal({ ffmpeg, clips, durations, brief, assets, output, workdir, width, height, cues = [], ffmpegTimeoutMs }) {
  const { graph, duration: contentDuration } = xfadeGraph(durations, brief.transitions);
  const theme = brief.theme || 'dark';
  const endCard = brief.endCard?.enabled ? brief.endCard : null;
  const duration = +(contentDuration + (endCard ? endCard.duration : 0)).toFixed(3);
  const esc = ffFilterPath;
  const font = assets.font;
  const args = [];
  clips.forEach(clip => args.push('-i', clip));
  let idx = clips.length;
  const voiceIdx = idx++; args.push('-i', assets.voice);
  let musicIdx = null; if (assets.music) { musicIdx = idx++; args.push('-stream_loop', '-1', '-i', assets.music); }
  let logoIdx = null; if (assets.logo) { logoIdx = idx++; args.push('-loop', '1', '-framerate', String(FPS), '-i', assets.logo); }
  let darkIdx = null; if (assets.logo && assets.logoDark) { darkIdx = idx++; args.push('-loop', '1', '-framerate', String(FPS), '-i', assets.logoDark); }
  const textFile = async (name, value) => { const f = join(workdir, name); await writeFile(f, value); return f; };
  const filters = [graph];
  let video = '[vout]';
  const bugOn = logoIdx !== null && brief.bug?.enabled !== false;
  // Logo uses: light bug, dark bug, end card. With a dark variant the bug
  // swaps per shot tone and the end card takes the variant matching its theme.
  const uses = { light: [], dark: [] };
  const shotWin = shotWindows(durations, brief.transitions);
  const windows = { light: [], dark: [] };
  brief.shots.forEach((s, i) => { windows[s.tone || theme].push(shotWin[i]); });
  if (bugOn && darkIdx === null) uses.light.push('bug');
  if (bugOn && darkIdx !== null) { if (windows.light.length) uses.light.push('bug'); if (windows.dark.length) uses.dark.push('bug'); }
  if (logoIdx !== null && endCard) (darkIdx !== null && theme === 'dark' ? uses.dark : uses.light).push('end');
  const labels = {};
  for (const [tone, list] of Object.entries(uses)) {
    const input = tone === 'dark' ? darkIdx : logoIdx;
    if (list.length === 2) { filters.push(`[${input}:v]split=2[${tone}0][${tone}1]`); list.forEach((u, k) => { labels[`${tone}-${u}`] = `[${tone}${k}]`; }); }
    else if (list.length === 1) labels[`${tone}-${list[0]}`] = `[${input}:v]`;
  }
  // 1. Corner bug (top-right) on the content only.
  if (bugOn) {
    const opacity = brief.bug?.opacity ?? 0.85;
    if (darkIdx === null) {
      filters.push(bugFilter({ logoLabel: labels['light-bug'], videoLabel: video, outLabel: '[vbug]', width, height, opacity, until: contentDuration }));
      video = '[vbug]';
    } else {
      for (const tone of ['light', 'dark']) {
        if (!labels[`${tone}-bug`]) continue;
        filters.push(bugFilter({ logoLabel: labels[`${tone}-bug`], videoLabel: video, outLabel: `[vbug${tone}]`, width, height, opacity, until: contentDuration, windows: windows[tone] }));
        video = `[vbug${tone}]`;
      }
    }
  }
  // 2. Kinetic captions and burned-in subtitles.
  const draws = [];
  const style = brief.captionStyle || 'none';
  if ((style === 'kinetic' || style === 'both') && brief.captions?.length) {
    const files = [];
    for (const [i, c] of brief.captions.entries()) files.push(await textFile(`cap-${i}.txt`, c.text));
    draws.push(...kineticFilters(brief.captions, { font, width, height, theme, textFile: i => files[i], esc }));
  }
  if (style === 'subtitle' || brief.subtitles?.burnIn) {
    const files = [];
    for (const [i, c] of cues.entries()) files.push(await textFile(`sub-${i}.txt`, c.text));
    draws.push(...subtitleFilters(cues, { font, width, height, theme, textFile: i => files[i], esc }));
  }
  if (style === 'cards' && brief.captions?.length) {
    // libass picks fonts BY NAME. lux-sans-bold.ttf is internally named
    // "Montserrat" / "Montserrat Thin" (static cut of the variable font), so a
    // name lookup silently resolves to any system Montserrat at weight 400
    // (seen on the box: Montserrat-VariableFont_wght.ttf). The cards get a
    // private copy renamed to a unique family so only the brand file matches.
    const fontsDir = join(workdir, 'card-fonts');
    await mkdir(fontsDir, { recursive: true });
    const cardFont = assets.cardFont || font;
    const fontInfo = await stat(cardFont);
    if (fontInfo.size > MAX_FONT_BYTES) throw fail(`Card font is larger than ${MAX_FONT_BYTES / 1024 / 1024} MB.`, 'FONT_INVALID');
    await writeFile(join(fontsDir, 'lux-card.ttf'), renameFontFamily(await readFile(cardFont), CARD_FONT_FAMILY));
    const avatarWindows = brief.shots.map((s, i) => ({ ...shotWin[i], avatar: s.model === 'heygen_avatar' })).filter(w => w.avatar);
    // QA N2: with burned-in subtitles the card block ends above the subtitle plate.
    const subsOn = style === 'subtitle' || Boolean(brief.subtitles?.burnIn);
    const avoidBottom = subsOn ? subtitleTop(width, height) - Math.round(Math.min(width, height) * 0.02) : null;
    const assFile = await textFile('cards.ass', cardsAss(brief.captions, { width, height, fontName: CARD_FONT_FAMILY, avatarWindows, avoidBottom }));
    draws.push(`ass=filename=${esc(assFile)}:fontsdir=${esc(fontsDir)}:shaping=simple`);
  }
  if (draws.length) { filters.push(`${video}${draws.join(',')}[vcap]`); video = '[vcap]'; }
  // 3. End card (appended after the content).
  if (endCard) {
    const ctaFile = endCard.cta ? await textFile('endcard-cta.txt', endCard.cta) : null;
    const urlFile = endCard.url ? await textFile('endcard-url.txt', endCard.url) : null;
    filters.push(endCardGraph({ width, height, duration: endCard.duration, theme, logoLabel: labels['dark-end'] || labels['light-end'] || null, ctaFile, urlFile, font, esc, outLabel: '[vend]' }));
    filters.push(`${video}format=yuv420p,setsar=1[vmain];[vmain][vend]concat=n=2:v=1:a=0[vcat]`);
    video = '[vcat]';
  }
  // 4. Mandatory AI disclosure, last so nothing covers it, over the full duration.
  const discFile = await textFile('disclosure.txt', AI_DISCLOSURE_TEXT);
  filters.push(`${video}${disclosureFilters({ font, width, height, theme, textFile: discFile, esc }).join(',')}[vfinal]`);
  video = '[vfinal]';
  const lufs = brief.loudnessLufs;
  filters.push(`[${voiceIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${duration}[voice]`);
  if (musicIdx !== null) {
    filters.push('[voice]asplit=2[vmix][vkey]');
    filters.push(`[${musicIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${duration},volume=${brief.music.volume}[music]`);
    filters.push('[music][vkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]');
    filters.push('[vmix][ducked]amix=inputs=2:duration=first:normalize=0[mix]');
    filters.push(`[mix]loudnorm=I=${lufs}:TP=-1.5:LRA=11,aresample=48000[aout]`);
  } else {
    filters.push(`[voice]loudnorm=I=${lufs}:TP=-1.5:LRA=11,aresample=48000[aout]`);
  }
  args.push('-filter_complex', filters.join(';'), '-map', video, '-map', '[aout]', '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output);
  await runFfmpeg(ffmpeg, args, { timeoutMs: ffmpegTimeoutMs });
  return { duration, contentDuration, endCard: Boolean(endCard), bug: bugOn, bugVariants: darkIdx !== null };
}

// ---------------------------------------------------------------------------
// Receipt ledger (QA H1/M1). receipt.json is the only record of paid Runway
// task ids, so it is written atomically (temp file, fsync, rename), never
// replaced by a fresh run, and every attempt across runs is kept.
export const RECEIPT_VERSION = 'luxify-local-receipt/v2';
// Statuses whose credits count toward the cumulative $10 cap.
const COUNTED = new Set(['creating', 'submitted', 'unresolved', 'lost', 'stored', 'spent']);
const PENDING = new Set(['creating', 'submitted', 'unresolved']);

export async function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  try { const dir = await open(dirname(path), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch { /* dir fsync unsupported (Windows) */ }
}

// QA L1: HeyGen avatar spend (estimated) joins the cumulative ledger. Each
// distinct avatar clip (by sha256) counts once, across all runs and resumes.
export function committedAvatarUsd(state) {
  return +(state.avatarClips || []).reduce((sum, a) => sum + (a.estUsd || 0), 0).toFixed(2);
}

export function committedUsd(state) {
  return +(committedCredits(state) * RUNWAY_USD_PER_CREDIT + committedAvatarUsd(state)).toFixed(2);
}

export function committedCredits(state) {
  return (state.attempts || []).filter(a => COUNTED.has(a.status)).reduce((sum, a) => sum + (a.credits || 0), 0);
}

export function pendingAttempts(state) {
  return (state.attempts || []).filter(a => PENDING.has(a.status));
}

export function createLedger(path, initial) {
  const state = { ...initial, attempts: [...(initial.attempts || [])], runs: [...(initial.runs || [])], avatarClips: [...(initial.avatarClips || [])] };
  const view = () => {
    const tasks = {};
    for (const a of state.attempts) tasks[a.shotId] = { taskId: a.taskId ?? null, status: a.status, credits: a.credits, model: a.model, run: a.run, ...(a.sha256 ? { sha256: a.sha256 } : {}), ...(a.errorCode ? { errorCode: a.errorCode } : {}), ...(a.providerFailureCode ? { providerFailureCode: a.providerFailureCode } : {}) };
    return { ...state, tasks, committedCredits: committedCredits(state), committedEstUsd: committedUsd(state), committedAvatarEstUsd: committedAvatarUsd(state) };
  };
  const save = () => writeJsonAtomic(path, view());
  return {
    state,
    view,
    latest: shotId => [...state.attempts].reverse().find(a => a.shotId === shotId) || null,
    committed: () => committedCredits(state),
    committedUsd: () => committedUsd(state),
    async addAvatarClip(entry) { if (state.avatarClips.some(a => a.sha256 === entry.sha256)) return false; state.avatarClips.push({ ...entry, recordedAt: new Date().toISOString() }); await save(); return true; },
    async add(attempt) { const a = { ...attempt, updatedAt: new Date().toISOString() }; state.attempts.push(a); await save(); return a; },
    async update(attempt, patch) { Object.assign(attempt, patch, { updatedAt: new Date().toISOString() }); await save(); },
    async set(patch) { Object.assign(state, patch); await save(); },
    async startRun(info) { state.run = (state.run || 0) + 1; state.status = 'running'; state.runs.push({ run: state.run, startedAt: new Date().toISOString(), ...info }); await save(); return state.run; },
    async endRun(patch) { Object.assign(state.runs[state.runs.length - 1], { endedAt: new Date().toISOString(), ...patch }); Object.assign(state, { status: patch.status }); await save(); },
  };
}

export function inputHash(briefShot, planShot) {
  const material = { model: planShot.model, mode: planShot.mode, prompt: briefShot.prompt, duration: briefShot.duration, ratio: planShot.ratio, seed: briefShot.seed ?? null, promptImage: briefShot.promptImage ?? null };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32);
}

function attemptStatus(error) {
  if (error.unresolved) return 'unresolved';
  if (error.creditsSpent) return 'spent';
  if (error.releaseCredits) return 'failed';
  return 'unresolved';
}

async function fileSha(path) { try { return await sha256File(path); } catch { return null; } }

// Runway step. `runwayDeps` must be supplied by the caller (CLI live mode or tests).
// - A stored clip with the same shot inputs is reused (hash verified).
// - submitted/unresolved tasks from earlier runs are reconciled by polling
//   their id (resumeRunwayTask); nothing is resubmitted while a task is pending.
// - Every new submit is checked against the cumulative $10 cap, which counts
//   spent, stored, submitted and unresolved credits from all runs.
// - Each task id is persisted before polling (QA M2).
export async function generateClips(plan, { brief, briefDir, assetsRoot, runwayEnv, runwayDeps, clipsDir, ledger, run }) {
  await mkdir(clipsDir, { recursive: true });
  const videoCap = Math.round(VIDEO_CAP_USD / RUNWAY_USD_PER_CREDIT);
  const writer = async (_classification, pathname, bytes) => {
    const file = join(clipsDir, basename(pathname));
    try {
      await writeFile(file, bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const want = createHash('sha256').update(bytes).digest('hex');
      if (await fileSha(file) !== want) throw fail(`Refusing to overwrite a different clip: ${basename(file)}`, 'CLIP_EXISTS');
    }
    return { pathname };
  };
  const env = { ...planEnv(), ...runwayEnv };
  const results = [];
  for (const [i, shot] of plan.shots.entries()) {
    const briefShot = brief.shots[i];
    if (isClipShot(briefShot)) {
      const file = await resolveLocalClip(briefShot.clip, { briefDir, assetsRoot });
      const sha256 = await sha256File(file);
      if (shot.heygenEstUsd) {
        const known = (ledger.state.avatarClips || []).some(a => a.sha256 === sha256);
        if (!known && ledger.committedUsd() + shot.heygenEstUsd > VIDEO_CAP_USD + 1e-9) {
          throw fail(`Avatar shot ${shot.id} would take this video past the $${VIDEO_CAP_USD} cap across runs (committed $${ledger.committedUsd().toFixed(2)}).`, 'CAP_EXCEEDED_VIDEO_CUMULATIVE');
        }
        await ledger.addAvatarClip({ shotId: shot.id, run, sha256, seconds: shot.duration, estUsd: shot.heygenEstUsd });
      }
      results.push({ ...shot, file, sha256, providerTaskId: null, reused: false, clipFile: basename(file) });
      continue;
    }
    const hash = inputHash(briefShot, shot);
    const job = { id: shot.id, accountId: 'local', reservedCredits: shot.credits };
    const deps = { ...runwayDeps, env, putPrivateBlob: writer };
    const done = (result, reused) => results.push({ ...shot, file: join(clipsDir, basename(result.clipFile)), sha256: result.sha256, providerTaskId: result.taskId, reused });

    let latest = ledger.latest(shot.id);
    if (latest?.status === 'stored' && latest.inputHash === hash && latest.clipFile && await fileSha(join(clipsDir, latest.clipFile)) === latest.sha256) {
      done(latest, true);
      continue;
    }
    if (latest && PENDING.has(latest.status)) {
      if (!latest.taskId) {
        // Created-or-not is unknown and there is no id to check: keep counting it.
        await ledger.update(latest, { status: 'lost', errorCode: 'TASK_ID_UNKNOWN' });
      } else {
        try {
          const result = await resumeRunwayTask(job, { taskId: latest.taskId, input: shot.input }, deps);
          await ledger.update(latest, { status: 'stored', sha256: result.sha256, clipFile: basename(result.privatePathname), reconciledInRun: run, errorCode: null });
          if (latest.inputHash === hash) { done(latest, true); continue; }
        } catch (error) {
          await ledger.update(latest, { status: attemptStatus(error), errorCode: error.code || 'ERROR', providerFailureCode: error.providerFailureCode || null, reconciledInRun: run });
          if (latest.status === 'unresolved') throw error;
        }
      }
    }
    if (ledger.committed() + shot.credits > videoCap || ledger.committedUsd() + shot.credits * RUNWAY_USD_PER_CREDIT > VIDEO_CAP_USD + 1e-9) {
      throw fail(`Submitting shot ${shot.id} would take this video past the $${VIDEO_CAP_USD} cap across runs (committed ${ledger.committed()} credits).`, 'CAP_EXCEEDED_VIDEO_CUMULATIVE');
    }
    const input = briefShot.promptImage ? { ...shot.input, promptImage: await loadShotImage(briefShot.promptImage, { briefDir, assetsRoot }) } : shot.input;
    const attempt = await ledger.add({ shotId: shot.id, run, status: 'creating', taskId: null, credits: shot.credits, model: shot.model, inputHash: hash });
    deps.onTaskCreated = async ({ taskId }) => ledger.update(attempt, { taskId, status: 'submitted' });
    let result;
    try {
      const created = await createRunwayTask(job, input, deps);
      result = await awaitRunwayTask(job, created, deps);
    } catch (error) {
      const patch = { taskId: error.providerTaskId ?? attempt.taskId, status: attemptStatus(error), errorCode: error.code || 'ERROR', providerFailureCode: error.providerFailureCode || null };
      if (error.code === 'RUNWAY_CREATE_REJECTED') patch.status = 'failed';
      try { await ledger.update(attempt, patch); } catch { /* the original error is more important */ }
      throw error;
    }
    await ledger.update(attempt, { status: 'stored', sha256: result.sha256, clipFile: basename(result.privatePathname) });
    done(attempt, false);
  }
  return results;
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }

// ---------------------------------------------------------------------------
// QA r2 M-A: one run per output folder. The lock is created with O_EXCL and
// holds the pid, host and start time. A second run is refused; a stale lock
// (owner pid gone, same host) can only be removed with --break-lock.
export const LOCK_FILE = '.luxify.lock';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function acquireLock(outDir, { breakLock = false } = {}) {
  const path = join(outDir, LOCK_FILE);
  const body = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      return { path, release: async () => { try { await unlink(path); } catch { /* already gone */ } } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = null;
    try { holder = JSON.parse(await readFile(path, 'utf8')); } catch { /* unreadable lock */ }
    const sameHost = holder?.host === hostname();
    const stale = !holder || (sameHost && Number.isSafeInteger(holder.pid) && !pidAlive(holder.pid));
    if (!breakLock || attempt > 0) {
      throw fail(`Another run holds ${LOCK_FILE} in this output folder${holder ? ` (pid ${holder.pid}, started ${holder.startedAt})` : ''}.${stale ? ' It looks stale; rerun with --break-lock to remove it.' : ''}`, 'OUTPUT_LOCKED');
    }
    if (!stale) throw fail(`${LOCK_FILE} is held by a live process${sameHost ? '' : ' on another host'}; refusing to break it.`, 'OUTPUT_LOCKED');
    await unlink(path);
  }
  throw fail('Could not acquire the output lock.', 'OUTPUT_LOCKED');
}

// QA r2 Low: temp files from a crashed atomic write are never read; remove them.
async function cleanTempFiles(outDir) {
  let removed = 0;
  for (const name of await readdir(outDir)) {
    if (/^receipt\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) { await unlink(join(outDir, name)); removed++; }
  }
  return removed;
}

async function listFiles(dir, pattern) {
  try { return (await readdir(dir)).filter(name => pattern.test(name)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// QA r2 M-B: receipt.json must account for everything receipt-history/ and
// clips/ show. Missing receipts, dropped task ids, downgraded statuses, lower
// committed credits or untracked clips all refuse the run.
export async function crossCheckReceipt(outDir, receipt) {
  const historyDir = join(outDir, 'receipt-history');
  const history = await listFiles(historyDir, /^receipt-run\d+-\d+\.json$/);
  const clips = await listFiles(join(outDir, 'clips'), /\.mp4$/i);
  if (!receipt) {
    if (history.length || clips.length) throw fail('receipt.json is missing but receipt-history/ or clips/ show earlier spend; refusing to start.', 'RECEIPT_MISSING');
    return;
  }
  const byTask = new Map(receipt.attempts.filter(a => a.taskId).map(a => [a.taskId, a]));
  const FINAL = new Set(['stored', 'spent', 'lost']);
  for (const name of history) {
    let old;
    try { old = JSON.parse(await readFile(join(historyDir, name), 'utf8')); } catch { throw fail(`receipt-history/${name} is unreadable; refusing to start.`, 'RECEIPT_TAMPERED'); }
    for (const a of old.attempts || []) {
      if (!a.taskId) continue;
      const now = byTask.get(a.taskId);
      if (!now) throw fail(`receipt.json is missing Runway task …${a.taskId.slice(-4)} recorded in receipt-history; refusing to start.`, 'RECEIPT_TAMPERED');
      if (FINAL.has(a.status) && now.status !== a.status) throw fail(`receipt.json changed a final task status (…${a.taskId.slice(-4)}); refusing to start.`, 'RECEIPT_TAMPERED');
      if ((now.credits || 0) < (a.credits || 0)) throw fail(`receipt.json lowered the credits of task …${a.taskId.slice(-4)}; refusing to start.`, 'RECEIPT_TAMPERED');
    }
    if (committedCredits(receipt) < committedCredits(old) || committedAvatarUsd(receipt) < committedAvatarUsd(old)) throw fail('receipt.json shows less committed spend than receipt-history; refusing to start.', 'RECEIPT_TAMPERED');
  }
  const tracked = new Set(receipt.attempts.map(a => a.clipFile).filter(Boolean));
  const untracked = clips.filter(name => !tracked.has(name));
  if (untracked.length) throw fail(`clips/ has ${untracked.length} clip(s) that receipt.json does not record; refusing to start.`, 'UNTRACKED_CLIPS');
}

// Read-only summary for the dry run: pending tasks, and pending tasks whose
// shot is no longer in the brief (orphaned; they still count toward the cap).
export async function receiptStatus(outDir, plan) {
  let receipt;
  try { receipt = JSON.parse(await readFile(join(outDir, 'receipt.json'), 'utf8')); } catch (error) { return error.code === 'ENOENT' ? null : { unreadable: true }; }
  if (!Array.isArray(receipt.attempts)) return { unreadable: true };
  const shotIds = new Set(plan.shots.map(s => s.id));
  const pending = pendingAttempts(receipt).map(a => ({ shotId: a.shotId, taskId: a.taskId ? `…${a.taskId.slice(-4)}` : null, status: a.status, credits: a.credits }));
  return { status: receipt.status, run: receipt.run, committedCredits: committedCredits(receipt), pending, orphanedPending: pending.filter(a => !shotIds.has(a.shotId)) };
}

export async function runPipeline(options) {
  const briefDir = options.briefDir || process.cwd();
  await assertVoiceContained(options.assets, briefDir);
  // QA M4 / M1: consent and logo are checked before the lock or any spend.
  const consent = await loadAvatarConsent(options.brief, { briefDir, assetsRoot: options.assets.root, now: options.now });
  const logo = await validateLogo(options.assets.logo, options.assets.roots || options.assets.root);
  await validateAssets(options.assets);
  await mkdir(options.outDir, { recursive: true });
  const lock = await acquireLock(options.outDir, { breakLock: Boolean(options.breakLock) });
  try {
    await cleanTempFiles(options.outDir);
    return await runPipelineLocked({ ...options, briefDir, consent, validLogo: logo });
  } finally {
    await lock.release();
  }
}

async function runPipelineLocked({ brief, briefDir, plan, outDir, assets, ffmpeg, runwayEnv, runwayDeps, resume = false, consent = null, validLogo = null, ffmpegTimeoutMs }) {
  const { width, height } = ASPECTS[brief.aspect];
  const receiptPath = join(outDir, 'receipt.json');
  let prior = null;
  try {
    prior = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail('receipt.json exists but cannot be read; refusing to start.', 'RECEIPT_UNREADABLE');
  }
  if (prior) {
    if (prior.version !== RECEIPT_VERSION || !Array.isArray(prior.attempts)) throw fail('receipt.json has an unknown format; refusing to start.', 'RECEIPT_UNREADABLE');
    const pending = pendingAttempts(prior);
    if (!resume) {
      throw pending.length
        ? fail(`receipt.json lists ${pending.length} submitted/unresolved Runway task(s). Rerun with --resume to reconcile them; nothing was submitted.`, 'RECEIPT_PENDING')
        : fail('receipt.json already exists in this output folder. Use --resume or a new --out.', 'RECEIPT_EXISTS');
    }
    if (prior.status === 'complete') throw fail('This render is already complete. Use a new --out.', 'RENDER_COMPLETE');
    await crossCheckReceipt(outDir, prior);
    if (prior.slug !== brief.slug) throw fail('receipt.json belongs to a different brief.', 'RECEIPT_MISMATCH');
    const historyDir = join(outDir, 'receipt-history');
    await mkdir(historyDir, { recursive: true });
    await copyFile(receiptPath, join(historyDir, `receipt-run${prior.run || 0}-${Date.now()}.json`), fsConstants.COPYFILE_EXCL);
  } else {
    await crossCheckReceipt(outDir, null);
    if (resume) throw fail('--resume was given but there is no receipt.json in the output folder.', 'RESUME_NO_RECEIPT');
  }
  const ledger = createLedger(receiptPath, prior || { version: RECEIPT_VERSION, slug: brief.slug, createdAt: new Date().toISOString(), caps: plan.caps, run: 0 });
  const nextRun = (ledger.state.run || 0) + 1;
  const finalName = nextRun === 1 ? 'final.mp4' : `final-run${nextRun}.mp4`;
  const finalPath = join(outDir, finalName);
  if (await exists(finalPath)) throw fail(`${finalName} already exists; refusing to overwrite.`, 'OUTPUT_EXISTS');
  const run = await ledger.startRun({ plannedCredits: plan.totalCredits, plannedEstUsd: plan.totalEstUsd });
  const workdir = join(outDir, 'work', `run${run}`);
  await mkdir(workdir, { recursive: true });
  let clips;
  let duration;
  let assembled;
  let cues = [];
  // Optional logo: missing file -> skip bug and end-card logo (recorded below).
  const logoPresent = Boolean(validLogo);
  const validDark = validLogo ? await validateLogo(assets.logoDark, assets.roots || assets.root) : null;
  const renderAssets = { ...assets, logo: validLogo, logoDark: validDark };
  const voiceSeconds = wavDurationSeconds(await readFile(assets.voice)) ?? null;
  try {
    clips = await generateClips(plan, { brief, briefDir, assetsRoot: assets.root, runwayEnv, runwayDeps, clipsDir: join(outDir, 'clips'), ledger, run });
    const finished = [];
    for (const [i, clip] of clips.entries()) {
      const output = join(workdir, `${String(i).padStart(2, '0')}-${clip.id}.mp4`);
      await finishClip({ ffmpeg, input: clip.file, output, shot: brief.shots[i], assets: renderAssets, width, height, workdir, theme: brief.theme, lutStrength: brief.lutStrength ?? 1, ffmpegTimeoutMs, avoidBottom: (brief.captionStyle === 'subtitle' || brief.subtitles?.burnIn) ? subtitleTop(width, height) - Math.round(Math.min(width, height) * 0.02) : null });
      finished.push(output);
    }
    const contentSeconds = plan.timelineSeconds - (brief.endCard?.enabled ? brief.endCard.duration : 0);
    cues = buildCues(brief.script, Math.min(voiceSeconds ?? contentSeconds, contentSeconds), { maxChars: subtitleMaxChars(width, height) });
    assembled = await assembleFinal({ ffmpeg, clips: finished, durations: brief.shots.map(s => s.duration), brief, assets: renderAssets, output: finalPath, workdir, width, height, cues, ffmpegTimeoutMs });
    ({ duration } = assembled);
  } catch (error) {
    try { await ledger.endRun({ status: 'aborted', errorCode: error.code || 'ERROR' }); } catch { /* keep original error */ }
    throw error;
  }
  const info = await stat(finalPath);
  if (!info.size) throw fail('ffmpeg produced an empty final video.', 'FINAL_EMPTY');
  const assetHash = async path => (path ? { file: basename(path), sha256: await sha256File(path) } : null);
  const sidecars = {};
  if (brief.subtitles?.sidecar !== false) {
    const stem = finalName.replace(/\.mp4$/, '');
    for (const [ext, body] of [['vtt', toVtt(cues)], ['srt', toSrt(cues)]]) {
      const file = join(outDir, `${stem}.${ext}`);
      await writeFile(file, body, { flag: 'wx' });
      sidecars[ext] = { file: basename(file), sha256: await sha256File(file) };
    }
  }
  await ledger.set({
    shots: clips.map(c => ({ id: c.id, briefModel: c.briefModel, model: c.model, mode: c.mode, duration: c.duration, ratio: c.ratio, credits: c.credits, estUsd: c.estUsd, clipSha256: c.sha256, providerTaskId: c.providerTaskId, reused: c.reused, ...(c.clipFile ? { clipFile: c.clipFile, heygenEstUsd: c.heygenEstUsd } : {}) })),
    totalCredits: plan.totalCredits,
    totalEstUsd: plan.totalEstUsd,
    ...(plan.heygenEstUsd ? { heygenEstUsd: plan.heygenEstUsd } : {}),
    overlays: { theme: brief.theme, captionStyle: brief.captionStyle, lutStrength: brief.lutStrength ?? 1, kineticBeats: brief.captions.length, disclosure: AI_DISCLOSURE_TEXT, bug: assembled.bug ? 'on' : (assets.logo && !logoPresent ? 'skipped-logo-missing' : 'off'), endCard: assembled.endCard ? (logoPresent ? 'logo' : 'text-only') : 'off', subtitleTiming: 'approx', sidecars },
    caps: plan.caps,
    ...(consent ? { avatarConsent: consent } : {}),
    assets: { font: await assetHash(assets.font), lut: await assetHash(assets.lut), music: await assetHash(assets.music), logo: await assetHash(renderAssets.logo), logoDark: await assetHash(renderAssets.logoDark), voice: await assetHash(assets.voice), voiceSource: brief.voice.source, heygenJobId: brief.voice.jobId || null },
    final: { file: finalName, bytes: info.size, sha256: await sha256File(finalPath), durationSeconds: duration, contentSeconds: assembled.contentDuration },
  });
  await ledger.endRun({ status: 'complete' });
  return ledger.view();
}

export async function loadBriefFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
