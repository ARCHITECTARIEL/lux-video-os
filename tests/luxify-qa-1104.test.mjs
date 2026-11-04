// QA-OVERLAYS-1104 follow-ups: N1 subtitle wrap, N2 card plate/outline and
// subtitle avoidance, L4/L5 asset containment, caps and font parsing, L6 bug
// windows under xfade, T1 frame tests for cards and the end card.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assText, buildCues, cardLayout, cardPlate, cardPlatePad, cardsAss, endCardGraph, layout, scaleCube, subtitleBox, subtitleMaxChars, subtitleTop, SUBTITLE_EM_WIDTH } from '../services/luxify-local-overlays.js';
import { titleFilters, CARD_FONT_FAMILY, MAX_LUT_BYTES, ffFilterPath, fontFamilyName, parseFontNameTable, renameFontFamily, resolveAssets, resolveFfmpeg, shotWindows, validateAssetFile, validateAssets } from '../services/luxify-local-pipeline.js';

const FIXTURE_FONT = fileURLToPath(new URL('./fixtures/fonts/ofl-test-bold.ttf', import.meta.url));
const LOGO = fileURLToPath(new URL('../brand-assets/overlays/lux-logo.png', import.meta.url));
let ffmpeg = null;
try { ffmpeg = resolveFfmpeg(undefined, process.env); } catch { ffmpeg = null; }
const skipFf = ffmpeg ? false : 'no ffmpeg with drawtext/ass';
const SCRIPT = 'Your firm already has the cases, the reviews and the reputation. We turn every line of your story into a cinematic spot your clients remember.';

// ---- N1 ----
test('N1: subtitle wrap width follows the frame (9:16 about 25 chars, 16:9 capped at 42)', () => {
  const portrait = subtitleMaxChars(1080, 1920), land = subtitleMaxChars(1920, 1080);
  assert.ok(portrait >= 20 && portrait <= 26, `9:16 maxChars ${portrait}`);
  assert.equal(land, 42);
  for (const [w, h] of [[1080, 1920], [1920, 1080], [1080, 1080]]) {
    const L = layout(w, h), box = subtitleBox('a', w, h);
    for (const c of buildCues(SCRIPT, 10, { maxChars: subtitleMaxChars(w, h) })) {
      for (const line of c.text.split('\n')) assert.ok(line.length * L.subtitleSize * SUBTITLE_EM_WIDTH <= box.w, `${w}x${h}: "${line}" overflows`);
    }
  }
});

// ---- N2 ----
test('N2: cards carry an outline, shadow and a dark plate behind the whole block', () => {
  const ass = cardsAss([{ start: 0, end: 2, text: 'every line counts' }], { width: 1920, height: 1080, fontName: 'X' });
  const card = ass.split('\n').find(l => l.startsWith('Style: Card')).split(',');
  assert.ok(Number(card[16]) >= 1 && Number(card[17]) >= 1, 'Card style has outline and shadow');
  const plate = ass.split('\n').filter(l => l.includes(',Plate,'));
  assert.equal(plate.length, 1);
  assert.match(plate[0], /\\p1\}m 0 0 l \d+ 0 \d+ \d+ 0 \d+\{\\p0\}/);
  assert.match(ass, /\\bord\d+/);
});

test('N2: with subtitles burned in, the card block and plate end above the subtitle plate (16:9 and 9:16)', () => {
  for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
    const avoid = subtitleTop(w, h) - 20;
    for (const text of ['every line', 'your story, cinematic', 'reputation']) {
      const rows = cardLayout(text, w, h, { avoidBottom: avoid });
      const p = cardPlate(rows, w);
      assert.ok(p.y + p.h <= avoid, `${w}x${h} "${text}": plate bottom ${p.y + p.h} > ${avoid}`);
      assert.ok(p.y >= 0);
    }
  }
  // Without subtitles the 16:9 block is still centred at mid-frame.
  const free = cardLayout('every line', 1920, 1080);
  assert.ok(free[free.length - 1].y + free[free.length - 1].h > subtitleTop(1920, 1080) - 300);
});

