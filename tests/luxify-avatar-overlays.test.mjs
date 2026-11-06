import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AI_DISCLOSURE_TEXT, AVATAR_CONSENT_VERSION, HEYGEN_AVATAR_USD_PER_SECOND, parseBrief } from '../lib/luxify-local-brief.js';
import { LOCK_FILE, MAX_LOGO_BYTES, createLedger, finishClip, generateClips, loadAvatarConsent, planBrief, resolveAssets, resolveFfmpeg, runFfmpeg, runPipeline, validateLogo } from '../services/luxify-local-pipeline.js';
import { KINETIC_EM_WIDTH, buildCues, disclosureBox, disclosureFilters, kineticFilters, kineticFontSize, layout, sanitizeCueText, subtitleBox, themeTokens, toSrt, toVtt, wavDurationSeconds } from '../services/luxify-local-overlays.js';
import { main } from '../tools/luxify-local.mjs';

const FONT_SRC = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf'].find(p => existsSync(p));
let ffmpeg = null;
try { ffmpeg = resolveFfmpeg(undefined, process.env); } catch { ffmpeg = null; }
const skipFf = !ffmpeg || !FONT_SRC ? 'no ffmpeg with drawtext or no font' : false;
const TASK = n => `11111111-2222-3333-4444-${String(n).padStart(12, '0')}`;
const esc = v => v;
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const consentRecord = (over = {}) => ({ version: AVATAR_CONSENT_VERSION, subject: 'Test Presenter', consentedAt: '2026-11-01', method: 'recorded_verbal', scope: ['ai_avatar_video', 'ai_voice'], recordedBy: 'QA fixture', ...over });

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
    avatarConsent: { record: 'consent.json' },
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
    // QA M4: avatar shots without a consent reference are rejected at parse time.
    avatarBrief({ avatarConsent: undefined }),
    avatarBrief({ avatarConsent: { record: 'consent.txt' } }),
    avatarBrief({ avatarConsent: { record: 'https://x.com/c.json' } }),
  ];
  for (const value of bad) assert.throws(() => parseBrief(value), { code: 'BRIEF_INVALID' }, JSON.stringify(value).slice(0, 120));
});

test('plan: avatar shots cost 0 Runway credits, carry a HeyGen estimate, end card extends the timeline', () => {
  const plan = planBrief(parseBrief(avatarBrief()));
  assert.equal(plan.shots[0].credits, 0);
  assert.equal(plan.shots[0].mode, 'local_clip');
  assert.equal(plan.shots[0].heygenEstUsd, +(3 * HEYGEN_AVATAR_USD_PER_SECOND).toFixed(2));
  assert.equal(plan.totalCredits, 24);
  assert.equal(plan.heygenEstUsd, 0.25);
  assert.equal(plan.totalEstUsd, 0.49);
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
  // QA M2: one drawtext whose own box=1 plate sizes to the text.
  assert.equal(f.length, 1);
  assert.match(f[0], /^drawtext=.*expansion=none:textfile=disc\.txt:.*:box=1:boxcolor=white@0\.85:boxborderw=\d+/);
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

test('B1: VTT and SRT cue text is fully sanitised (no tags, arrows, comment markers or blank lines)', () => {
  const nasty = 'a --> b --!> c <!-- d --> <i>x</i> <script>e</script> & f ---- g\n\nh\u0007 ＜b＞';
  const clean = sanitizeCueText(nasty);
  assert.doesNotMatch(clean, /[<>＜＞]|--|\n\n|\u0007/);
  const ARROW = ' -' + '-> ';
  const isTiming = (l) => {
    const parts = l.split(ARROW);
    if (parts.length !== 2) return false;
    const ts = (t) => t.length === 12 && Number.isFinite(Number(t.slice(0, 2) + t.slice(3, 5) + t.slice(6, 8) + t.slice(9)));
    const right = parts[1].endsWith(' line:82%') ? parts[1].slice(0, -9) : parts[1];
    return ts(parts[0]) && ts(right);
  };
  for (const out of [toVtt([{ start: 0, end: 1, text: nasty }]), toSrt([{ start: 0, end: 1, text: nasty }])]) {
    const cueLines = out.split('\n').filter(l => !isTiming(l));
    assert.ok(cueLines.length < out.split('\n').length, 'timing lines present');
    for (const l of cueLines) {
      assert.ok(!l.includes('<') && !l.includes('>') && !l.includes('-' + '-'), `unsafe cue line: ${JSON.stringify(l)}`);
    }
  }
  assert.match(toVtt([{ start: 0, end: 1, text: 'a & b' }]), /a &amp; b/);
  assert.match(toSrt([{ start: 0, end: 1, text: '<i>x</i>' }]), /\nx\n$/);
});

test('L4/L5: label, subtitles and kinetic lines never collide or overflow; theme lookup uses own keys only', () => {
  for (const [w, h] of [[1280, 720], [720, 1280]]) {
    const d = disclosureBox(w, h);
    for (const text of ['one line', 'line one\nline two']) {
      const b = subtitleBox(text, w, h);
      assert.ok(b.y + b.h <= d.y, `${w}x${h}: subtitle plate ends at ${b.y + b.h}, label starts at ${d.y}`);
      assert.ok(b.y > h / 2);
    }
    const long = 'x'.repeat(40);
    assert.ok(kineticFontSize(long, w, h) * KINETIC_EM_WIDTH * 40 <= w * 0.9, `${w}x${h}: 40-char kinetic line fits`);
    assert.equal(kineticFontSize('Hi', w, h), layout(w, h).kineticSize);
    assert.ok(d.x + d.w <= w && d.y + d.h <= h);
  }
  const k = kineticFilters([{ text: 'x'.repeat(40), start: 0, end: 1 }], { font: 'f', width: 720, height: 1280, theme: 'dark', textFile: () => 't', esc });
  assert.match(k[0], new RegExp(`fontsize=${kineticFontSize('x'.repeat(40), 720, 1280)}:`));
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, 1]) {
    if (bad === undefined) { assert.ok(themeTokens(bad)); continue; }
    assert.throws(() => themeTokens(bad), { code: 'THEME_INVALID' }, String(bad));
  }
});

