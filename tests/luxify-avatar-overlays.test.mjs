import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AI_DISCLOSURE_TEXT, HEYGEN_AVATAR_USD_PER_SECOND, parseBrief } from '../lib/luxify-local-brief.js';
import { finishClip, planBrief, resolveAssets, resolveFfmpeg, runPipeline } from '../services/luxify-local-pipeline.js';
import { buildCues, disclosureBox, disclosureFilters, kineticFilters, layout, themeTokens, toSrt, toVtt, wavDurationSeconds } from '../services/luxify-local-overlays.js';
import { main } from '../tools/luxify-local.mjs';

const FONT_SRC = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'].find(p => existsSync(p));
let ffmpeg = null;
try { ffmpeg = resolveFfmpeg(undefined, process.env); } catch { ffmpeg = null; }
const skipFf = !ffmpeg || !FONT_SRC ? 'no ffmpeg with drawtext or no font' : false;
const TASK = n => `11111111-2222-3333-4444-${String(n).padStart(12, '0')}`;
const esc = v => v;

function avatarBrief(overrides = {}) {
  return {
    version: 'luxify-local/v1', slug: 'avatar-unit', title: 'Avatar unit', aspect: '16:9',
    script: 'No camera. No studio... Meet LUX Video OS.',
    shots: [
      { id: 'kd-open', model: 'heygen_avatar', clip: 'avatar.mp4', duration: 3, titles: [{ kind: 'lower_third', text: 'Kristian', subtext: 'LUX Video OS', start: 0.2, end: 2.5 }] },
      { id: 'enroll', model: 'runway', prompt: 'p', duration: 2, titles: [] },
    ],
    transitions: [],
    fontPreset: 'lux-sans-bold', lut: null, music: null, logoOverlay: 'logo.png',
    voice: { source: 'heygen_audio_file', path: 'voice.wav' },
    theme: 'light', captionStyle: 'kinetic',
    captions: [{ text: 'No camera.', start: 0.2, end: 1.2 }, { text: 'Meet LUX.', start: 3.1, end: 4.6 }],
    endCard: { enabled: true, duration: 2, cta: 'Sign up today', url: 'luxvideo.os' },
    ...overrides,
  };
}

test('schema: heygen_avatar / local_clip shots, themes, captions, end card; disclosure cannot be disabled', () => {
  const b = parseBrief(avatarBrief());
  assert.equal(b.shots[0].model, 'heygen_avatar');
  assert.equal(b.shots[0].clipStart, 0);
  assert.equal(b.bug.enabled, true);
  assert.equal(b.subtitles.sidecar, true);
  const v1 = parseBrief({ ...avatarBrief(), theme: undefined, captionStyle: undefined, captions: undefined, endCard: undefined });
  assert.equal(v1.theme, 'dark');
  assert.equal(v1.captionStyle, 'none');
  assert.equal(v1.endCard.enabled, false);
  const bad = [
    avatarBrief({ disclosure: false }),
    avatarBrief({ aiLabel: false }),
    avatarBrief({ theme: 'neon' }),
    avatarBrief({ captionStyle: 'karaoke' }),
    avatarBrief({ shots: [{ id: 'x', model: 'heygen_avatar', clip: 'x.png', duration: 3 }] }),
    avatarBrief({ shots: [{ id: 'x', model: 'heygen_avatar', clip: 'https://heygen.com/x.mp4', duration: 3 }] }),
    avatarBrief({ shots: [{ id: 'x', model: 'heygen_avatar', clip: '../x.mp4', duration: 3 }] }),
    avatarBrief({ shots: [{ id: 'x', model: 'heygen_avatar', clip: 'x.mp4', duration: 16 }] }),
    avatarBrief({ shots: [{ id: 'x', model: 'heygen_avatar', clip: 'x.mp4', duration: 3, prompt: 'p' }] }),
    avatarBrief({ captions: [{ text: 'late', start: 4.5, end: 5.5 }] }),
    avatarBrief({ captions: [{ text: 'a', start: 1, end: 2 }, { text: 'b', start: 1.5, end: 2.5 }] }),
    avatarBrief({ captions: [{ text: 'too long', start: 0, end: 4.5 }] }),
    avatarBrief({ endCard: { enabled: true, duration: 9 } }),
    avatarBrief({ endCard: { enabled: true, url: 'https://x.com' } }),
  ];
  for (const value of bad) assert.throws(() => parseBrief(value), { code: 'BRIEF_INVALID' }, JSON.stringify(value).slice(0, 120));
});

