// Local Luxify pipeline: Runway clips (via services/runway-models.js) ->
// cinematic grade from services/media-finisher.js (LUT) -> drawtext titles ->
// xfade transitions -> music ducked under the HeyGen voice -> loudnorm ->
// final.mp4 + receipt.json. Makes no HeyGen calls. Runway is only contacted
// in live mode, which the CLI gates behind --live plus RUNWAYML_API_SECRET.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { ASPECTS, CLIP_CAP_USD, FONT_PRESETS, SHOT_MODELS, VIDEO_CAP_USD } from '../lib/luxify-local-brief.js';
import { cinematicFinishingFilterGraph } from './media-finisher.js';
import { RUNWAY_MAX_DATA_URI_BYTES, RUNWAY_USD_PER_CREDIT, awaitRunwayTask, buildRunwayRequest, createRunwayTask, imageFileToDataUri, resumeRunwayTask } from './runway-models.js';

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

// QA L2: the voice track must live in the brief folder or the assets folder.
export async function assertVoiceContained(assets, briefDir) {
  const roots = await realRoots(briefDir, assets.root);
  let real;
  try { real = await realpath(assets.voice); } catch { throw fail('Voice file not found.', 'VOICE_NOT_FOUND'); }
  if (!roots.some(root => inside(root, real))) throw fail('Voice file must be inside the brief folder or the assets folder.', 'VOICE_OUTSIDE_ROOTS');
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

export function resolveAssets(brief, assetsRoot, briefDir = process.cwd()) {
  const root = resolve(assetsRoot);
  return {
    root,
    font: join(root, 'fonts', FONT_PRESETS[brief.fontPreset]),
    lut: brief.lut ? join(root, 'luts', brief.lut) : null,
    music: brief.music ? join(root, 'music', brief.music.track) : null,
    logo: brief.logoOverlay ? join(root, 'overlays', brief.logoOverlay) : null,
    voice: resolve(briefDir, brief.voice.path),
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
export async function runFfmpeg(ffmpeg, args) {
  const output = args[args.length - 1];
  const checkOutput = output !== '-';
  if (checkOutput && await exists(output)) throw fail(`${basename(output)} already exists; refusing to overwrite.`, 'OUTPUT_EXISTS');
  await spawnFfmpeg(ffmpeg, args);
  if (checkOutput && !(await exists(output))) throw fail('ffmpeg did not write its output.', 'FFMPEG_FAILED');
}

function spawnFfmpeg(ffmpeg, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-n', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
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
    const base = `fontfile=${ffFilterPath(font)}:expansion=none:fontcolor=white:fontsize=${size}:borderw=2:bordercolor=black@0.6`;
    if (t.kind === 'banner') {
      return [`drawbox=x=0:y=ih*0.08:w=iw:h=${Math.round(size * 1.8)}:color=black@0.45:t=fill:${enable}`,
        `drawtext=${base}:textfile=${ffFilterPath(main)}:x=(w-text_w)/2:y=h*0.08+${Math.round(size * 0.4)}:${enable}`];
    }
    const out = [`drawbox=x=iw*0.05:y=ih*0.76:w=iw*0.6:h=${Math.round(size * (t.subtext ? 2.8 : 1.7))}:color=black@0.5:t=fill:${enable}`,
      `drawtext=${base}:textfile=${ffFilterPath(main)}:x=w*0.07:y=h*0.76+${Math.round(size * 0.35)}:${enable}`];
    if (t.subtext) out.push(`drawtext=fontfile=${ffFilterPath(font)}:expansion=none:fontcolor=white@0.85:fontsize=${Math.round(size * 0.65)}:textfile=${ffFilterPath(textFiles[`${i}-sub`])}:x=w*0.07:y=h*0.76+${Math.round(size * 1.7)}:${enable}`);
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
  // The LUT is inserted here (not via media-finisher's env) so its path gets
  // the full two-level escaping (QA M2).
  let grade = cinematicFinishingFilterGraph(width, height, { VIDEO_OS_COLOR_LUT_PATH: '', VIDEO_OS_FILM_GRAIN_STRENGTH: grainStrength });
  if (assets.lut) {
    const anchor = 'eq=saturation=1.14:contrast=1.06';
    if (!grade.includes(anchor)) throw fail('media-finisher grade changed; LUT insertion point missing.', 'GRADE_UNSUPPORTED');
    grade = grade.replace(anchor, `${anchor},lut3d=file=${ffFilterPath(assets.lut)}`);
  }
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

export function committedCredits(state) {
  return (state.attempts || []).filter(a => COUNTED.has(a.status)).reduce((sum, a) => sum + (a.credits || 0), 0);
}

export function pendingAttempts(state) {
  return (state.attempts || []).filter(a => PENDING.has(a.status));
}

export function createLedger(path, initial) {
  const state = { ...initial, attempts: [...(initial.attempts || [])], runs: [...(initial.runs || [])] };
  const view = () => {
    const tasks = {};
    for (const a of state.attempts) tasks[a.shotId] = { taskId: a.taskId ?? null, status: a.status, credits: a.credits, model: a.model, run: a.run, ...(a.sha256 ? { sha256: a.sha256 } : {}), ...(a.errorCode ? { errorCode: a.errorCode } : {}), ...(a.providerFailureCode ? { providerFailureCode: a.providerFailureCode } : {}) };
    return { ...state, tasks, committedCredits: committedCredits(state), committedEstUsd: +(committedCredits(state) * RUNWAY_USD_PER_CREDIT).toFixed(2) };
  };
  const save = () => writeJsonAtomic(path, view());
  return {
    state,
    view,
    latest: shotId => [...state.attempts].reverse().find(a => a.shotId === shotId) || null,
    committed: () => committedCredits(state),
    async add(attempt) { const a = { ...attempt, updatedAt: new Date().toISOString() }; state.attempts.push(a); await save(); return a; },
    async update(attempt, patch) { Object.assign(attempt, patch, { updatedAt: new Date().toISOString() }); await save(); },
    async set(patch) { Object.assign(state, patch); await save(); },
    async startRun(info) { state.run = (state.run || 0) + 1; state.status = 'running'; state.runs.push({ run: state.run, startedAt: new Date().toISOString(), ...info }); await save(); return state.run; },
    async endRun(patch) { Object.assign(state.runs[state.runs.length - 1], { endedAt: new Date().toISOString(), ...patch }); Object.assign(state, { status: patch.status }); await save(); },
  };
}

function inputHash(briefShot, planShot) {
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
    if (ledger.committed() + shot.credits > videoCap) {
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

export async function runPipeline({ brief, briefDir, plan, outDir, assets, ffmpeg, runwayEnv, runwayDeps, resume = false }) {
  const { width, height } = ASPECTS[brief.aspect];
  briefDir = briefDir || process.cwd();
  await assertVoiceContained(assets, briefDir);
  await mkdir(outDir, { recursive: true });
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
    if (prior.slug !== brief.slug) throw fail('receipt.json belongs to a different brief.', 'RECEIPT_MISMATCH');
    const historyDir = join(outDir, 'receipt-history');
    await mkdir(historyDir, { recursive: true });
    await copyFile(receiptPath, join(historyDir, `receipt-run${prior.run || 0}-${Date.now()}.json`), fsConstants.COPYFILE_EXCL);
  } else if (resume) {
    throw fail('--resume was given but there is no receipt.json in the output folder.', 'RESUME_NO_RECEIPT');
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
  try {
    clips = await generateClips(plan, { brief, briefDir, assetsRoot: assets.root, runwayEnv, runwayDeps, clipsDir: join(outDir, 'clips'), ledger, run });
    const finished = [];
    for (const [i, clip] of clips.entries()) {
      const output = join(workdir, `${String(i).padStart(2, '0')}-${clip.id}.mp4`);
      await finishClip({ ffmpeg, input: clip.file, output, shot: brief.shots[i], assets, width, height, workdir });
      finished.push(output);
    }
    ({ duration } = await assembleFinal({ ffmpeg, clips: finished, durations: brief.shots.map(s => s.duration), brief, assets, output: finalPath }));
  } catch (error) {
    try { await ledger.endRun({ status: 'aborted', errorCode: error.code || 'ERROR' }); } catch { /* keep original error */ }
    throw error;
  }
  const info = await stat(finalPath);
  if (!info.size) throw fail('ffmpeg produced an empty final video.', 'FINAL_EMPTY');
  const assetHash = async path => (path ? { file: basename(path), sha256: await sha256File(path) } : null);
  await ledger.set({
    shots: clips.map(c => ({ id: c.id, briefModel: c.briefModel, model: c.model, mode: c.mode, duration: c.duration, ratio: c.ratio, credits: c.credits, estUsd: c.estUsd, clipSha256: c.sha256, providerTaskId: c.providerTaskId, reused: c.reused })),
    totalCredits: plan.totalCredits,
    totalEstUsd: plan.totalEstUsd,
    caps: plan.caps,
    assets: { font: await assetHash(assets.font), lut: await assetHash(assets.lut), music: await assetHash(assets.music), logo: await assetHash(assets.logo), voice: await assetHash(assets.voice), voiceSource: brief.voice.source, heygenJobId: brief.voice.jobId || null },
    final: { file: finalName, bytes: info.size, sha256: await sha256File(finalPath), durationSeconds: duration },
  });
  await ledger.endRun({ status: 'complete' });
  return ledger.view();
}

export async function loadBriefFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
