import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const ev = ass.split('\n').filter(l => l.startsWith('Dialogue'));
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
  const path = process.env.LUX_TEST_FONT || '/workspace/lux-assets/fonts/lux-sans-bold.ttf';
  let buf; try { buf = await readFile(path); } catch { return; } // asset pack not present
  assert.equal(await fontFamilyName(path), 'Montserrat');
  const dir = await mkdtemp(join(tmpdir(), 'card-font-'));
  const out = join(dir, 'f.ttf');
  await writeFile(out, renameFontFamily(buf, CARD_FONT_FAMILY));
  assert.equal(await fontFamilyName(out), CARD_FONT_FAMILY);
  assert.ok((await readFile(out)).subarray(0, 12).equals(buf.subarray(0, 12)));
  assert.throws(() => renameFontFamily(buf, 'bad name'), { code: 'FONT_INVALID' });
});