test('plan: avatar shots cost 0 Runway credits, carry a HeyGen estimate, end card extends the timeline', () => {
  const plan = planBrief(parseBrief(avatarBrief()));
  assert.equal(plan.shots[0].credits, 0);
  assert.equal(plan.shots[0].mode, 'local_clip');
  assert.equal(plan.shots[0].heygenEstUsd, +(3 * HEYGEN_AVATAR_USD_PER_SECOND).toFixed(2));
  assert.equal(plan.totalCredits, 24);
  assert.equal(plan.heygenEstUsd, 0.2);
  assert.equal(plan.totalEstUsd, 0.44);
  assert.equal(plan.timelineSeconds, 7);
  assert.equal(plan.disclosure, AI_DISCLOSURE_TEXT);
  assert.equal(plan.shots[0].input, undefined);
  const local = planBrief(parseBrief(avatarBrief({ shots: [{ id: 'reuse', model: 'local_clip', clip: 'r.mp4', duration: 4 }], captions: [] })));
  assert.equal(local.totalEstUsd, 0);
  assert.equal(local.heygenEstUsd, undefined);
  // HeyGen seconds count toward the $10/video cap.
  const shots = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, model: 'runway', prompt: 'p', duration: 8 }));
  assert.throws(() => planBrief(parseBrief(avatarBrief({ captions: [], shots: [...shots, { id: 'kd', model: 'heygen_avatar', clip: 'a.mp4', duration: 8 }] }))), { code: 'CAP_EXCEEDED_VIDEO' });
  assert.ok(plan.warnings.length === 0);
  assert.match(planBrief(parseBrief(avatarBrief({ captions: [{ text: 'one two three four', start: 0, end: 1 }] }))).warnings[0], /KINETIC_LONG_BEAT/);
});

test('overlays: themes, disclosure bottom-left on its own plate, bug never in the same corner', () => {
  assert.notEqual(themeTokens('dark').text, themeTokens('light').text);
  assert.throws(() => themeTokens('auto'), { code: 'THEME_INVALID' });
  for (const [w, h] of [[1280, 720], [720, 1280]]) {
    const d = disclosureBox(w, h);
    assert.ok(d.x < w / 2 && d.y > h / 2, 'disclosure is bottom-left');
    assert.ok(d.y + d.h <= h && d.x + d.w <= w);
    assert.ok(layout(w, h).bug.y * h < h / 2, 'bug is in the top half');
  }
  const f = disclosureFilters({ font: 'f.ttf', width: 1280, height: 720, theme: 'light', textFile: 'disc.txt', esc });
  assert.match(f[0], /^drawbox=.*color=white@0\.85/);
  assert.match(f[1], /textfile=disc\.txt/);
  assert.ok(f.every(x => !x.includes('enable=')), 'disclosure is always on');
  const k = kineticFilters([{ text: 'No camera.', start: 1, end: 2 }], { font: 'f.ttf', width: 1280, height: 720, theme: 'dark', textFile: () => 'c0.txt', esc });
  assert.match(k[0], /expansion=none:textfile=c0\.txt:fontcolor=white/);
  assert.match(k[0], /enable='between\(t,1,2\)'/);
});

test('sidecars: verbatim script, timed over the voice, valid VTT and SRT', () => {
  const script = 'No camera. No studio...\nMeet LUX Video OS.\n\nEnroll your presenter once... with recorded consent, and a very long clause that must wrap onto two lines.';
  const cues = buildCues(script, 9);
  assert.equal(cues[0].start, 0);
  assert.equal(cues.at(-1).end, 9);
  assert.equal(cues.map(c => c.text.replace(/\n/g, ' ')).join(' '), script.replace(/\s+/g, ' ').trim());
  assert.ok(cues.every(c => c.text.split('\n').every(l => l.length <= 42) && c.text.split('\n').length <= 2));
  const vtt = toVtt(cues);
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:0\d\.\d{3}/);
  const srt = toSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.ok(!toVtt([{ start: 0, end: 1, text: 'a --> b <i>' }]).includes('a --> b'));
});