test('L2: the per-clip cap binds for avatar shots (13 s at the measured rate)', () => {
  const brief = n => parseBrief(avatarBrief({ captions: [], endCard: { enabled: false }, shots: [{ id: 'kd', model: 'heygen_avatar', clip: 'a.mp4', duration: n }] }));
  assert.ok(12 * HEYGEN_AVATAR_USD_PER_SECOND <= 1 && 13 * HEYGEN_AVATAR_USD_PER_SECOND > 1);
  assert.equal(planBrief(brief(12)).heygenEstUsd, 1);
  assert.throws(() => planBrief(brief(13)), { code: 'CAP_EXCEEDED_CLIP' });
  assert.throws(() => planBrief(brief(15)), { code: 'CAP_EXCEEDED_CLIP' });
});

test('M4: avatar consent record is required, contained, current and covers video + voice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lux-consent-'));
  const outside = await mkdtemp(join(tmpdir(), 'lux-consent-out-'));
  try {
    const brief = parseBrief(avatarBrief());
    const opts = { briefDir: dir, assetsRoot: join(dir, 'assets'), now: Date.parse('2026-11-02T12:00:00Z') };
    await assert.rejects(loadAvatarConsent(brief, opts), { code: 'AVATAR_CONSENT_MISSING' });
    await assert.rejects(loadAvatarConsent({ ...brief, avatarConsent: undefined }, opts), { code: 'AVATAR_CONSENT_MISSING' });
    const write = v => writeFile(join(dir, 'consent.json'), typeof v === 'string' ? v : JSON.stringify(v));
    await write('{not json');
    await assert.rejects(loadAvatarConsent(brief, opts), { code: 'AVATAR_CONSENT_INVALID' });
    for (const over of [{ scope: ['ai_avatar_video'] }, { version: 'v0' }, { method: 'assumed' }, { consentedAt: '2027-01-01' }, { withdrawn: true }, { extra: 1 }, { subject: '' }]) {
      await write(consentRecord(over));
      await assert.rejects(loadAvatarConsent(brief, opts), { code: 'AVATAR_CONSENT_INVALID' }, JSON.stringify(over));
    }
    await write(consentRecord({ expiresAt: '2026-11-01T23:59:59Z' }));
    await assert.rejects(loadAvatarConsent(brief, opts), { code: 'AVATAR_CONSENT_EXPIRED' });
    await write(' '.repeat(70 * 1024));
    await assert.rejects(loadAvatarConsent(brief, opts), { code: 'AVATAR_CONSENT_INVALID' });
    await writeFile(join(outside, 'c.json'), JSON.stringify(consentRecord()));
    if (process.platform !== 'win32') {
      await rm(join(dir, 'consent.json'));
      await symlink(join(outside, 'c.json'), join(dir, 'consent.json'));
      await assert.rejects(loadAvatarConsent(brief, opts), { code: 'AVATAR_CONSENT_OUTSIDE_ROOTS' });
      await rm(join(dir, 'consent.json'));
    }
    await write(consentRecord({ expiresAt: '2027-11-01' }));
    const ok = await loadAvatarConsent(brief, opts);
    assert.equal(ok.file, 'consent.json');
    assert.match(ok.sha256, /^[0-9a-f]{64}$/);
    assert.equal(await loadAvatarConsent(parseBrief(avatarBrief({ avatarConsent: undefined, shots: [{ id: 'r', model: 'local_clip', clip: 'r.mp4', duration: 4 }], captions: [] })), opts), null, 'local_clip-only briefs need no consent');
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('M1/L3: logo must be a contained, size-capped PNG; corrupt, oversized, symlinked-out logos are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lux-logo-'));
  try {
    const root = join(dir, 'assets');
    await mkdir(join(root, 'overlays'), { recursive: true });
    const logo = join(root, 'overlays', 'logo.png');
    assert.equal(await validateLogo(logo, root), null, 'missing logo is skipped');
    assert.equal(await validateLogo(null, root), null);
    await writeFile(logo, 'not a png at all, just text................');
    await assert.rejects(validateLogo(logo, root), { code: 'LOGO_INVALID' });
    const huge = Buffer.from(PNG_1PX); huge.writeUInt32BE(100000, 16);
    await writeFile(logo, huge);
    await assert.rejects(validateLogo(logo, root), { code: 'LOGO_INVALID' });
    await writeFile(logo, Buffer.concat([PNG_1PX, Buffer.alloc(MAX_LOGO_BYTES)]));
    await assert.rejects(validateLogo(logo, root), { code: 'LOGO_INVALID' });
    await writeFile(logo, PNG_1PX);
    assert.ok(await validateLogo(logo, root));
    if (process.platform !== 'win32') {
      await writeFile(join(dir, 'elsewhere.png'), PNG_1PX);
      await rm(logo);
      await symlink(join(dir, 'elsewhere.png'), logo);
      await assert.rejects(validateLogo(logo, root), { code: 'LOGO_OUTSIDE_ROOTS' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M1: ffmpeg is killed on timeout, partial and empty outputs are removed, the run lock is released', { skip: process.platform === 'win32' ? 'posix shim' : false, timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lux-timeout-'));
  try {
    const hang = join(dir, 'hang.sh');
    await writeFile(hang, '#!/bin/sh\nfor last; do :; done\n: > "$last"\nexec sleep 30\n');
    const empty = join(dir, 'empty.sh');
    await writeFile(empty, '#!/bin/sh\nfor last; do :; done\n: > "$last"\n');
    await chmod(hang, 0o755); await chmod(empty, 0o755);
    const t0 = Date.now();
    await assert.rejects(runFfmpeg(hang, ['-i', 'x', join(dir, 'a.mp4')], { timeoutMs: 300 }), { code: 'FFMPEG_TIMEOUT' });
    assert.ok(Date.now() - t0 < 10000);
    assert.ok(!existsSync(join(dir, 'a.mp4')), 'partial output removed');
    await assert.rejects(runFfmpeg(empty, ['-i', 'x', join(dir, 'b.mp4')]), { code: 'FFMPEG_EMPTY_OUTPUT' });
    assert.ok(!existsSync(join(dir, 'b.mp4')), '0-byte output removed');
    // Full pipeline: a hung ffmpeg aborts the run, releases the lock, leaves no final.
    const assets = join(dir, 'assets');
    await mkdir(join(assets, 'fonts'), { recursive: true });
    await writeFile(join(assets, 'fonts', 'lux-sans-bold.ttf'), readFileSync(new URL('./fixtures/fonts/ofl-test-bold.ttf', import.meta.url)));
    await writeFile(join(dir, 'voice.wav'), 'x');
    await writeFile(join(dir, 'r.mp4'), 'x');
    const brief = parseBrief(avatarBrief({ logoOverlay: null, avatarConsent: undefined, captions: [], endCard: { enabled: false }, shots: [{ id: 'r', model: 'local_clip', clip: 'r.mp4', duration: 2 }] }));
    const outDir = join(dir, 'render');
    await assert.rejects(runPipeline({ brief, briefDir: dir, plan: planBrief(brief), outDir, assets: resolveAssets(brief, assets, dir), ffmpeg: hang, ffmpegTimeoutMs: 300, runwayEnv: {}, runwayDeps: {} }), { code: 'FFMPEG_TIMEOUT' });
    assert.ok(!existsSync(join(outDir, LOCK_FILE)), 'lock released');
    assert.deepEqual((await readdir(outDir)).filter(n => /^final/.test(n)), []);
    assert.equal(JSON.parse(await readFile(join(outDir, 'receipt.json'), 'utf8')).status, 'aborted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('M1: a corrupt logo is refused before the lock, so nothing hangs and no final is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lux-badlogo-'));
  try {
    const assets = join(dir, 'assets');
    for (const sub of ['fonts', 'overlays']) await mkdir(join(assets, sub), { recursive: true });
    await writeFile(join(assets, 'fonts', 'lux-sans-bold.ttf'), readFileSync(new URL('./fixtures/fonts/ofl-test-bold.ttf', import.meta.url)));
    await writeFile(join(assets, 'overlays', 'logo.png'), 'GIF89a not a png..........');
    await writeFile(join(dir, 'voice.wav'), 'x');
    const brief = parseBrief(avatarBrief({ avatarConsent: undefined, captions: [], shots: [{ id: 'r', model: 'local_clip', clip: 'r.mp4', duration: 2 }] }));
    const outDir = join(dir, 'render');
    await assert.rejects(runPipeline({ brief, briefDir: dir, plan: planBrief(brief), outDir, assets: resolveAssets(brief, assets, dir), ffmpeg: '/nonexistent/ffmpeg', runwayEnv: {}, runwayDeps: {} }), { code: 'LOGO_INVALID' });
    assert.ok(!existsSync(join(outDir, LOCK_FILE)));
    assert.ok(!existsSync(join(outDir, 'final.mp4')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('L1: HeyGen avatar spend counts toward the cumulative $10 ledger once per clip, across runs and resumes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lux-ledger-'));
  try {
    await writeFile(join(dir, 'a.mp4'), 'avatar-a');
    await writeFile(join(dir, 'b.mp4'), 'avatar-b');
    const brief = parseBrief(avatarBrief({ captions: [], endCard: { enabled: false }, shots: [{ id: 'kd', model: 'heygen_avatar', clip: 'a.mp4', duration: 3 }] }));
    const plan = planBrief(brief);
    const receiptPath = join(dir, 'receipt.json');
    // 970 Runway credits ($9.70) already committed in earlier runs.
    const ledger = createLedger(receiptPath, { version: 'luxify-local-receipt/v2', slug: brief.slug, run: 1, attempts: [{ shotId: 'old', run: 1, status: 'spent', taskId: 't', credits: 970 }] });
    const args = { brief, briefDir: dir, assetsRoot: dir, runwayEnv: {}, runwayDeps: {}, clipsDir: join(dir, 'clips'), ledger, run: 2 };
    const first = await generateClips(plan, args);
    assert.equal(first.length, 1);
    assert.equal(ledger.committedUsd(), 9.95);
    assert.equal(ledger.view().committedAvatarEstUsd, 0.25);
    // Same clip on a resume: already counted, not added again.
    await generateClips(plan, { ...args, run: 3 });
    assert.equal(ledger.state.avatarClips.length, 1);
    // A different avatar clip would pass $10 cumulatively: refused.
    const b = parseBrief(avatarBrief({ captions: [], endCard: { enabled: false }, shots: [{ id: 'kd2', model: 'heygen_avatar', clip: 'b.mp4', duration: 3 }] }));
    await assert.rejects(generateClips(planBrief(b), { ...args, brief: b, run: 4 }), { code: 'CAP_EXCEEDED_VIDEO_CUMULATIVE' });
    const saved = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(saved.committedAvatarEstUsd, 0.25);
    assert.equal(saved.committedEstUsd, 9.95);
  } finally { await rm(dir, { recursive: true, force: true }); }
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

// QA M3: decode frames and check the AI label pixels, not the filter strings.
// In the label region there must be a solid plate (most pixels) and glyphs in
// the contrasting text colour, and the plate must extend past the last glyph
// on the right (the label is not clipped).
function labelRegion(file, t, { x, y, w, h }) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(r.stdout.length, w * h);
  return r.stdout;
}
// Classify the label band per column: a column is "label" when nearly every
// pixel is plate or glyph colour. The plate is the run of label columns from
// the label's left edge; inside it there must be glyph pixels and plate pixels.
export function labelStats(buf, w, h, theme) {
  const isText = theme === 'dark' ? v => v >= 170 : v => v <= 85;
  const isPlate = theme === 'dark' ? v => v <= 125 : v => v >= 190;
  let plateEnd = 0, miss = 0;
  for (let xx = 0; xx < w; xx++) {
    let ok = 0;
    for (let yy = 0; yy < h; yy++) { const v = buf[yy * w + xx]; if (isText(v) || isPlate(v)) ok++; }
    // Anti-aliased glyph edges are neither colour, so allow short gaps (< ~half an em).
    if (ok / h >= 0.7) { plateEnd = xx + 1; miss = 0; } else if (++miss > Math.max(4, Math.round(h * 0.6))) break;
  }
  let text = 0, plate = 0;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < plateEnd; xx++) { const v = buf[yy * w + xx]; if (isText(v)) text++; else if (isPlate(v)) plate++; }
  const area = Math.max(1, plateEnd * h);
  return { plateEnd, textFrac: text / area, plateFrac: plate / area };
}
function assertLabelVisible(file, { width, height, theme, times }) {
  const L = layout(width, height);
  const { size } = L.disclosure;
  const x = Math.round(width * L.disclosure.x), y = Math.round(height * L.disclosure.y);
  // Glyph rows of the label, from its left edge to well past its expected end.
  const region = { x, y: y + Math.round(size * 0.15), w: Math.min(width - x, Math.round(size * 0.8 * AI_DISCLOSURE_TEXT.length)), h: Math.round(size * 0.7) };
  const minWidth = Math.round(size * 0.4 * AI_DISCLOSURE_TEXT.length);
  for (const t of times) {
    const st = labelStats(labelRegion(file, t, region), region.w, region.h, theme);
    assert.ok(st.plateEnd >= minWidth, `t=${t}: label plate is ${st.plateEnd}px wide (>= ${minWidth})`);
    assert.ok(st.textFrac > 0.08 && st.textFrac < 0.65, `t=${t}: label glyph pixels ${st.textFrac.toFixed(3)}`);
    assert.ok(st.plateFrac > 0.3, `t=${t}: label plate pixels ${st.plateFrac.toFixed(3)}`);
  }
}

async function setup(dir, { logo }) {
  const assets = join(dir, 'assets');
  for (const sub of ['fonts', 'overlays']) await mkdir(join(assets, sub), { recursive: true });
  await copyFile(FONT_SRC, join(assets, 'fonts', 'lux-sans-bold.ttf'));
  if (logo) ff(['-f', 'lavfi', '-i', 'color=c=red:s=200x80', '-frames:v', '1', join(assets, 'overlays', 'logo.png')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4.5:sample_rate=48000', join(dir, 'voice.wav')]);
  // Portrait 720x1280-style avatar clip WITH its own audio (must be dropped).
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=25:duration=2.5', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2.5', '-shortest', '-pix_fmt', 'yuv420p', join(dir, 'avatar.mp4')]);
  await writeFile(join(dir, 'consent.json'), JSON.stringify(consentRecord()));
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
    assert.equal(receipt.heygenEstUsd, 0.25);
    assert.equal(receipt.avatarConsent.file, 'consent.json');
    assertLabelVisible(join(outDir, 'final.mp4'), { width: 1280, height: 720, theme: 'light', times: [0.1, 2.5, 4.9, 6.0, 6.9] });
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
    assertLabelVisible(join(dir, 'render', 'final.mp4'), { width: 1280, height: 720, theme: 'dark', times: [0.1, 1.0, 3.5, 4.9, 5.5, 6.9] });
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
    assert.equal(view.heygenEstUsd, 0.25);
    assert.ok(view.blockers.some(b => b.code === 'AVATAR_CONSENT_MISSING'), 'missing consent shows in the dry run');
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