test('mutant: cardsAss sanitises caption text through assText', () => {
  const ass = cardsAss([{ start: 0, end: 1, text: '{\\pos(0,0)}evil' }], { width: 1920, height: 1080, fontName: 'X' });
  assert.ok(!/\}\{?\\POS|\{\\POS/.test(ass) && ass.includes('POS(0,0)EVIL'));
  assert.equal(assText('{a}\\b'), 'ab');
});

// ---- L5 ----
test('L5: scaleCube rejects LUT_3D_SIZE below 2', () => {
  for (const n of [0, 1]) assert.throws(() => scaleCube(`LUT_3D_SIZE ${n}\n0 0 0\n`, 1.5), { code: 'LUT_INVALID' });
});

test('L5: malformed fonts give FONT_INVALID, never RangeError', async () => {
  const good = await readFile(FIXTURE_FONT);
  const bad = [Buffer.alloc(0), Buffer.from([0, 1, 0]), good.subarray(0, 40), good.subarray(0, Math.floor(good.length / 2)), Buffer.from('not a font at all, just text....')];
  // A name entry whose offset points past the end.
  const lying = Buffer.from(good);
  const { entry } = parseFontNameTable(good);
  lying.writeUInt32BE(good.length + 100, entry + 8);
  bad.push(lying);
  for (const b of bad) {
    assert.throws(() => renameFontFamily(b, CARD_FONT_FAMILY), { code: 'FONT_INVALID' });
    assert.throws(() => parseFontNameTable(b), { code: 'FONT_INVALID' });
  }
  const dir = await mkdtemp(join(tmpdir(), 'qa1104-font-'));
  await writeFile(join(dir, 'z.ttf'), Buffer.alloc(3));
  await assert.rejects(fontFamilyName(join(dir, 'z.ttf')), { code: 'FONT_INVALID' });
  assert.equal(await fontFamilyName(FIXTURE_FONT), 'Montserrat');
});

// ---- L4 ----
test('L4: LUT, font and music must sit inside the roots; symlinks out, oversize and non-files are refused', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qa1104-assets-'));
  const root = join(base, 'root');
  for (const d of ['luts', 'fonts', 'music']) await mkdir(join(root, d), { recursive: true });
  await writeFile(join(base, 'outside.cube'), 'LUT_3D_SIZE 2\n');
  await symlink(join(base, 'outside.cube'), join(root, 'luts', 'evil.cube'));
  await assert.rejects(validateAssetFile('lut', join(root, 'luts', 'evil.cube'), [root]), { code: 'LUT_OUTSIDE_ROOTS' });
  await writeFile(join(root, 'luts', 'big.cube'), '');
  await truncate(join(root, 'luts', 'big.cube'), MAX_LUT_BYTES + 1);
  await assert.rejects(validateAssetFile('lut', join(root, 'luts', 'big.cube'), [root]), { code: 'LUT_INVALID' });
  await mkdir(join(root, 'luts', 'dir.cube'));
  await assert.rejects(validateAssetFile('lut', join(root, 'luts', 'dir.cube'), [root]), { code: 'LUT_INVALID' });
  await writeFile(join(root, 'fonts', 'broken.ttf'), Buffer.alloc(3));
  await assert.rejects(validateAssetFile('font', join(root, 'fonts', 'broken.ttf'), [root]), { code: 'FONT_INVALID' });
  await writeFile(join(base, 'song.mp3'), 'x');
  await symlink(join(base, 'song.mp3'), join(root, 'music', 'bed.mp3'));
  await assert.rejects(validateAssetFile('music', join(root, 'music', 'bed.mp3'), [root]), { code: 'MUSIC_OUTSIDE_ROOTS' });
  // A file in the wrong sub-folder is outside too.
  await writeFile(join(root, 'fonts', 'x.cube'), 'LUT_3D_SIZE 2\n');
  await assert.rejects(validateAssetFile('lut', join(root, 'fonts', 'x.cube'), [root]), { code: 'LUT_OUTSIDE_ROOTS' });
  // Good files pass; missing files are left to missingAssets.
  await writeFile(join(root, 'luts', 'ok.cube'), 'LUT_3D_SIZE 2\n');
  await writeFile(join(root, 'fonts', 'ok.ttf'), await readFile(FIXTURE_FONT));
  assert.ok(await validateAssetFile('lut', join(root, 'luts', 'ok.cube'), [root]));
  assert.ok(await validateAssetFile('font', join(root, 'fonts', 'ok.ttf'), [root]));
  assert.equal(await validateAssetFile('lut', join(root, 'luts', 'none.cube'), [root]), null);
  await validateAssets({ root, roots: [root], lut: join(root, 'luts', 'ok.cube'), font: join(root, 'fonts', 'ok.ttf'), music: null });
});

