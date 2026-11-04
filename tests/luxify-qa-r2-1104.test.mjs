// QA-OVERLAYS-1104 r2: N3 cards vs lower thirds, T1 surviving mutants,
// resolved asset paths, music type check.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseBrief } from '../lib/luxify-local-brief.js';
import { cardAvoidBottom, cardsAss, scaleCube, subtitleMaxChars, subtitleTop } from '../services/luxify-local-overlays.js';
import { LOCK_FILE, isAudioHeader, lowerThirdTop, lowerThirdWindows, parseFontNameTable, planBrief, renameFontFamily, resolveAssets, runPipeline, subtitleCues, titleFilters, validateAssetFile, validateAssets, validateLogo } from '../services/luxify-local-pipeline.js';

const FONT = readFileSync(new URL('./fixtures/fonts/ofl-test-bold.ttf', import.meta.url));
const SCRIPT = 'No camera. No studio... Meet LUX Video OS. Enroll your presenter once, with recorded consent. Then write. Our built-in AI copywriter helps you shape every line. Hit render and step away.';

function platesOf(ass) {
  return ass.split('\n').filter(l => l.includes(',Plate,')).map(l => {
    const [, x, y] = l.match(/\\pos\((\d+),(\d+)\)/);
    const [, w, h] = l.match(/m 0 0 l (\d+) 0 \d+ (\d+)/);
    return { x: +x, y: +y, w: +w, h: +h };
  });
}

