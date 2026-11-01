// Local Luxify pipeline: Runway clips (via services/runway-models.js) ->
// cinematic grade from services/media-finisher.js (LUT) -> drawtext titles ->
// xfade transitions -> music ducked under the HeyGen voice -> loudnorm ->
// final.mp4 + receipt.json. Makes no HeyGen calls. Runway is only contacted
// in live mode, which the CLI gates behind --live plus RUNWAYML_API_SECRET.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { ASPECTS, CLIP_CAP_USD, FONT_PRESETS, SHOT_MODELS, VIDEO_CAP_USD } from '../lib/luxify-local-brief.js';
import { cinematicFinishingFilterGraph } from './media-finisher.js';
import { RUNWAY_USD_PER_CREDIT, awaitRunwayTask, buildRunwayRequest, createRunwayTask, imageFileToDataUri } from './runway-models.js';

export const REQUIRED_FILTERS = Object.freeze(['drawtext', 'xfade', 'sidechaincompress', 'loudnorm', 'lut3d', 'overlay']);
const CLIP_CAP_CREDITS = Math.round(CLIP_CAP_USD / RUNWAY_USD_PER_CREDIT);
const VIDEO_CAP_CREDITS = Math.round(VIDEO_CAP_USD / RUNWAY_USD_PER_CREDIT);
const FPS = 30;
// 1x1 png used only to validate i2v shots while planning; the real image is
// loaded from disk (loadShotImage) right before submit.
const PLAN_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' ? false : !rel.startsWith('..') && !isAbsolute(rel);
}

// QA M3: only local files inside the brief folder or the owner's assets root.
export async function loadShotImage(path, { briefDir, assetsRoot }) {
  const roots = [];
  for (const root of [briefDir, assetsRoot]) { try { roots.push(await realpath(root)); } catch { /* missing root */ } }
  let real;
  try { real = await realpath(resolve(briefDir, path)); } catch { throw fail(`Shot image not found: ${basename(path)}`, 'IMAGE_NOT_FOUND'); }
  if (!roots.some(root => inside(root, real))) throw fail('Shot image must be inside the brief folder or the assets folder.', 'IMAGE_OUTSIDE_ROOTS');
  const bytes = await readFile(real);
  return imageFileToDataUri(bytes);
}

function fail(message, code) { return Object.assign(new Error(message), { code }); }

export function defaultAssetsRoot(env = process.env, platform = process.platform) {
  if (env.LUX_ASSETS_DIR) return env.LUX_ASSETS_DIR;
  return platform === 'win32' ? 'C:\\Users\\ariel\\lux-assets' : join(process.cwd(), 'lux-assets');
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
  if (totalCredits > VIDEO_CAP_CREDITS) throw fail(`Video estimate $${(totalCredits * RUNWAY_USD_PER_CREDIT).toFixed(2)} exceeds the $${VIDEO_CAP_USD} per-video cap.`, 'CAP_EXCEEDED_VIDEO');
  const transitions = brief.transitions.reduce((sum, t) => sum + t.duration, 0);
  return {
    slug: brief.slug,
    aspect: brief.aspect,
    shots,
    totalCredits,
    totalEstUsd: +(totalCredits * RUNWAY_USD_PER_CREDIT).toFixed(2),
    caps: { clipUsd: CLIP_CAP_USD, videoUsd: VIDEO_CAP_USD, usdPerCredit: RUNWAY_USD_PER_CREDIT },
    timelineSeconds: +(shots.reduce((sum, s) => sum + s.duration, 0) - transitions).toFixed(3),
  };
}

export function resolveAssets(brief, assetsRoot) {
  const root = resolve(assetsRoot);
  return {
    root,
    font: join(root, 'fonts', FONT_PRESETS[brief.fontPreset]),
    lut: brief.lut ? join(root, 'luts', brief.lut) : null,
    music: brief.music ? join(root, 'music', brief.music.track) : null,
    logo: brief.logoOverlay ? join(root, 'overlays', brief.logoOverlay) : null,
    voice: resolve(brief.voice.path),
  };
}