test('mutant: resolveAssets prefers the primary root over a fallback holding the same file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'qa1104-order-'));
  for (const r of ['a', 'b']) { await mkdir(join(base, r, 'luts'), { recursive: true }); await writeFile(join(base, r, 'luts', 'x.cube'), r); }
  const a = resolveAssets({ fontPreset: 'lux-sans', lut: 'x.cube', voice: { path: 'v.wav' } }, join(base, 'a'), base, { fallbackRoots: [join(base, 'b')] });
  assert.equal(a.lut, join(base, 'a', 'luts', 'x.cube'));
});

// ---- L6 ----
test('L6: shot windows account for xfade overlap and swap at the crossfade midpoint', () => {
  assert.deepEqual(shotWindows([4, 5, 6], []), [{ start: 0, end: 4 }, { start: 4, end: 9 }, { start: 9, end: 15 }]);
  const w = shotWindows([4, 5, 6], [{ type: 'fade', duration: 1 }, { type: 'fade', duration: 0.5 }]);
  assert.deepEqual(w, [{ start: 0, end: 3.5 }, { start: 3.5, end: 7.75 }, { start: 7.75, end: 13.5 }]);
  assert.equal(w[2].end, 4 + 5 + 6 - 1 - 0.5, 'last window ends at the xfade timeline length');
});

// ---- T1 frame tests ----
function grayFrame(file, t, w, h) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(r.stdout.length, w * h);
  return r.stdout;
}
const mean = (px, w, x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += px[y * w + x]; n += 1; } return s / n; };
function render(args) { const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); }