// ---- N3 ----
test('N3: 12 cases (3 aspects x subtitles on/off x 2 texts): a card shown with a lower third ends above it and above the subtitles', () => {
  let cases = 0;
  for (const [w, h] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
    for (const subsOn of [true, false]) {
      for (const text of ['every line', 'your story, cinematic and private']) {
        const gap = Math.round(Math.min(w, h) * 0.02);
        const subAvoid = subsOn ? subtitleTop(w, h) - gap : null;
        const lt = { kind: 'lower_third', text: 'Name', subtext: 'Role', start: 0.6, end: 4.4 };
        const lowerThirds = lowerThirdWindows([{ titles: [lt] }, { titles: [] }], [5, 6], [], w, h, subAvoid);
        // The lower-third top we avoid is exactly where titleFilters draws the plate.
        const box = titleFilters({ titles: [lt] }, '/f.ttf', w, h, { '0-main': '/a', '0-sub': '/b' }, 'dark', { avoidBottom: subAvoid }).find(f => f.startsWith('drawbox'));
        assert.equal(lowerThirds[0].top, Math.floor(Number(box.match(/y=ih\*([\d.]+)/)[1]) * h));
        const ass = cardsAss([{ start: 3.5, end: 5.5, text }, { start: 7, end: 9, text }], { width: w, height: h, fontName: 'X', avoidBottom: subAvoid, lowerThirds });
        const [during, after] = platesOf(ass);
        const label = `${w}x${h} subs=${subsOn} "${text}"`;
        assert.ok(during.y + during.h <= lowerThirds[0].top - gap, `${label}: plate bottom ${during.y + during.h} vs lower third ${lowerThirds[0].top}`);
        if (subAvoid != null) assert.ok(during.y + during.h <= subAvoid && after.y + after.h <= subAvoid, `${label}: above subtitles`);
        assert.ok(during.y >= 0, `${label}: inside frame`);
        // A card after the lower third ends is not pushed up by it.
        const [alone] = platesOf(cardsAss([{ start: 7, end: 9, text }], { width: w, height: h, fontName: 'X', avoidBottom: subAvoid }));
        assert.deepEqual(after, alone, `${label}: later card unaffected`);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 12);
});

test('N3: cardAvoidBottom takes the higher (smaller y) of subtitles and every overlapping lower third', () => {
  const lts = [{ start: 0, end: 2, top: 700 }, { start: 5, end: 6, top: 500 }];
  assert.equal(cardAvoidBottom({ start: 1, end: 3 }, { avoidBottom: 900, lowerThirds: lts, gap: 10 }), 690);
  assert.equal(cardAvoidBottom({ start: 1, end: 3 }, { avoidBottom: 600, lowerThirds: lts, gap: 10 }), 600);
  assert.equal(cardAvoidBottom({ start: 2, end: 5 }, { avoidBottom: null, lowerThirds: lts }), null, 'touching windows do not overlap');
  assert.equal(cardAvoidBottom({ start: 1, end: 5.5 }, { lowerThirds: lts }), 500);
});

test('N3: lower-third windows follow xfade clip starts', () => {
  const lt = t => ({ titles: [{ kind: 'lower_third', text: 'a', start: t, end: t + 1 }] });
  const w = lowerThirdWindows([lt(0.5), lt(0.2), { titles: [{ kind: 'banner', text: 'b', start: 0, end: 1 }] }], [4, 5, 6], [{ type: 'fade', duration: 1 }, { type: 'fade', duration: 0.5 }], 1920, 1080);
  assert.deepEqual(w.map(x => [x.start, x.end]), [[0.5, 1.5], [3.2, 4.2]]);
  assert.equal(w[0].top, lowerThirdTop({}, 1920, 1080));
});

// ---- T1: font bounds (each check on its own) ----
test('T1: each font bounds check rejects its own malformed case with FONT_INVALID', () => {
  const { entry } = parseFontNameTable(FONT);
  const off = FONT.readUInt32BE(entry + 8), size = FONT.readUInt32BE(entry + 12);
  const edit = fn => { const b = Buffer.from(FONT); fn(b); return b; };
  const cases = {
    'bad tag': edit(b => b.writeUInt32BE(0x12345678, 0)),
    'zero tables': edit(b => b.writeUInt16BE(0, 4)),
    'table dir past end': edit(b => b.writeUInt16BE(0xffff, 4)),
    'no name table': edit(b => b.write('nome', entry, 'latin1')),
    'name offset past end': edit(b => b.writeUInt32BE(b.length - 2, entry + 8)),
    'name size < 6': edit(b => b.writeUInt32BE(4, entry + 12)),
    'name size past end': edit(b => b.writeUInt32BE(b.length, entry + 12)),
    'record count past table': edit(b => b.writeUInt16BE(0xffff, off + 2)),
    'string storage past table': edit(b => b.writeUInt16BE(size + 1, off + 4)),
    'string past table': edit(b => b.writeUInt16BE(0xffff, off + 6 + 10)),
  };
  // The record-directory checks must fire themselves, not a later check.
  assert.throws(() => parseFontNameTable(cases['record count past table']), /name records out of range/);
  assert.throws(() => parseFontNameTable(cases['string storage past table']), /name records out of range/);
  assert.throws(() => parseFontNameTable(cases['string past table']), /name string out of range/);
  assert.throws(() => parseFontNameTable(cases['name size past end']), /name table out of range/);
  assert.throws(() => parseFontNameTable(cases['table dir past end']), /table directory out of range/);
  for (const [name, buf] of Object.entries(cases)) {
    assert.throws(() => parseFontNameTable(buf), e => e.code === 'FONT_INVALID' || assert.fail(`${name}: ${e.name} ${e.code}`), name);
    assert.throws(() => renameFontFamily(buf, 'LuxCardBold'), { code: 'FONT_INVALID' }, name);
  }
});

// ---- T1: 9:16 subtitle line length through the pipeline helper ----
test('T1: pipeline subtitle cues wrap to the 9:16 frame width, not the 42-char landscape cap', () => {
  const max = subtitleMaxChars(1080, 1920);
  assert.ok(max < 30);
  const lines = subtitleCues(SCRIPT, 20, 1080, 1920).flatMap(c => c.text.split('\n'));
  assert.ok(lines.every(l => l.length <= max), `longest ${Math.max(...lines.map(l => l.length))} > ${max}`);
  const wide = subtitleCues(SCRIPT, 20, 1920, 1080).flatMap(c => c.text.split('\n'));
  assert.ok(Math.max(...wide.map(l => l.length)) > max, 'landscape uses the wider limit');
});

// ---- T1: the pipeline's up-front asset check ----
function brief(over = {}) {
  return parseBrief({
    version: 'luxify-local/v1', slug: 'r2-unit', title: 'r2', aspect: '16:9', script: 'Hello there.',
    shots: [{ id: 'r', model: 'local_clip', clip: 'r.mp4', duration: 2, titles: [] }], transitions: [],
    fontPreset: 'lux-sans-bold', lut: 'grade.cube', music: null, logoOverlay: null,
    voice: { source: 'heygen_audio_file', path: 'voice.wav' }, theme: 'dark', captionStyle: 'none', captions: [],
    endCard: { enabled: false }, ...over,
  });
}
async function scaffold() {
  const dir = await mkdtemp(join(tmpdir(), 'qa-r2-'));
  const assets = join(dir, 'assets');
  for (const sub of ['fonts', 'luts', 'music', 'overlays']) await mkdir(join(assets, sub), { recursive: true });
  await writeFile(join(assets, 'fonts', 'lux-sans-bold.ttf'), FONT);
  await writeFile(join(dir, 'voice.wav'), 'x');
  await writeFile(join(dir, 'r.mp4'), 'x');
  return { dir, assets };
}

test('T1: runPipeline refuses an out-of-root LUT before the lock (validateAssets is called up front)', async () => {
  const { dir, assets } = await scaffold();
  try {
    await writeFile(join(dir, 'elsewhere.cube'), 'LUT_3D_SIZE 2\n');
    await symlink(join(dir, 'elsewhere.cube'), join(assets, 'luts', 'grade.cube'));
    const b = brief();
    const outDir = join(dir, 'render');
    await assert.rejects(runPipeline({ brief: b, briefDir: dir, plan: planBrief(b), outDir, assets: resolveAssets(b, assets, dir), ffmpeg: '/nonexistent/ffmpeg', runwayEnv: {}, runwayDeps: {} }), { code: 'LUT_OUTSIDE_ROOTS' });
    assert.ok(!existsSync(join(outDir, LOCK_FILE)));
    // Music that is not audio is refused the same way.
    await rm(join(assets, 'luts', 'grade.cube'));
    await writeFile(join(assets, 'music', 'bed.mp3'), 'this is not audio at all');
    const m = brief({ lut: null, music: { track: 'bed.mp3', volume: 0.2 } });
    await assert.rejects(runPipeline({ brief: m, briefDir: dir, plan: planBrief(m), outDir, assets: resolveAssets(m, assets, dir), ffmpeg: '/nonexistent/ffmpeg', runwayEnv: {}, runwayDeps: {} }), { code: 'MUSIC_INVALID' });
    assert.ok(!existsSync(join(outDir, LOCK_FILE)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Minor: validateAssets returns resolved realpaths for the files it checked', async () => {
  const { dir, assets } = await scaffold();
  try {
    await writeFile(join(assets, 'luts', 'real.cube'), 'LUT_3D_SIZE 2\n');
    await symlink(join(assets, 'luts', 'real.cube'), join(assets, 'luts', 'alias.cube'));
    const out = await validateAssets({ root: assets, roots: [assets], lut: join(assets, 'luts', 'alias.cube'), font: join(assets, 'fonts', 'lux-sans-bold.ttf'), music: null, voice: 'v' });
    assert.equal(out.lut, await realpath(join(assets, 'luts', 'real.cube')));
    assert.equal(out.font, await realpath(join(assets, 'fonts', 'lux-sans-bold.ttf')));
    assert.equal(out.music, null);
    assert.equal(out.voice, 'v', 'other keys pass through');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Minor: music magic bytes (WAV, MP3, M4A, FLAC, Ogg accepted; text and PNG refused)', async () => {
  const pad = s => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(16)]).subarray(0, 16);
  for (const ok of [pad('RIFF\0\0\0\0WAVE'), pad('ID3\x04'), Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]), pad('\0\0\0\x20ftypM4A '), pad('fLaC'), pad('OggS')]) assert.ok(isAudioHeader(ok), ok.toString('hex'));
  for (const bad of [pad('hello world!'), pad('\x89PNG\r\n\x1a\n'), pad('RIFF\0\0\0\0AVI '), Buffer.from('ID3')]) assert.ok(!isAudioHeader(bad), bad.toString('hex'));
  const { dir, assets } = await scaffold();
  try {
    await writeFile(join(assets, 'music', 'ok.wav'), pad('RIFF\0\0\0\0WAVE'));
    assert.ok(await validateAssetFile('music', join(assets, 'music', 'ok.wav'), [assets]));
    await writeFile(join(assets, 'music', 'short.wav'), 'RIFF');
    await assert.rejects(validateAssetFile('music', join(assets, 'music', 'short.wav'), [assets]), { code: 'MUSIC_INVALID' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- r1 survivors that are cheap to pin ----
test('T1: lutStrength below 0 is refused by the brief and by scaleCube', () => {
  assert.throws(() => brief({ lutStrength: -0.1 }));
  assert.throws(() => scaleCube('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n', -0.1));
});

test('T1: a logo without PNG magic is refused even with an IHDR-like body', async () => {
  const { dir, assets } = await scaffold();
  try {
    const fake = Buffer.alloc(24); fake.write('IHDR', 12, 'latin1'); fake.writeUInt32BE(10, 16); fake.writeUInt32BE(10, 20);
    await writeFile(join(assets, 'overlays', 'x.png'), fake);
    await assert.rejects(validateLogo(join(assets, 'overlays', 'x.png'), assets), { code: 'LOGO_INVALID' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