export async function missingAssets(assets) {
  const missing = [];
  for (const [key, path] of Object.entries(assets)) {
    if (key === 'root' || !path) continue;
    try { await access(path); } catch { missing.push({ key, path }); }
  }
  return missing;
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

function ffEscape(path) {
  return String(path).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
}

export function runFfmpeg(ffmpeg, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-3000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise() : reject(fail(`ffmpeg exited ${code}: ${stderr.slice(-800)}`, 'FFMPEG_FAILED')));
  });
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function titleFilters(shot, font, width, height, textFiles) {
  return shot.titles.flatMap((t, i) => {
    const enable = `enable='between(t,${t.start},${t.end})'`;
    const main = textFiles[`${i}-main`];
    const size = Math.round(height / (t.kind === 'banner' ? 14 : 20));
    const base = `fontfile='${ffEscape(font)}':fontcolor=white:fontsize=${size}:borderw=2:bordercolor=black@0.6`;
    if (t.kind === 'banner') {
      return [`drawbox=x=0:y=ih*0.08:w=iw:h=${Math.round(size * 1.8)}:color=black@0.45:t=fill:${enable}`,
        `drawtext=${base}:textfile='${ffEscape(main)}':x=(w-text_w)/2:y=h*0.08+${Math.round(size * 0.4)}:${enable}`];
    }
    const out = [`drawbox=x=iw*0.05:y=ih*0.76:w=iw*0.6:h=${Math.round(size * (t.subtext ? 2.8 : 1.7))}:color=black@0.5:t=fill:${enable}`,
      `drawtext=${base}:textfile='${ffEscape(main)}':x=w*0.07:y=h*0.76+${Math.round(size * 0.35)}:${enable}`];
    if (t.subtext) out.push(`drawtext=fontfile='${ffEscape(font)}':fontcolor=white@0.85:fontsize=${Math.round(size * 0.65)}:textfile='${ffEscape(textFiles[`${i}-sub`])}':x=w*0.07:y=h*0.76+${Math.round(size * 1.7)}:${enable}`);
    return out;
  });
}

