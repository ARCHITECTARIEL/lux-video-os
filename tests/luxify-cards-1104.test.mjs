import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseBrief, CAPTION_STYLES } from '../lib/luxify-local-brief.js';
import { BRAND_BLUE, assText, cardLayout, cardLines, cardsAss, scaleCube } from '../services/luxify-local-overlays.js';
import { CARD_FONT_FAMILY, fontFamilyName, renameFontFamily, resolveAssets } from '../services/luxify-local-pipeline.js';

const ID2 = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
const cube = rows => `TITLE "t"\nLUT_3D_SIZE 2\n${rows.map(r => r.join(' ')).join('\n')}\n`;

test('scaleCube: identity stays identity at any strength', () => {
  for (const s of [0, 1, 1.8, 3]) assert.equal(scaleCube(ID2, s).split('\n').slice(1, 9).map(l => l.split(' ').map(Number).join(',')).join('|'), '0,0,0|1,0,0|0,1,0|1,1,0|0,0,1|1,0,1|0,1,1|1,1,1');
});

test('scaleCube: strength scales the offset from identity and clamps', () => {
  const lut = cube([[0.1, 0, 0], [0.9, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]);
  const rows = s => scaleCube(lut, s).split('\n').filter(l => /^[\d.]+ [\d.]+ [\d.]+$/.test(l)).map(l => l.split(' ').map(Number));
  assert.deepEqual(rows(2)[0], [0.2, 0, 0]);
  assert.deepEqual(rows(2)[1], [0.8, 0, 0]);
  assert.deepEqual(rows(0)[0], [0, 0, 0]);
  assert.deepEqual(rows(20 / 10 * 1.5)[0], [0.3, 0, 0]);
  assert.match(scaleCube(lut, 2), /^TITLE "t"\nLUT_3D_SIZE 2\n/);
});

test('scaleCube rejects bad input', () => {
  assert.throws(() => scaleCube(ID2, 4), { code: 'LUT_STRENGTH_INVALID' });
  assert.throws(() => scaleCube('0 0 0\n', 1), { code: 'LUT_INVALID' });
  assert.throws(() => scaleCube('LUT_3D_SIZE 2\n0 0 0\n', 1), { code: 'LUT_INVALID' });
});

test('brief: cards style and lutStrength are accepted, default strength 1', () => {
  assert.ok(CAPTION_STYLES.includes('cards'));
  const base = { version: 'luxify-local/v1', slug: 'x', title: 'x', aspect: '9:16', script: 'Hi.', shots: [{ id: 'a', model: 'local_clip', clip: 'a.mp4', duration: 5, titles: [] }], fontPreset: 'lux-sans', voice: { source: 'heygen_audio_file', path: 'v.wav' } };
  assert.equal(parseBrief(base).lutStrength, 1);
  assert.equal(parseBrief({ ...base, lut: 'lux-cinematic.cube', lutStrength: 1.8, captionStyle: 'cards' }).lutStrength, 1.8);
  assert.throws(() => parseBrief({ ...base, lutStrength: 5 }));
});

test('cards always use lux-sans-bold regardless of fontPreset', () => {
  const a = resolveAssets({ fontPreset: 'lux-serif', captionStyle: 'cards', voice: { path: 'v.wav' } }, '/assets', '/b');
  assert.match(a.cardFont, /fonts[\\/]lux-sans-bold\.ttf$/);
  assert.equal(resolveAssets({ fontPreset: 'lux-serif', captionStyle: 'kinetic', voice: { path: 'v.wav' } }, '/assets', '/b').cardFont, undefined);
});

test('cardLines: stacked uppercase punch lines, max 3', () => {
  assert.deepEqual(cardLines('No studio.'), ['NO', 'STUDIO.']);
  assert.deepEqual(cardLines('Every line, sharpened.'), ['EVERY', 'LINE,', 'SHARPENED.']);
  assert.equal(cardLines('one two three four five six').length, 3);
});

test('cardLayout: mid-frame, left-aligned, inside the frame, never in the bottom subtitle band', () => {
  for (const onAvatar of [true, false]) {
    for (const t of ['Private.', 'Every line, sharpened.', 'Hit render.']) {
      const rows = cardLayout(t, 720, 1280, { onAvatar });
      assert.equal(new Set(rows.map(r => r.size)).size, 1, 'one size per card');
      for (const r of rows) {
        assert.ok(r.y > 1280 * 0.33, `${t} below the face zone`);
        assert.ok(r.y + r.h < 1280 * 0.67, `${t} above lower third / label / subtitle band`);
        assert.ok(r.x + r.size * 0.8 * r.text.length <= 720 * 0.92, `${t} fits width`);
      }
      assert.equal(rows.filter(r => r.keyword).length, 1);
      assert.ok(rows.at(-1).keyword);
    }
  }
});

test('cardsAss: brand blue bar, pop and slide entrances, no bottom-centred lines', () => {
  const ass = cardsAss([{ text: 'No camera.', start: 0, end: 1 }, { text: 'Hit render.', start: 2, end: 3 }], { width: 720, height: 1280, fontName: 'LuxCardBold', avatarWindows: [{ start: 0, end: 1.5 }] });
  assert.match(ass, /PlayResX: 720\nPlayResY: 1280/);
  assert.match(ass, /Style: Key,LuxCardBold,.*,&H009E2B1A,.*,-1,0,0,0,100,100,0,0,3,/);
  assert.equal(BRAND_BLUE, '1A2B9E');
  const ev = ass.split('\n').filter(l => l.startsWith('Dialogue') && !l.includes(',Plate,'));
  assert.equal(ass.split('\n').filter(l => l.includes(',Plate,')).length, 2, 'one plate per card');
  assert.equal(ev.length, 4);
  assert.ok(ev.some(l => /\\fscx40\\fscy40/.test(l)), 'pop');
  assert.ok(ev.some(l => /\\move\(/.test(l)), 'slide');
  assert.ok(ev.filter(l => l.includes(',Key,')).every(l => /\\fscx0/.test(l)), 'bar sweeps in');
  assert.ok(ev.every(l => /\\an7/.test(l)) && !ev.some(l => /\\an2/.test(l)));
});

test('assText strips ASS override syntax from user text', () => {
  assert.equal(assText('A{\\b0}B\\NC'), 'Ab0BNC');
  assert.equal(assText('x\ny'), 'xy');
});

test('renameFontFamily gives the brand file a unique libass name; glyph bytes kept', async () => {
  // QA T1: committed OFL fixture (Montserrat Bold subset), never skipped.
  const path = fileURLToPath(new URL('./fixtures/fonts/ofl-test-bold.ttf', import.meta.url));
  const buf = await readFile(path);
  assert.equal(await fontFamilyName(path), 'Montserrat');
  const dir = await mkdtemp(join(tmpdir(), 'card-font-'));
  const out = join(dir, 'f.ttf');
  await writeFile(out, renameFontFamily(buf, CARD_FONT_FAMILY));
  assert.equal(await fontFamilyName(out), CARD_FONT_FAMILY);
  assert.ok((await readFile(out)).subarray(0, 12).equals(buf.subarray(0, 12)));
  assert.throws(() => renameFontFamily(buf, 'bad name'), { code: 'FONT_INVALID' });
});

test('brand-assets: tracked pack resolves first, falls back per file to the PC folder', async () => {
  const { REPO_ASSETS_ROOT } = await import('../services/luxify-local-pipeline.js');
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(join(REPO_ASSETS_ROOT, 'luts', 'lux-cinematic.cube')));
  assert.ok(existsSync(join(REPO_ASSETS_ROOT, 'overlays', 'lux-logo.png')));
  assert.ok(existsSync(join(REPO_ASSETS_ROOT, 'overlays', 'lux-logo-dark.png')));
  const fb = await mkdtemp(join(tmpdir(), 'pc-assets-'));
  const brief = { fontPreset: 'lux-sans-bold', lut: 'lux-cinematic.cube', logoOverlay: 'lux-logo.png', logoOverlayDark: 'lux-logo-dark.png', captionStyle: 'cards', music: { track: 'bed.mp3' }, voice: { path: 'v.wav' } };
  const a = resolveAssets(brief, REPO_ASSETS_ROOT, '/b', { fallbackRoots: [fb] });
  assert.equal(a.lut, join(REPO_ASSETS_ROOT, 'luts', 'lux-cinematic.cube'));
  assert.equal(a.logoDark, join(REPO_ASSETS_ROOT, 'overlays', 'lux-logo-dark.png'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(fb, 'music'), { recursive: true }); await writeFile(join(fb, 'music', 'bed.mp3'), 'x');
  const b = resolveAssets(brief, REPO_ASSETS_ROOT, '/b', { fallbackRoots: [fb] });
  assert.equal(b.music, join(fb, 'music', 'bed.mp3'));
  assert.deepEqual(b.roots, [REPO_ASSETS_ROOT, fb]);
});

test('bugFilter with tone windows enables the bug only inside them', async () => {
  const { bugFilter } = await import('../services/luxify-local-overlays.js');
  const f = bugFilter({ logoLabel: '[l]', videoLabel: '[v]', outLabel: '[o]', width: 720, height: 1280, opacity: 0.85, until: 33, windows: [{ start: 0, end: 5 }, { start: 29, end: 35 }] });
  assert.match(f, /enable='between\(t,0,5\)\+between\(t,29,33\)'/);
  assert.match(bugFilter({ logoLabel: '[l]', videoLabel: '[v]', outLabel: '[o]', width: 720, height: 1280, opacity: 1, until: 33, windows: [] }), /enable='0'/);
});

test('brief accepts logoOverlayDark and per-shot tone', () => {
  const base = { version: 'luxify-local/v1', slug: 'x', title: 'x', aspect: '9:16', script: 'Hi.', shots: [{ id: 'a', model: 'local_clip', clip: 'a.mp4', duration: 5, tone: 'light', titles: [] }], fontPreset: 'lux-sans', voice: { source: 'heygen_audio_file', path: 'v.wav' }, logoOverlay: 'lux-logo.png', logoOverlayDark: 'lux-logo-dark.png' };
  const b = parseBrief(base);
  assert.equal(b.shots[0].tone, 'light');
  assert.throws(() => parseBrief({ ...base, shots: [{ ...base.shots[0], tone: 'grey' }] }));
});