test('wavDurationSeconds reads PCM headers and ignores other files', () => {
  const rate = 48000, seconds = 1.5, bytes = rate * 2 * seconds;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  assert.equal(wavDurationSeconds(Buffer.concat([h, Buffer.alloc(bytes)])), 1.5);
  assert.equal(wavDurationSeconds(Buffer.from('ID3 mp3 bytes...........................................')), null);
});

function ff(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, String(r.stderr));
}
function probe(file) { return spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr; }
function seconds(info) { const d = info.match(/Duration: (\d+):(\d+):([\d.]+)/); return Number(d[2]) * 60 + Number(d[3]); }

async function setup(dir, { logo }) {
  const assets = join(dir, 'assets');
  for (const sub of ['fonts', 'overlays']) await mkdir(join(assets, sub), { recursive: true });
  await copyFile(FONT_SRC, join(assets, 'fonts', 'lux-sans-bold.ttf'));
  if (logo) ff(['-f', 'lavfi', '-i', 'color=c=red:s=200x80', '-frames:v', '1', join(assets, 'overlays', 'logo.png')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4.5:sample_rate=48000', join(dir, 'voice.wav')]);
  // Portrait 720x1280-style avatar clip WITH its own audio (must be dropped).
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=25:duration=2.5', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2.5', '-shortest', '-pix_fmt', 'yuv420p', join(dir, 'avatar.mp4')]);
  const runwayClip = join(dir, 'rw.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=2', '-pix_fmt', 'yuv420p', runwayClip]);
  return { assets, runwayBytes: await readFile(runwayClip) };
}

function mockRunway(bytes, calls) {
  return {
    clientFactory: async () => ({
      textToVideo: { create: async body => { calls.push(body); return { id: TASK(calls.length) }; } },
      imageToVideo: { create: async () => { throw new Error('unexpected'); } },
      tasks: { retrieve: id => ({ waitForTaskOutput: async () => ({ id, status: 'SUCCEEDED', output: [`https://dnznrvs05pmza.cloudfront.net/${id}.mp4?_jwt=x`] }) }), delete: async () => {} },
    }),
    sdkErrors: async () => ({ TaskFailedError: class extends Error {}, TaskTimedOutError: class extends Error {}, AbortError: class extends Error {} }),
    fetchImpl: async () => { let sent = false; return { ok: true, headers: new Map(), body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: new Uint8Array(bytes) })), cancel: async () => {} }) } }; },
  };
}