// Step 1+2 per clip: grade (media-finisher graph + optional LUT) and burn titles.
export async function finishClip({ ffmpeg, input, output, shot, assets, width, height, workdir, grainStrength = 6 }) {
  const textFiles = {};
  for (const [i, t] of shot.titles.entries()) {
    textFiles[`${i}-main`] = join(workdir, `${shot.id}-t${i}.txt`);
    await writeFile(textFiles[`${i}-main`], t.text);
    if (t.subtext) { textFiles[`${i}-sub`] = join(workdir, `${shot.id}-t${i}s.txt`); await writeFile(textFiles[`${i}-sub`], t.subtext); }
  }
  const grade = cinematicFinishingFilterGraph(width, height, { VIDEO_OS_COLOR_LUT_PATH: assets.lut || '', VIDEO_OS_FILM_GRAIN_STRENGTH: grainStrength });
  const vf = [grade, ...titleFilters(shot, assets.font, width, height, textFiles), `fps=${FPS}`, 'settb=AVTB', 'format=yuv420p'].join(',');
  await runFfmpeg(ffmpeg, ['-i', input, '-t', String(shot.duration), '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', output]);
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

// Steps 3-5: transitions, logo, music ducked under voice, loudness, mux.
export async function assembleFinal({ ffmpeg, clips, durations, brief, assets, output }) {
  const { graph, duration } = xfadeGraph(durations, brief.transitions);
  const args = [];
  clips.forEach(clip => args.push('-i', clip));
  let idx = clips.length;
  const voiceIdx = idx++; args.push('-i', assets.voice);
  let musicIdx = null; if (assets.music) { musicIdx = idx++; args.push('-stream_loop', '-1', '-i', assets.music); }
  let logoIdx = null; if (assets.logo) { logoIdx = idx++; args.push('-i', assets.logo); }
  const filters = [graph];
  let video = '[vout]';
  if (logoIdx !== null) { filters.push(`[${logoIdx}:v]scale=-1:80[logo];${video}[logo]overlay=W-w-40:40[vlogo]`); video = '[vlogo]'; }
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
  await runFfmpeg(ffmpeg, args);
  return { duration };
}

// Runway step. `runwayDeps` must be supplied by the caller (CLI live mode or tests).
// Each task id is written to the receipt ledger before polling (QA M2); a
// timeout/abort/unknown outcome stops the run and leaves the id recorded as
// unresolved so it can be checked later instead of being resubmitted.
export async function generateClips(plan, { brief, briefDir, assetsRoot, runwayEnv, runwayDeps, clipsDir, ledger }) {
  await mkdir(clipsDir, { recursive: true });
  const results = [];
  for (const [i, shot] of plan.shots.entries()) {
    const writer = async (_classification, pathname, bytes) => {
      await writeFile(join(clipsDir, basename(pathname)), bytes);
      return { pathname };
    };
    const input = brief.shots[i].promptImage
      ? { ...shot.input, promptImage: await loadShotImage(brief.shots[i].promptImage, { briefDir, assetsRoot }) }
      : shot.input;
    const job = { id: shot.id, accountId: 'local', reservedCredits: shot.credits };
    const deps = { ...runwayDeps, env: { ...planEnv(), ...runwayEnv }, putPrivateBlob: writer,
      onTaskCreated: async ({ taskId }) => ledger.record(shot.id, { taskId, status: 'submitted', credits: shot.credits, model: shot.model }) };
    let result;
    try {
      const created = await createRunwayTask(job, input, deps);
      result = await awaitRunwayTask(job, created, deps);
    } catch (error) {
      await ledger.record(shot.id, { taskId: error.providerTaskId ?? ledger.taskId(shot.id), status: error.unresolved ? 'unresolved' : 'failed', errorCode: error.code, providerFailureCode: error.providerFailureCode || null });
      throw error;
    }
    await ledger.record(shot.id, { taskId: result.providerTaskId, status: 'stored', sha256: result.sha256 });
    results.push({ ...shot, file: join(clipsDir, basename(result.privatePathname)), sha256: result.sha256, providerTaskId: result.providerTaskId });
  }
  return results;
}

// Small JSON ledger written to <out>/receipt.json as tasks progress.
export function createLedger(path, base) {
  const state = { ...base, status: 'running', tasks: {} };
  return {
    state,
    taskId: id => state.tasks[id]?.taskId ?? null,
    async record(id, patch) {
      state.tasks[id] = { ...(state.tasks[id] || {}), ...patch, updatedAt: new Date().toISOString() };
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    },
    async finish(patch) {
      Object.assign(state, patch);
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    },
  };
}

export async function runPipeline({ brief, briefDir, plan, outDir, assets, ffmpeg, runwayEnv, runwayDeps }) {
  const { width, height } = ASPECTS[brief.aspect];
  const workdir = join(outDir, 'work');
  await mkdir(workdir, { recursive: true });
  const receiptPath = join(outDir, 'receipt.json');
  const ledger = createLedger(receiptPath, { version: 'luxify-local-receipt/v1', slug: brief.slug, createdAt: new Date().toISOString(), plannedCredits: plan.totalCredits, plannedEstUsd: plan.totalEstUsd, caps: plan.caps });
  await ledger.finish({});
  let clips;
  try {
    clips = await generateClips(plan, { brief, briefDir: briefDir || process.cwd(), assetsRoot: assets.root, runwayEnv, runwayDeps, clipsDir: join(outDir, 'clips'), ledger });
  } catch (error) {
    await ledger.finish({ status: 'aborted', errorCode: error.code || 'ERROR' });
    throw error;
  }
  const finished = [];
  for (const [i, clip] of clips.entries()) {
    const output = join(workdir, `${String(i).padStart(2, '0')}-${clip.id}.mp4`);
    await finishClip({ ffmpeg, input: clip.file, output, shot: brief.shots[i], assets, width, height, workdir });
    finished.push(output);
  }
  const finalPath = join(outDir, 'final.mp4');
  const { duration } = await assembleFinal({ ffmpeg, clips: finished, durations: brief.shots.map(s => s.duration), brief, assets, output: finalPath });
  const info = await stat(finalPath);
  if (!info.size) throw fail('ffmpeg produced an empty final.mp4.', 'FINAL_EMPTY');
  const assetHash = async path => (path ? { file: basename(path), sha256: await sha256File(path) } : null);
  const receipt = {
    ...ledger.state,
    status: 'complete',
    shots: clips.map(c => ({ id: c.id, briefModel: c.briefModel, model: c.model, mode: c.mode, duration: c.duration, ratio: c.ratio, credits: c.credits, estUsd: c.estUsd, clipSha256: c.sha256, providerTaskId: c.providerTaskId })),
    totalCredits: plan.totalCredits,
    totalEstUsd: plan.totalEstUsd,
    caps: plan.caps,
    assets: { font: await assetHash(assets.font), lut: await assetHash(assets.lut), music: await assetHash(assets.music), logo: await assetHash(assets.logo), voice: await assetHash(assets.voice), voiceSource: brief.voice.source, heygenJobId: brief.voice.jobId || null },
    final: { file: 'final.mp4', bytes: info.size, sha256: await sha256File(finalPath), durationSeconds: duration },
  };
  await ledger.finish(receipt);
  return ledger.state;
}

export async function loadBriefFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