test('T1 frame: cards on white footage get a dark plate, white outlined text, and stay clear of the 16:9 subtitle band', { skip: skipFf, timeout: 60000 }, async () => {
  const W = 1280, H = 720;
  const dir = await mkdtemp(join(tmpdir(), 'qa1104-cards-'));
  const fonts = join(dir, 'fonts'); await mkdir(fonts);
  await writeFile(join(fonts, 'c.ttf'), renameFontFamily(await readFile(FIXTURE_FONT), CARD_FONT_FAMILY));
  const avoid = subtitleTop(W, H) - 14;
  await writeFile(join(dir, 'c.ass'), cardsAss([{ start: 0, end: 3, text: 'every line counts' }], { width: W, height: H, fontName: CARD_FONT_FAMILY, avoidBottom: avoid }));
  const out = join(dir, 'c.mp4');
  render(['-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}:r=30:d=3`, '-vf', `ass=filename=${ffFilterPath(join(dir, 'c.ass'))}:fontsdir=${ffFilterPath(fonts)}:shaping=simple`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  const px = grayFrame(out, 1.5, W, H);
  const rows = cardLayout('every line counts', W, H, { avoidBottom: avoid });
  const p = cardPlate(rows, W);
  const plateMean = mean(px, W, p.x + 4, p.y + 4, p.x + p.w - 4, p.y + p.h - 4);
  assert.ok(plateMean < 170, `plate region should be darkened on white footage (mean ${plateMean.toFixed(1)})`);
  // White glyph pixels exist inside the plate (text readable against it).
  let bright = 0; for (let y = p.y; y < p.y + p.h; y += 1) for (let x = p.x; x < p.x + p.w; x += 1) if (px[y * W + x] > 235) bright += 1;
  assert.ok(bright > 500, `text pixels on the plate: ${bright}`);
  // Nothing drawn in the subtitle band.
  const band = mean(px, W, 0, subtitleTop(W, H), W, H);
  assert.ok(band > 250, `subtitle band untouched (mean ${band.toFixed(1)})`);
  assert.ok(p.x >= 0 && p.y >= cardPlatePad(rows[0].size) - p.y - 1);
});

test('T1 frame: 9:16 burned-in subtitles stay inside the frame (no glyphs at the edges)', { skip: skipFf, timeout: 60000 }, async () => {
  const W = 540, H = 960;
  const dir = await mkdtemp(join(tmpdir(), 'qa1104-subs-'));
  const cue = buildCues(SCRIPT, 4, { maxChars: subtitleMaxChars(W, H) }).reduce((a, c) => (c.text.length > a.text.length ? c : a));
  await writeFile(join(dir, 's.txt'), cue.text);
  const L = layout(W, H), b = subtitleBox(cue.text, W, H);
  const out = join(dir, 's.mp4');
  render(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=1`, '-vf', `drawtext=fontfile=${ffFilterPath(FIXTURE_FONT)}:expansion=none:textfile=${ffFilterPath(join(dir, 's.txt'))}:fontcolor=white:fontsize=${L.subtitleSize}:line_spacing=${Math.round(L.subtitleSize * 0.25)}:x=(w-text_w)/2:y=${b.y}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  const px = grayFrame(out, 0.5, W, H);
  const edge = Math.round(W * 0.06);
  assert.ok(mean(px, W, 0, b.y, edge, b.y + b.h) < 8 && mean(px, W, W - edge, b.y, W, b.y + b.h) < 8, 'no subtitle glyphs in the outer 6% of the frame');
  assert.ok(mean(px, W, edge, b.y, W - edge, b.y + b.h) > 10, 'subtitle text was drawn');
});

test('T1 frame: end card shows the logo at 0.40 H and the CTA pill at 0.60 H', { skip: skipFf, timeout: 60000 }, async () => {
  const W = 1280, H = 720;
  const dir = await mkdtemp(join(tmpdir(), 'qa1104-end-'));
  await writeFile(join(dir, 'cta.txt'), 'BOOK A CALL');
  const g = endCardGraph({ width: W, height: H, duration: 2, theme: 'dark', logoLabel: '[0:v]', ctaFile: join(dir, 'cta.txt'), urlFile: null, font: FIXTURE_FONT, esc: ffFilterPath, outLabel: '[v]' });
  const out = join(dir, 'e.mp4');
  render(['-loop', '1', '-framerate', '30', '-i', LOGO, '-filter_complex', g, '-map', '[v]', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  const px = grayFrame(out, 1.5, W, H);
  const bg = mean(px, W, 0, 0, Math.round(W * 0.1), Math.round(H * 0.1));
  let logo = 0; for (let y = Math.round(H * 0.30); y < Math.round(H * 0.50); y += 1) for (let x = Math.round(W * 0.3); x < Math.round(W * 0.7); x += 1) if (Math.abs(px[y * W + x] - bg) > 40) logo += 1;
  const cta = mean(px, W, Math.round(W * 0.42), Math.round(H * 0.62), Math.round(W * 0.58), Math.round(H * 0.66));
  assert.ok(bg < 40, `navy background (${bg.toFixed(1)})`);
  assert.ok(logo > 800, `logo pixels around 0.40 H: ${logo}`);
  assert.ok(cta > 150, `white CTA pill at 0.60 H (${cta.toFixed(1)})`);
});

test('v3c: with burned-in subtitles the lower-third plate ends above the subtitle plate', () => {
  const shot = { titles: [{ kind: 'lower_third', text: 'Name', subtext: 'Role', start: 0, end: 3 }] };
  const files = { '0-main': '/a.txt', '0-sub': '/b.txt' };
  for (const [w, h] of [[1080, 1920], [1920, 1080]]) {
    const avoid = subtitleTop(w, h) - 20;
    const box = titleFilters(shot, '/f.ttf', w, h, files, 'dark', { avoidBottom: avoid }).find(f => f.startsWith('drawbox'));
    const [, y, ph] = box.match(/y=ih\*([\d.]+):w=iw\*0\.6:h=(\d+)/);
    assert.ok(Number(y) * h + Number(ph) <= avoid + 1, `${w}x${h}`);
  }
  const free = titleFilters(shot, '/f.ttf', 1080, 1920, files).find(f => f.startsWith('drawbox'));
  assert.match(free, /y=ih\*0\.67:/);
});