test('e2e: avatar + mocked Runway shot, light theme, kinetic captions, logo missing -> bug skipped, text-only end card, sidecars', { skip: skipFf, timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "lux avatar's [e2e]-"));
  try {
    const { assets, runwayBytes } = await setup(dir, { logo: false });
    const brief = parseBrief(avatarBrief());
    const plan = planBrief(brief);
    const calls = [];
    const outDir = join(dir, 'render');
    const receipt = await runPipeline({ brief, briefDir: dir, plan, outDir, assets: resolveAssets(brief, assets, dir), ffmpeg, runwayEnv: { VIDEO_OS_RUNWAY_ENABLED: 'true', RUNWAYML_API_SECRET: 'k_test' }, runwayDeps: mockRunway(runwayBytes, calls) });
    assert.equal(calls.length, 1, 'only the Runway shot is submitted');
    const info = probe(join(outDir, 'final.mp4'));
    assert.match(info, /Video: h264.*1280x720/);
    assert.equal((info.match(/Audio:/g) || []).length, 1, 'one audio stream (the master voice mix)');
    assert.ok(Math.abs(seconds(info) - 7) < 0.25, `duration ${seconds(info)}`);
    assert.equal(receipt.overlays.bug, 'skipped-logo-missing');
    assert.equal(receipt.overlays.endCard, 'text-only');
    assert.equal(receipt.overlays.theme, 'light');
    assert.equal(receipt.overlays.disclosure, AI_DISCLOSURE_TEXT);
    assert.equal(receipt.assets.logo, null);
    assert.equal(receipt.shots[0].credits, 0);
    assert.equal(receipt.shots[0].clipFile, 'avatar.mp4');
    assert.equal(receipt.heygenEstUsd, 0.2);
    assert.equal(receipt.final.contentSeconds, 5);
    const vtt = await readFile(join(outDir, 'final.vtt'), 'utf8');
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /Meet LUX Video OS\./);
    assert.match(await readFile(join(outDir, 'final.srt'), 'utf8'), /^1\n00:00:00,000/);
    assert.match(receipt.overlays.sidecars.vtt.sha256, /^[0-9a-f]{64}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('e2e: local-only brief renders via the CLI with --live and no Runway flag or secret; dark theme, bug + logo end card', { skip: skipFf, timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lux-local-only-'));
  try {
    const { assets } = await setup(dir, { logo: true });
    const b = avatarBrief({ theme: 'dark', captionStyle: 'both', subtitles: { burnIn: true },
      shots: [avatarBrief().shots[0], { id: 'reuse', model: 'local_clip', clip: 'avatar.mp4', clipStart: 0.5, duration: 2 }] });
    await writeFile(join(dir, 'brief.json'), JSON.stringify(b));
    let out = '';
    const res = await main(['--brief', join(dir, 'brief.json'), '--live', '--assets', assets, '--ffmpeg', ffmpeg], { env: {}, stdout: { write: s => { out += s; } } });
    assert.equal(res.mode, 'live');
    assert.equal(res.receipt.overlays.bug, 'on');
    assert.equal(res.receipt.overlays.endCard, 'logo');
    assert.equal(res.receipt.totalCredits, 0);
    assert.ok(Math.abs(seconds(probe(join(dir, 'render', 'final.mp4'))) - 7) < 0.25);
    assert.match(out, /sha256: [0-9a-f]{64}\n$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI dry run: missing avatar clip is reported as missing; a missing logo is only a warning; Runway gate still applies to Runway briefs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lux-dry-'));
  try {
    await writeFile(join(dir, 'brief.json'), JSON.stringify(avatarBrief()));
    let out = '';
    await main(['--brief', join(dir, 'brief.json'), '--assets', join(dir, 'none')], { env: {}, stdout: { write: s => { out += s; } } });
    const view = JSON.parse(out);
    assert.ok(view.missingAssets.some(m => m.key === 'clip:kd-open'));
    assert.ok(!view.missingAssets.some(m => m.key === 'logo'));
    assert.match(view.warnings.join('\n'), /LOGO_MISSING/);
    assert.equal(view.heygenEstUsd, 0.2);
    await assert.rejects(main(['--brief', join(dir, 'brief.json'), '--live'], { env: {}, stdout: { write() {} } }), { code: 'ASSETS_MISSING' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('finishClip drops clip audio and seeks clipStart for clip shots', async () => {
  const seen = [];
  const shim = join(await mkdtemp(join(tmpdir(), 'lux-shim-')), 'ff.sh');
  await writeFile(shim, '#!/bin/sh\necho "$@" > "$(dirname "$0")/args.txt"\nfor last; do :; done\nprintf x > "$last"\n', { mode: 0o755 });
  if (process.platform === 'win32') return;
  await finishClip({ ffmpeg: shim, input: 'in.mp4', output: join(tmpdir(), `o-${Date.now()}.mp4`), shot: { id: 'r', model: 'local_clip', clip: 'x.mp4', clipStart: 1.5, duration: 2, titles: [] }, assets: { font: 'f.ttf', lut: null }, width: 1280, height: 720, workdir: tmpdir() });
  const args = await readFile(join(shim, '..', 'args.txt'), 'utf8');
  seen.push(args);
  assert.match(args, /^-n -ss 1\.5 -i in\.mp4|-ss 1\.5 -i in\.mp4/);
  assert.match(args, /tpad=stop_mode=clone/);
  assert.match(args, / -an /);
});
